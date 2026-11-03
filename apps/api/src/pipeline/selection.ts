import type { CandidateDTO, Word } from '@clipmaster/shared';

export interface Range {
  start: number;
  end: number;
}

export function overlapRatio(a: Range, b: Range): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 ? inter / shorter : 0;
}

export interface SelectionInput {
  candidates: CandidateDTO[];
  existing: Range[];
  maxClips: number;
  minScore: number;
  preference: string;
  /** VOD: si nada supera el umbral, se conserva el mejor candidato (marcado como baja confianza). */
  allowFallback: boolean;
  maxOverlap?: number;
}

export interface Selected {
  candidate: CandidateDTO;
  lowConfidence: boolean;
}

/** Selecciona clips ordenados por puntuación evitando solapamientos entre sí y con clips existentes. */
export function selectClips(input: SelectionInput): Selected[] {
  const maxOverlap = input.maxOverlap ?? 0.5;
  const threshold = input.minScore + (input.preference === 'quality' ? 10 : input.preference === 'quantity' ? -10 : 0);
  const remaining = Math.max(0, input.maxClips - input.existing.length);
  const sorted = [...input.candidates].filter((c) => c.end > c.start).sort((a, b) => b.score - a.score);
  const taken: Range[] = [...input.existing];
  const out: Selected[] = [];
  for (const c of sorted) {
    if (out.length >= remaining) break;
    if (c.score < threshold) break;
    if (taken.some((t) => overlapRatio(t, c) > maxOverlap)) continue;
    taken.push(c);
    out.push({ candidate: c, lowConfidence: false });
  }
  if (out.length === 0 && input.allowFallback && remaining > 0 && sorted.length > 0) {
    const best = sorted.find((c) => !taken.some((t) => overlapRatio(t, c) > maxOverlap));
    if (best) out.push({ candidate: best, lowConfidence: true });
  }
  return out;
}

/** Palabras dentro de [start, end], con tiempos absolutos (el worker las hace relativas). */
export function wordsInRange(segments: { words: unknown }[], start: number, end: number): Word[] {
  const out: Word[] = [];
  for (const s of segments) {
    const words = Array.isArray(s.words) ? (s.words as Word[]) : [];
    for (const w of words) {
      if (w.end > start && w.start < end) out.push({ start: w.start, end: w.end, word: w.word, probability: w.probability });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
