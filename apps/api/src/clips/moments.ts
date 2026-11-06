/**
 * «Encontrar momentos»: búsqueda en la transcripción del proyecto. Ignora mayúsculas, tildes y puntuación,
 * acepta variaciones de una palabra por su raíz (ríen → riendo, jugada → jugando, capicúa → capicúas) y localiza el instante
 * exacto con los tiempos por palabra. No usa IA externa: sólo el texto ya transcrito.
 */

export interface SearchSegment {
  start: number;
  end: number;
  text: string;
  words: unknown;
}

export interface Moment {
  /** Instante de la primera palabra encontrada. */
  at: number;
  start: number;
  end: number;
  text: string;
  /** Palabras del texto que coinciden, tal como aparecen (para resaltarlas). */
  matches: string[];
  /** 0–1: proporción de términos encontrados, con bonificación si aparece la frase exacta. */
  score: number;
}

const STOPWORDS = new Set([
  'a', 'al', 'de', 'del', 'el', 'la', 'las', 'los', 'lo', 'un', 'una', 'unos', 'unas', 'y', 'e', 'o', 'u', 'en', 'con', 'por',
  'para', 'que', 'se', 'su', 'sus', 'es', 'cuando', 'donde', 'como', 'mi', 'me', 'te', 'le', 'les', 'ya', 'muy',
  'the', 'and', 'of', 'to', 'in', 'is', 'when',
]);

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Raíz aproximada: recorta terminaciones frecuentes para que «jugada» encuentre «jugando» o «jugó» sin exigir la forma exacta. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  const cut = w.replace(/(amente|aciones|acion|iendo|ando|aron|ieron|ados|idas|idos|adas|ado|ido|ada|ida|ar|er|ir|es|s)$/, '');
  return cut.length >= 3 ? cut : w;
}

function termMatches(term: string, word: string): boolean {
  if (word === term) return true;
  if (/^\d+$/.test(term)) return false; // los números sólo coinciden exactos
  const a = stem(term);
  return a.length >= 3 && (word.startsWith(a) || stem(word) === a);
}

interface TimedWord { start: number; end: number; raw: string; norm: string }

function wordsOf(seg: SearchSegment): TimedWord[] {
  const list = Array.isArray(seg.words) ? (seg.words as { start?: unknown; end?: unknown; word?: unknown }[]) : [];
  const timed = list
    .filter((w) => typeof w?.word === 'string' && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
    .map((w) => ({ start: Number(w.start), end: Number(w.end), raw: String(w.word).trim(), norm: normalize(String(w.word)) }))
    .filter((w) => w.norm);
  if (timed.length) return timed;
  // Sin tiempos por palabra: se reparte el tramo uniformemente.
  const raw = seg.text.split(/\s+/).filter(Boolean);
  const step = (seg.end - seg.start) / Math.max(1, raw.length);
  return raw.map((r, i) => ({ start: seg.start + i * step, end: seg.start + (i + 1) * step, raw: r, norm: normalize(r) })).filter((w) => w.norm);
}

export function searchMoments(segments: SearchSegment[], query: string, limit = 30): Moment[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const all = q.split(' ');
  const terms = all.length > 1 ? all.filter((t) => !STOPWORDS.has(t)) : all;
  if (!terms.length) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const need = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);

  const hits: Moment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    // Cada tramo junto con el siguiente: una frase puede quedar partida entre dos segmentos.
    const window = [sorted[i], sorted[i + 1]].filter((s): s is SearchSegment => !!s && s.start - sorted[i].end < 3);
    const words = window.flatMap(wordsOf);
    const found = terms.map((t) => words.findIndex((w) => termMatches(t, w.norm)));
    const count = found.filter((x) => x >= 0).length;
    // El primer término debe estar en este tramo; si sólo está en el siguiente, ya lo encontrará esa ventana.
    const own = wordsOf(sorted[i]).length;
    if (count < need || !found.some((x) => x >= 0 && x < own)) continue;
    const phrase = ` ${words.map((w) => w.norm).join(' ')} `.includes(` ${q} `);
    const idx = found.filter((x) => x >= 0);
    const first = words[Math.min(...idx)];
    const last = words[Math.max(...idx)];
    hits.push({
      at: first.start,
      start: sorted[i].start,
      end: Math.max(window[window.length - 1].end, last.end),
      text: window.map((s) => s.text.trim()).join(' '),
      matches: [...new Set(idx.map((x) => words[x].raw))],
      score: Math.min(1, count / terms.length * (phrase ? 1 : 0.85)),
    });
  }

  // Ventanas solapadas del mismo momento: se queda la de mejor puntuación.
  const best: Moment[] = [];
  for (const h of hits.sort((a, b) => b.score - a.score || a.at - b.at)) {
    if (!best.some((b) => Math.abs(b.at - h.at) < 4)) best.push(h);
  }
  return best.slice(0, limit).sort((a, b) => b.score - a.score || a.at - b.at);
}
