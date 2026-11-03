import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { CandidateDTO } from '@clipmaster/shared';
import { checkInternal, extractToken } from '../src/auth/auth.guard';
import { sanitizeStyle } from '../src/clips/clips.service';
import { signMedia, verifyMedia } from '../src/common/signing';
import { buildKey, keyBelongsTo, prefixFor } from '../src/common/storage.service';
import { loadEnv, setEnvForTests } from '../src/config/env';
import { overlapRatio, selectClips, wordsInRange } from '../src/pipeline/selection';
import { looksLikeVideo } from '../src/projects/projects.service';

const U = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const SECRET = 'x'.repeat(40);

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  S3_ACCESS_KEY: 'a',
  S3_SECRET_KEY: 'b',
  SESSION_SECRET: SECRET,
  MEDIA_SIGNING_SECRET: SECRET,
  INTERNAL_API_TOKEN: 'internal-token-'.padEnd(40, 'z'),
} as NodeJS.ProcessEnv;

function cand(start: number, end: number, score: number): CandidateDTO {
  return { start, end, score, title: `c${start}`, reason: '', components: {}, tags: [], transcript: '' } as unknown as CandidateDTO;
}

function req(headers: Record<string, string>, cookies?: Record<string, string>): Request {
  return { headers, cookies } as unknown as Request;
}

describe('env', () => {
  it('acepta la configuración mínima y aplica valores por defecto', () => {
    const e = loadEnv(baseEnv);
    expect(e.PORT).toBe(4000);
    expect(e.COOKIE_SECURE).toBe(true);
    expect(e.LIVE_SEGMENT_SECONDS).toBe(60);
  });
  it('trata las variables vacías de compose como no definidas', () => {
    const e = loadEnv({ ...baseEnv, ADMIN_EMAIL: '', ADMIN_PASSWORD: '', SMTP_URL: '' });
    expect(e.ADMIN_EMAIL).toBeUndefined();
    expect(e.ADMIN_PASSWORD).toBeUndefined();
    expect(e.SMTP_URL).toBeUndefined();
  });
  it('rechaza secretos cortos y contraseñas de administrador débiles', () => {
    expect(() => loadEnv({ ...baseEnv, SESSION_SECRET: 'corto' })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...baseEnv, ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'short' })).toThrow(/ADMIN_PASSWORD/);
  });
  it('interpreta booleanos de texto', () => {
    expect(loadEnv({ ...baseEnv, COOKIE_SECURE: 'false', ALLOW_REGISTRATION: '0' }).COOKIE_SECURE).toBe(false);
  });
});

describe('URLs firmadas', () => {
  const now = 1_700_000_000_000;
  it('verifica una firma válida', () => {
    const { exp, sig } = signMedia(SECRET, 'render:abc', 600, now);
    expect(verifyMedia(SECRET, 'render:abc', exp, sig, now)).toBe(true);
  });
  it('rechaza firmas caducadas, manipuladas o de otro recurso', () => {
    const { exp, sig } = signMedia(SECRET, 'render:abc', 600, now);
    expect(verifyMedia(SECRET, 'render:abc', exp, sig, now + 601_000)).toBe(false);
    expect(verifyMedia(SECRET, 'render:abd', exp, sig, now)).toBe(false);
    expect(verifyMedia(SECRET, 'render:abc', exp + 1, sig, now)).toBe(false);
    expect(verifyMedia('y'.repeat(40), 'render:abc', exp, sig, now)).toBe(false);
    expect(verifyMedia(SECRET, 'render:abc', exp, '', now)).toBe(false);
    expect(verifyMedia(SECRET, 'render:abc', Number.NaN, sig, now)).toBe(false);
  });
});

