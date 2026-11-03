import { BadRequestException } from '@nestjs/common';
import type { Word } from '@clipmaster/shared';

/** Corrección de palabras guardada en un clip: sustituye a la transcripción dentro de [start, end]. */
export interface WordOverride {
  start: number;
  end: number;
  words: Word[];
}

export interface Range {
  start: number;
  end: number;
}

const MAX_WORDS = 3000;
const MAX_WORD_LEN = 60;

export function asOverride(v: unknown): WordOverride | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<WordOverride>;
  if (typeof o.start !== 'number' || typeof o.end !== 'number' || !Array.isArray(o.words)) return null;
  return o as WordOverride;
}

export function asRanges(v: unknown): Range[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  return v.filter((r): r is Range => typeof r?.start === 'number' && typeof r?.end === 'number');
}

/** Palabras de la transcripción en los tramos, con la corrección del usuario aplicada. */
export function effectiveWords(transcript: Word[], override: WordOverride | null, ranges: Range[]): Word[] {
  const base = override ? transcript.filter((w) => w.end <= override.start || w.start >= override.end) : transcript;
  const all = override ? [...base, ...override.words] : base;
  return all
    .filter((w) => ranges.some((r) => w.end > r.start && w.start < r.end))
    .sort((a, b) => a.start - b.start);
}

/**
 * Valida una corrección enviada por el cliente. Los tiempos deben ser los de palabras existentes
 * (el usuario cambia el texto, no la sincronía); una palabra vacía se elimina.
 */
export function buildOverride(original: Word[], edited: { start: number; end: number; word: string }[], ranges: Range[]): WordOverride {
  if (!Array.isArray(edited) || edited.length > MAX_WORDS) throw new BadRequestException('Lista de palabras inválida');
  const valid = new Set(original.map((w) => `${w.start}|${w.end}`));
  const words: Word[] = [];
  for (const e of edited) {
    if (typeof e?.word !== 'string' || typeof e.start !== 'number' || typeof e.end !== 'number') {
      throw new BadRequestException('Palabra con formato inválido');
    }
    if (!valid.has(`${e.start}|${e.end}`)) throw new BadRequestException('Los tiempos de las palabras no pueden cambiar');
    const text = e.word.replace(/\s+/g, ' ').trim().slice(0, MAX_WORD_LEN);
    if (text) words.push({ start: e.start, end: e.end, word: text });
  }
  return {
    start: Math.min(...ranges.map((r) => r.start)),
    end: Math.max(...ranges.map((r) => r.end)),
    words: words.sort((a, b) => a.start - b.start),
  };
}
