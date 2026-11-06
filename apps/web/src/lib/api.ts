import type { AiFeature, AiFeatureStatus, AspectRatio, ContentMode, ProviderId, SocialCopy, SubtitleStyle, ThumbnailStyle, Word } from '@clipmaster/shared';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

function messageFrom(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.join('. ');
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object' && 'message' in m) return String((m as { message: unknown }).message);
  }
  if (status === 429) return 'Demasiadas solicitudes. Espera un momento.';
  if (status >= 500) return 'Error del servidor. Inténtalo de nuevo.';
  return `Error ${status}`;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, messageFrom(body, res.status), body);
  }
  return body as T;
}

export const fetcher = <T,>(path: string) => api<T>(path);

/** Subida con progreso real (XHR expone eventos de progreso; fetch no). */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(xhr.status, messageFrom(body, xhr.status), body));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Error de red durante la subida'));
    xhr.send(form);
  });
}

// ---------------------------------------------------------------- tipos

export type ProjectStatus =
  | 'PENDING' | 'VALIDATING' | 'CAPTURING' | 'DOWNLOADING' | 'TRANSCRIBING'
  | 'ANALYZING' | 'GENERATING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'ADMIN';
}

export interface VideoSource {
  kind: 'UPLOAD' | 'URL';
  provider: ProviderId;
  url: string | null;
  isLive: boolean;
  title: string | null;
}

export interface Job {
  id: string;
  type: 'IMPORT' | 'LIVE_CAPTURE' | 'ANALYZE' | 'RENDER' | 'CLEANUP' | 'COPY' | 'THUMBNAIL';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  stage: string | null;
  progress: number | null;
  attempts: number;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  mode: ContentMode;
  language: string | null;
  detectedLanguage: string | null;
  maxClips: number;
  minDuration: number;
  maxDuration: number;
  aspect: AspectRatio;
  subtitles: boolean;
  errorMessage: string | null;
  processingMs: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  source: VideoSource | null;
  clipCount?: number;
  thumbnailUrl?: string | null;
}

export interface ProjectDetail extends Project {
  jobs: Job[];
  captures: { id: string; status: string; segmentsCount: number; durationSec: number; reconnects: number; endedReason: string | null; startedAt: string }[];
  assets: { id: string; durationSec: number; width: number | null; height: number | null; sizeBytes: number }[];
  originalUrl: string | null;
  _count: { clips: number; candidates: number; segments: number };
}

export interface ClipRender {
  id: string;
  status: 'PENDING' | 'RENDERING' | 'READY' | 'FAILED';
  width: number | null;
  height: number | null;
  durationSec: number | null;
  sizeBytes: number | null;
  encoder: string | null;
  error: string | null;
  renderMs: number | null;
  /** Resultado de cada función de IA de NVIDIA en este render (null si no se pidió ninguna). */
  aiStatus: Partial<Record<AiFeature, AiFeatureStatus>> | null;
  createdAt: string;
}

export interface Clip {
  id: string;
  projectId: string;
  project: { id: string; name: string };
  title: string;
  reason: string;
  score: number;
  start: number;
  end: number;
  duration: number;
  aspect: AspectRatio;
  subtitles: boolean;
  subtitleStyle: SubtitleStyle;
  reframeMode: 'auto' | 'center' | 'manual';
  manualX: number | null;
  manualY: number | null;
  status: 'PENDING' | 'RENDERING' | 'READY' | 'FAILED';
  videoUrl: string | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  subtitleUrl: string | null;
  renders: ClipRender[];
  currentRender: ClipRender | null;
  hookEnabled: boolean;
  hookText: string | null;
  hookDuration: number;
  aiEyeContact: boolean;
  aiRelight: number | null;
  hookVoice: string | null;
  coverPrompt: string | null;
  coverUrl: string | null;
  coverDownloadUrl: string | null;
  /** Título, descripción y hashtags generados con el LLM. */
  socialCopy: (SocialCopy & { model: string; generatedAt: string }) | null;
  socialStatus: 'PENDING' | 'READY' | 'FAILED' | null;
  socialError: string | null;
  /** Miniatura con texto: última configuración, imagen y estado. */
  thumbConfig: { at: number; aspect: AspectRatio; background: 'frame' | 'ai'; prompt: string | null; text: string; style: ThumbnailStyle } | null;
  thumbUrl: string | null;
  thumbDownloadUrl: string | null;
  thumbStatus: 'PENDING' | 'READY' | 'FAILED' | null;
  thumbError: string | null;
  /** Clip combinado: tramos de la línea de tiempo del proyecto, en orden. */
  segments: { start: number; end: number }[] | null;
  wordsEdited: boolean;
  /** Componentes reales de la puntuación (0–1) calculados en el análisis. */
  candidate: { signals: Record<string, number>; tags: string[] } | null;
  createdAt: string;
}

export interface ClipWords {
  words: Word[];
  original: Word[];
  edited: boolean;
}

export interface SubtitlePresetRow {
  id: string;
  name: string;
  style: SubtitleStyle;
  createdAt: string;
}

export interface UserFontRow {
  id: string;
  family: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface Paged<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface Overview {
  projects: number;
  videosProcessed: number;
  activeProcessing: number;
  clipsGenerated: number;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  mediaDurationSec: number;
  processingMs: number;
  recentProjects: (Project & { _count: { clips: number } })[];
}

export interface ValidationResult {
  ok: boolean;
  provider: ProviderId | null;
  isLive: boolean;
  title: string | null;
  durationSec: number | null;
  thumbnail: string | null;
  supportsLive: boolean;
  reason: string | null;
  notes: string | null;
  /** El enlace lo validará y descargará el capturador del PC del usuario. */
  deferred?: boolean;
  agentOnline?: boolean;
}

export interface AppEvent {
  projectId: string;
  type: string;
  jobId?: string | null;
  stage?: string | null;
  progress?: number | null;
  message?: string | null;
  data?: Record<string, unknown>;
  at?: string;
}
