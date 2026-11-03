import modesConfig from '../config/modes.json';
import type { ContentMode, SignalName, SignalWeights } from './contracts';

export interface ModeConfig {
  label: string;
  weights: Record<SignalName, number>;
  visual: boolean;
  minScore: number;
  silencePenalty: number;
  lexicon?: string;
}

export const MODES = modesConfig.modes as Record<ContentMode, ModeConfig>;
export const CONTENT_MODES = Object.keys(MODES) as ContentMode[];
export const DURATION_PRESETS = modesConfig.durationPresets as Record<'SHORT' | 'MEDIUM' | 'LONG', { min: number; max: number }>;

/** Combina los pesos del modo con los ajustes del usuario y normaliza a suma 1. */
export function resolveWeights(mode: ContentMode, overrides?: SignalWeights): Record<SignalName, number> {
  const base = { ...MODES[mode].weights, ...(overrides ?? {}) } as Record<SignalName, number>;
  const total = Object.values(base).reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return { ...MODES.AUTO.weights };
  const out = {} as Record<SignalName, number>;
  for (const [k, v] of Object.entries(base)) out[k as SignalName] = Math.max(0, v) / total;
  return out;
}
