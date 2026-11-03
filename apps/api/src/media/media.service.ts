import { Injectable } from '@nestjs/common';
import { signMedia } from '../common/signing';
import { env } from '../config/env';

export type MediaKind = 'original' | 'render' | 'thumb' | 'cover' | 'segment' | 'subtitle';

/** Genera URLs firmadas (HMAC, caducidad corta) servidas por MediaController. */
@Injectable()
export class MediaService {
  url(kind: MediaKind, id: string, opts: { download?: boolean; ttlSec?: number } = {}): string {
    const ttl = opts.ttlSec ?? env().MEDIA_URL_TTL_SEC;
    // Redondea la caducidad a bloques de 10 min para que el navegador pueda cachear miniaturas.
    const now = Math.floor(Date.now() / 600_000) * 600_000;
    const { exp, sig } = signMedia(env().MEDIA_SIGNING_SECRET, `${kind}:${id}`, ttl, now);
    const qs = new URLSearchParams({ exp: String(exp), sig });
    if (opts.download) qs.set('dl', '1');
    return `/api/media/${kind}/${id}?${qs.toString()}`;
  }
}
