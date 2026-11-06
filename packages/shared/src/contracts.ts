/**
 * Contratos de comunicación entre la API (productor BullMQ) y los workers Python
 * (consumidores). Reflejados en services/worker/clipmaster_worker/contracts.py.
 * Cualquier cambio aquí debe reflejarse allí; fixtures/jobs.json se valida en ambos lados.
 */

export const QUEUE_PREFIX = 'clipmaster';

export const Queues = {
  CAPTURE: 'capture',
  AI: 'ai',
  RENDER: 'render',
} as const;
export type QueueName = (typeof Queues)[keyof typeof Queues];

export const CANCEL_KEY = (projectId: string) => `clipmaster:cancel:${projectId}`;
export const STOP_CAPTURE_KEY = (captureSessionId: string) => `clipmaster:stop:${captureSessionId}`;
export const EVENTS_CHANNEL = 'clipmaster:events';
export const WORKER_HEARTBEAT_KEY = (role: string, id: string) => `clipmaster:worker:${role}:${id}`;

export type AspectRatio = 'VERTICAL' | 'HORIZONTAL' | 'SQUARE';
export const ASPECT_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  VERTICAL: { width: 1080, height: 1920 },
  HORIZONTAL: { width: 1920, height: 1080 },
  SQUARE: { width: 1080, height: 1080 },
};

export type ContentMode =
  | 'AUTO' | 'GAMING' | 'DOMINO' | 'PODCAST' | 'INTERVIEW'
  | 'REACTION' | 'HUMOR' | 'EDUCATION' | 'SPORTS' | 'CUSTOM';

export type ProviderId = 'UPLOAD' | 'YOUTUBE' | 'TWITCH' | 'KICK' | 'TIKTOK' | 'DIRECT' | 'HLS';

export type SignalName = 'semantic' | 'emotion' | 'audio' | 'visual' | 'chat' | 'narrative' | 'standalone';
export type SignalWeights = Partial<Record<SignalName, number>>;

export interface MediaSource {
  /** Clave del objeto en el almacenamiento. */
  key: string;
  /** Posición (segundos) del inicio de este archivo en la línea de tiempo del proyecto. */
  offsetSec: number;
  durationSec: number;
}

export interface Word {
  start: number;
  end: number;
  word: string;
  probability?: number;
}

export type SubtitlePreset = 'tiktok' | 'clean' | 'karaoke' | 'neon' | 'minimal' | 'podcast';
export const SUBTITLE_PRESETS: SubtitlePreset[] = ['tiktok', 'karaoke', 'clean', 'neon', 'minimal', 'podcast'];

/** Fuentes instaladas en la imagen del worker. Las fuentes propias se indican como `custom:<id>`. */
export const BUILTIN_FONTS = ['Montserrat', 'DejaVu Sans', 'Roboto', 'Open Sans', 'Lato', 'Bebas Neue'] as const;

export interface SubtitleStyle {
  preset: SubtitlePreset;
  /** Familia de `BUILTIN_FONTS` o `custom:<id de UserFont>`. */
  font: string;
  fontSize: number;
  primaryColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  position: 'bottom' | 'center' | 'top';
  uppercase: boolean;
  maxWordsPerLine: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  preset: 'tiktok',
  font: 'Montserrat',
  fontSize: 72,
  primaryColor: '#FFFFFF',
  highlightColor: '#FFD400',
  outlineColor: '#000000',
  outlineWidth: 5,
  position: 'center',
  uppercase: true,
  maxWordsPerLine: 4,
};

export interface CropKeyframe {
  /** Tiempo relativo al inicio del clip (s). */
  t: number;
  /** Centro horizontal normalizado 0..1. */
  x: number;
  /** Centro vertical normalizado 0..1. */
  y: number;
}

export interface AnalyzeSettings {
  maxClips: number;
  minDuration: number;
  maxDuration: number;
  visualAnalysis: boolean;
  semanticLLM: boolean;
  /** Análisis con fotogramas por el modelo de visión de NVIDIA (requiere el proveedor NVIDIA). */
  visionLLM?: boolean;
  weights?: SignalWeights;
  preference: 'balanced' | 'quality' | 'quantity';
}

export interface ImportJobData {
  kind: 'import';
  jobId: string;
  projectId: string;
  userId: string;
  source: { type: 'upload'; storageKey: string } | { type: 'url'; url: string; provider: ProviderId };
  outputPrefix: string;
  maxDurationSec: number;
}

export interface LiveCaptureJobData {
  kind: 'live';
  jobId: string;
  projectId: string;
  userId: string;
  captureSessionId: string;
  url: string;
  provider: ProviderId;
  segmentSeconds: number;
  maxDurationSec: number;
  /** Índice desde el que continuar (reanudación tras reinicio). */
  startIndex: number;
  startOffsetSec: number;
  outputPrefix: string;
}

export interface AnalyzeJobData {
  kind: 'analyze';
  jobId: string;
  projectId: string;
  userId: string;
  sources: MediaSource[];
  /** Ventana completa a analizar (incluye contexto). */
  window: { start: number; end: number };
  /** Sólo se aceptan candidatos cuyo pico cae en este rango (evita duplicados entre segmentos). */
  focus: { start: number; end: number };
  language: string | null;
  mode: ContentMode;
  settings: AnalyzeSettings;
  outputPrefix: string;
  segmentId?: string | null;
}

