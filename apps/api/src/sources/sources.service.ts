import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { detectProvider, PROVIDERS, ProviderId } from '@clipmaster/shared';
import { AgentsService, usesAgent } from '../agents/agents.service';
import { env } from '../config/env';

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
  /** La validación real la hará el capturador remoto al tomar el trabajo. */
  deferred?: boolean;
  agentOnline?: boolean;
}

/**
 * Validación de URLs. La API hace una comprobación rápida; la validación real
 * (resolución DNS anti‑SSRF, yt-dlp/streamlink, live/VOD, restricciones) la hace el
 * capture-worker a través de su endpoint interno /validate.
 */
@Injectable()
export class SourcesService {
  private readonly log = new Logger(SourcesService.name);

  constructor(private readonly agents: AgentsService) {}

  quickCheck(url: string): ProviderId {
    if (url.length > 2048) throw new BadRequestException('URL demasiado larga');
    const provider = detectProvider(url);
    if (!provider) throw new BadRequestException('URL no compatible. Usa YouTube, Twitch, Kick, TikTok, HLS (.m3u8) o un archivo de video directo.');
    return provider;
  }

  async validate(url: string): Promise<ValidationResult> {
    const provider = this.quickCheck(url);
    if (usesAgent(provider)) {
      // El servidor no puede consultar este proveedor (bloquea su IP): lo validará el capturador.
      const agentOnline = await this.agents.anyOnline();
      return {
        ok: true, provider, isLive: false, title: null, durationSec: null, thumbnail: null, supportsLive: false,
        reason: null, deferred: true, agentOnline,
        notes: agentOnline
          ? 'Lo descargará el capturador de tu PC, que lo validará al empezar.'
          : 'Tu capturador no está conectado: el proyecto esperará hasta que lo inicies en tu PC.',
      };
    }
    let res: Response;
    try {
      res = await fetch(`${env().CAPTURE_WORKER_URL}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env().INTERNAL_API_TOKEN}` },
        body: JSON.stringify({ url, provider }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      this.log.error(`capture-worker no disponible: ${(err as Error).message}`);
      throw new BadGatewayException('El servicio de captura no está disponible');
    }
    if (!res.ok) throw new BadGatewayException(`Validación fallida (${res.status})`);
    const body = (await res.json()) as ValidationResult;
    const info = PROVIDERS.find((p) => p.id === body.provider);
    return { ...body, notes: info?.notes ?? null };
  }
}
