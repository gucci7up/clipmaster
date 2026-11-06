import { describe, expect, it } from 'vitest';
import { detectProvider, resolveWeights, MODES, CONTENT_MODES } from '../src';
import fixtures from '../fixtures/jobs.json';

describe('detectProvider', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'YOUTUBE'],
    ['https://youtu.be/abc', 'YOUTUBE'],
    ['https://www.twitch.tv/somechannel', 'TWITCH'],
    ['https://kick.com/someone', 'KICK'],
    ['https://www.tiktok.com/@u/video/1', 'TIKTOK'],
    ['https://cdn.example.com/live/index.m3u8', 'HLS'],
    ['https://cdn.example.com/a/video.mp4', 'DIRECT'],
  ])('%s → %s', (url, id) => expect(detectProvider(url)).toBe(id));

  it('rechaza esquemas no http', () => {
    expect(detectProvider('file:///etc/passwd')).toBeNull();
    expect(detectProvider('ftp://x/y.mp4')).toBeNull();
    expect(detectProvider('no es url')).toBeNull();
  });
  it('no confunde dominios parecidos', () => {
    expect(detectProvider('https://evilyoutube.com/watch')).toBeNull();
  });
});

describe('resolveWeights', () => {
  it('normaliza a 1 en todos los modos', () => {
    for (const m of CONTENT_MODES) {
      const w = resolveWeights(m);
      expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });
  it('aplica overrides', () => {
    const w = resolveWeights('AUTO', { semantic: 0, emotion: 0, audio: 0, visual: 0, chat: 0, narrative: 0, standalone: 1 });
    expect(w.standalone).toBe(1);
  });
  it('modo dominó desactiva visual por defecto', () => expect(MODES.DOMINO.visual).toBe(false));
});

describe('fixtures de contrato', () => {
  it('contienen los cuatro tipos de job', () => {
    expect(fixtures.map((f: { kind: string }) => f.kind).sort()).toEqual(['analyze', 'copy', 'import', 'live', 'render', 'thumbnail']);
  });
});