describe('claves de almacenamiento', () => {
  it('genera claves de servidor con prefijo, usuario y proyecto', () => {
    const k = buildKey('originals', U, P, '.MP4');
    expect(k).toMatch(new RegExp(`^originals/${U}/${P}/[0-9a-f-]{36}\\.mp4$`));
    expect(keyBelongsTo(k, U, P)).toBe(true);
    expect(prefixFor('clips', U, P)).toBe(`clips/${U}/${P}`);
  });
  it('rechaza identificadores y extensiones peligrosas', () => {
    expect(() => buildKey('originals', '../x', P, 'mp4')).toThrow();
    expect(() => buildKey('originals', U, P, 'mp4/../../x')).toThrow();
    expect(() => prefixFor('clips', U, 'a/b')).toThrow();
  });
  it('detecta claves ajenas o con traversal', () => {
    expect(keyBelongsTo(`originals/${U}/${P}/../../x.mp4`, U)).toBe(false);
    expect(keyBelongsTo(`/originals/${U}/${P}/a.mp4`, U)).toBe(false);
    expect(keyBelongsTo(`originals/otro/${P}/a.mp4`, U)).toBe(false);
    expect(keyBelongsTo(`desconocido/${U}/${P}/a.mp4`, U)).toBe(false);
    expect(keyBelongsTo(`originals/${U}/${P}/a.mp4`, U, 'otro')).toBe(false);
  });
});

describe('selección de clips', () => {
  it('calcula el solapamiento relativo al tramo más corto', () => {
    expect(overlapRatio({ start: 0, end: 10 }, { start: 5, end: 15 })).toBeCloseTo(0.5);
    expect(overlapRatio({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(0);
    expect(overlapRatio({ start: 0, end: 30 }, { start: 5, end: 10 })).toBe(1);
  });
  it('ordena por puntuación, respeta el máximo y evita solapamientos', () => {
    const out = selectClips({
      candidates: [cand(0, 30, 80), cand(5, 35, 90), cand(60, 90, 70), cand(100, 130, 40)],
      existing: [], maxClips: 5, minScore: 50, preference: 'balanced', allowFallback: true,
    });
    expect(out.map((s) => s.candidate.start)).toEqual([5, 60]);
    expect(out.every((s) => !s.lowConfidence)).toBe(true);
  });
  it('ajusta el umbral según la preferencia', () => {
    const input = { candidates: [cand(0, 30, 45)], existing: [], maxClips: 3, minScore: 50, allowFallback: false };
    expect(selectClips({ ...input, preference: 'quantity' })).toHaveLength(1);
    expect(selectClips({ ...input, preference: 'balanced' })).toHaveLength(0);
  });
  it('en VOD conserva el mejor candidato como baja confianza si nada supera el umbral', () => {
    const out = selectClips({ candidates: [cand(0, 30, 20), cand(40, 70, 30)], existing: [], maxClips: 3, minScore: 50, preference: 'balanced', allowFallback: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ lowConfidence: true, candidate: { start: 40 } });
  });
  it('tiene en cuenta los clips existentes (directos incrementales)', () => {
    const out = selectClips({ candidates: [cand(10, 40, 90), cand(100, 130, 80)], existing: [{ start: 0, end: 30 }], maxClips: 2, minScore: 50, preference: 'balanced', allowFallback: false });
    expect(out.map((s) => s.candidate.start)).toEqual([100]);
  });
  it('extrae las palabras del rango en orden', () => {
    const words = wordsInRange([
      { words: [{ start: 5, end: 6, word: 'b', probability: 1 }, { start: 1, end: 2, word: 'a', probability: 1 }] },
      { words: null },
      { words: [{ start: 20, end: 21, word: 'fuera', probability: 1 }] },
    ], 0, 10);
    expect(words.map((w) => w.word)).toEqual(['a', 'b']);
  });
});

describe('estilo de subtítulos', () => {
  it('limita rangos y descarta valores no válidos', () => {
    const s = sanitizeStyle({ fontSize: 999, outlineWidth: -3, maxWordsPerLine: 50, primaryColor: '#FFF000', highlightColor: 'red; drop', position: 'left' as never, preset: 'evil' as never });
    expect(s).toEqual({ fontSize: 160, outlineWidth: 0, maxWordsPerLine: 10, primaryColor: '#FFF000' });
  });
  it('ignora números no válidos en lugar de guardar NaN', () => {
    expect(sanitizeStyle({ fontSize: 'abc' as never, maxWordsPerLine: '' as never })).toEqual({});
  });
});

describe('autenticación', () => {
  beforeAll(() => setEnvForTests(loadEnv(baseEnv)));

  it('extrae el token de la cookie o de Authorization', () => {
    expect(extractToken(req({}, { cm_session: 'abc' }))).toBe('abc');
    expect(extractToken(req({ authorization: 'Bearer xyz' }))).toBe('xyz');
    expect(extractToken(req({}))).toBeNull();
  });
  it('acepta el token interno correcto sólo sin cabeceras de proxy', () => {
    const token = baseEnv.INTERNAL_API_TOKEN!;
    expect(checkInternal(req({ authorization: `Bearer ${token}` }))).toBe(true);
    expect(() => checkInternal(req({ authorization: `Bearer ${token}`, 'x-forwarded-for': '1.2.3.4' }))).toThrow(ForbiddenException);
    expect(() => checkInternal(req({ authorization: 'Bearer incorrecto' }))).toThrow(UnauthorizedException);
    expect(() => checkInternal(req({}))).toThrow(UnauthorizedException);
  });
});

describe('detección de video por firma de archivo', () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'cm-')); });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('reconoce MP4 y Matroska y rechaza otros archivos', async () => {
    const mp4 = join(dir, 'a.mp4');
    await writeFile(mp4, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8)]));
    const mkv = join(dir, 'a.mkv');
    await writeFile(mkv, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]));
    const fake = join(dir, 'a.exe.mp4');
    await writeFile(fake, Buffer.from('MZ\x90\x00 esto no es un video'));
    expect(await looksLikeVideo(mp4)).toBe(true);
    expect(await looksLikeVideo(mkv)).toBe(true);
    expect(await looksLikeVideo(fake)).toBe(false);
  });
});