export interface RenderJobData {
  kind: 'render';
  jobId: string;
  projectId: string;
  userId: string;
  clipId: string;
  renderId: string;
  sources: MediaSource[];
  start: number;
  end: number;
  aspect: AspectRatio;
  subtitles: { enabled: boolean; style: SubtitleStyle; words: Word[] };
  /** Título gancho en la parte superior durante los primeros segundos. */
  hook?: { text: string; durationSec: number } | null;
  /** Fuentes propias que el render debe descargar (clave en el almacenamiento y familia). */
  fonts?: { key: string; family: string }[];
  /**
   * Clip combinado: tramos de la línea de tiempo del proyecto que se encadenan en orden. Si existe,
   * `start`/`end` abarcan todos y las palabras usan tiempos de la línea de tiempo original.
   */
  segments?: { start: number; end: number }[] | null;
  /** Funciones de IA de NVIDIA (opcionales). Sólo se envían si el usuario las activó. */
  ai?: RenderAI | null;
  reframe: { mode: 'auto' | 'center' | 'manual'; manualX?: number; manualY?: number };
  track?: CropKeyframe[] | null;
  outputPrefix: string;
}

/** Título, descripción y hashtags para publicar un clip, generados con el LLM del ai-worker. */
export interface CopyJobData {
  kind: 'copy';
  jobId: string;
  projectId: string;
  userId: string;
  clipId: string;
  /** Texto del clip (con las correcciones del usuario), recortado a 6.000 caracteres. */
  text: string;
  title: string;
  mode: ContentMode;
  language?: string | null;
}

export interface SocialCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export interface CopyResult extends SocialCopy {
  model: string;
}

export type AnyJobData = ImportJobData | LiveCaptureJobData | AnalyzeJobData | RenderJobData | CopyJobData;

// ---------- Resultados ----------

export interface ProbeInfo {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
}

export interface ImportResult {
  asset: ProbeInfo & { key: string; sizeBytes: number };
  title: string | null;
}

export interface TranscriptSegmentDTO {
  start: number;
  end: number;
  text: string;
  words: Word[];
  avgLogprob?: number | null;
  noSpeechProb?: number | null;
}

export interface CandidateDTO {
  start: number;
  end: number;
  peakTime: number;
  score: number;
  title: string;
  reason: string;
  text: string;
  signals: Partial<Record<SignalName, number>>;
  tags: string[];
  track?: CropKeyframe[] | null;
}

export interface AnalyzeResult {
  language: string | null;
  languageProbability: number | null;
  durationSec: number;
  transcriptKey: string | null;
  srtKey: string | null;
  segments: TranscriptSegmentDTO[];
  candidates: CandidateDTO[];
  timings: Record<string, number>;
  modules: Record<string, 'ok' | 'skipped' | 'failed'>;
  device: string;
  model: string | null;
}

/** Funciones de NVIDIA en el render: mirada a cámara, iluminación (preset 0-4), voz del gancho y portada. */
export interface RenderAI {
  eyeContact?: boolean;
  relight?: number | null;
  hookVoice?: string | null;
  coverPrompt?: string | null;
}

export type AiFeature = 'eyeContact' | 'relight' | 'hookVoice' | 'cover';
export type AiFeatureStatus = { status: 'ok' | 'failed'; error?: string };

/** Presets de iluminación del servicio Maxine Relighting (hdri_preset_id). */
export const RELIGHT_PRESETS = ['Salón', 'Calle de noche', 'Invernadero', 'París', 'Estudio de madera'] as const;

/** Voces en español (es-US) de Magpie TTS multilingüe. */
export const HOOK_VOICES = [
  { id: 'Magpie-Multilingual.ES-US.Diego', label: 'Diego' },
  { id: 'Magpie-Multilingual.ES-US.Diego.Happy', label: 'Diego (alegre)' },
  { id: 'Magpie-Multilingual.ES-US.Diego.PleasantSurprised', label: 'Diego (sorprendido)' },
  { id: 'Magpie-Multilingual.ES-US.Isabela', label: 'Isabela' },
  { id: 'Magpie-Multilingual.ES-US.Isabela.Happy', label: 'Isabela (alegre)' },
  { id: 'Magpie-Multilingual.ES-US.Sofia', label: 'Sofía' },
  { id: 'Magpie-Multilingual.ES-US.Leo', label: 'Leo' },
  { id: 'Magpie-Multilingual.ES-US.Pascal', label: 'Pascal' },
] as const;

export interface RenderResult {
  outputKey: string;
  thumbnailKey: string;
  coverKey?: string | null;
  ai?: Partial<Record<AiFeature, AiFeatureStatus>> | null;
  subtitleKey: string | null;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  encoder: string;
  hasAudio: boolean;
}

export interface LiveCaptureResult {
  segments: number;
  durationSec: number;
  endedReason: 'stopped' | 'stream_ended' | 'max_duration' | 'error';
}

// ---------- Mensajes internos worker → API ----------

export interface ProgressEvent {
  jobId: string;
  stage: string;
  /** 0..1 cuando se conoce de verdad; null si no es medible. */
  progress: number | null;
  message?: string;
  metrics?: Record<string, number>;
}

export interface SegmentReadyEvent {
  jobId: string;
  captureSessionId: string;
  index: number;
  key: string;
  startSec: number;
  durationSec: number;
  sizeBytes: number;
}

export interface JobCompleteEvent<T = unknown> {
  jobId: string;
  result: T;
}

export interface JobFailEvent {
  jobId: string;
  error: string;
  /** true si BullMQ va a reintentar. */
  willRetry: boolean;
  attempt: number;
}
