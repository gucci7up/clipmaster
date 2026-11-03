import type { ProviderId } from './contracts';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  hosts: string[];
  vod: boolean;
  live: boolean;
  /** Notas mostradas al usuario sobre restricciones. */
  notes: string;
}

/**
 * Metadatos para la UI y la API. La validación autoritativa (accesibilidad, live/VOD,
 * restricciones) la hace el capture-worker con yt-dlp/streamlink.
 */
export const PROVIDERS: ProviderInfo[] = [
  { id: 'YOUTUBE', label: 'YouTube', hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'], vod: true, live: true,
    notes: 'Sólo contenido propio o con permiso. Videos privados, con DRM o que exigen inicio de sesión no se procesan.' },
  { id: 'TWITCH', label: 'Twitch', hosts: ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'clips.twitch.tv'], vod: true, live: true,
    notes: 'VODs y directos públicos. Contenido para suscriptores no es accesible.' },
  { id: 'KICK', label: 'Kick', hosts: ['kick.com', 'www.kick.com'], vod: true, live: true,
    notes: 'Kick puede bloquear accesos automatizados (Cloudflare). Si falla, sube tu grabación.' },
  { id: 'TIKTOK', label: 'TikTok', hosts: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com'], vod: true, live: false,
    notes: 'Videos públicos. Los directos de TikTok no se capturan: descarga tu directo desde TikTok Studio y súbelo.' },
  { id: 'HLS', label: 'HLS (.m3u8)', hosts: [], vod: true, live: true,
    notes: 'Fuentes HLS públicas sin DRM ni tokens de terceros.' },
  { id: 'DIRECT', label: 'Archivo directo', hosts: [], vod: true, live: false,
    notes: 'URL HTTP(S) pública a un archivo de video (mp4, mov, webm, mkv).' },
  { id: 'UPLOAD', label: 'Subida de archivo', hosts: [], vod: true, live: false, notes: 'MP4/MOV/WEBM/MKV.' },
];

/** Detección rápida (sin red) del proveedor a partir de la URL. */
export function detectProvider(rawUrl: string): ProviderId | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  for (const p of PROVIDERS) {
    if (p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return p.id;
  }
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'HLS';
  if (/\.(mp4|mov|m4v|webm|mkv)$/.test(path)) return 'DIRECT';
  return null;
}