describe('editor: fuentes, estilos y palabras', () => {
  const { fontExtension, fontFamily } = jest.requireActual('../src/clips/font-file') as typeof import('../src/clips/font-file');
  const { buildOverride, effectiveWords } = jest.requireActual('../src/clips/words') as typeof import('../src/clips/words');
  const { readFileSync, existsSync } = jest.requireActual('node:fs') as typeof import('node:fs');

  it('lee el nombre de familia de una fuente TrueType real y rechaza otros archivos', () => {
    const candidates = ['C:\Windows\Fonts\arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];
    const path = candidates.find((p) => existsSync(p));
    if (path) {
      const buf = readFileSync(path);
      expect(fontExtension(buf)).toBe('ttf');
      expect(fontFamily(buf)).toMatch(/^(Arial|DejaVu Sans)$/);
    }
    expect(fontExtension(Buffer.from('<html>no soy una fuente</html>'))).toBeNull();
    expect(fontFamily(Buffer.alloc(4))).toBeNull();
  });

  it('acepta plantillas y fuentes conocidas o propias, y descarta el resto', () => {
    expect(sanitizeStyle({ preset: 'neon', font: 'Bebas Neue' })).toEqual({ preset: 'neon', font: 'Bebas Neue' });
    expect(sanitizeStyle({ font: 'custom:11111111-2222-3333-4444-555555555555' }).font).toBe('custom:11111111-2222-3333-4444-555555555555');
    expect(sanitizeStyle({ preset: 'otra' as never, font: 'Comic Sans; drop' })).toEqual({});
  });

  it('la corrección sustituye el texto en su tramo y respeta los tiempos', () => {
    const original = [{ start: 1, end: 1.5, word: 'ola' }, { start: 1.5, end: 2, word: 'mundo' }];
    const ranges = [{ start: 0, end: 5 }];
    const ov = buildOverride(original, [{ start: 1, end: 1.5, word: ' hola ' }, { start: 1.5, end: 2, word: '' }], ranges);
    expect(ov.words).toEqual([{ start: 1, end: 1.5, word: 'hola' }]);
    const transcript = [...original, { start: 9, end: 9.5, word: 'fuera' }];
    expect(effectiveWords(transcript, ov, [{ start: 0, end: 10 }]).map((w) => w.word)).toEqual(['hola', 'fuera']);
    expect(() => buildOverride(original, [{ start: 1.2, end: 1.5, word: 'x' }], ranges)).toThrow();
  });
});
