import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * URLs firmadas HMAC para servir medios a través de la API sin exponer MinIO.
 * firma = HMAC_SHA256(secret, `${assetRef}:${exp}`) en base64url.
 */
export function signMedia(secret: string, ref: string, ttlSec: number, now = Date.now()): { exp: number; sig: string } {
  const exp = Math.floor(now / 1000) + ttlSec;
  return { exp, sig: hmac(secret, `${ref}:${exp}`) };
}

export function verifyMedia(secret: string, ref: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(now / 1000)) return false;
  const expected = Buffer.from(hmac(secret, `${ref}:${exp}`));
  const given = Buffer.from(sig ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}
