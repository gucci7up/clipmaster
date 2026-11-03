# ClipMaster AI

Plataforma autoalojada que convierte videos largos y transmisiones en clips cortos:

- detecta los mejores momentos con IA local: transcripción, audio, visión y semántica;
- los recorta con contexto;
- los reencuadra a 9:16, 16:9 o 1:1;
- añade subtítulos animados.

Interfaz en español. Funciona en CPU, y opcionalmente en GPU NVIDIA.

```
Navegador ──HTTPS──▶ Traefik (Dokploy) ─┬─ /     ▶ web (Next.js)
                                        └─ /api  ▶ api (NestJS + Prisma) ──▶ PostgreSQL
                                                     │  BullMQ / Redis
                                     ┌───────────────┼───────────────┐
                               capture-worker     ai-worker      render-worker   (Python)
                               yt-dlp/Streamlink  faster-whisper FFmpeg/libass
                               FFmpeg             OpenCV         NVENC opcional
                                     └───────── RustFS / S3 (privado) ─┘
```

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Componentes, protocolo de colas y datos |
| [IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) | Estado real por etapa, riesgos y decisiones |
| [DOKPLOY_DEPLOYMENT](docs/DOKPLOY_DEPLOYMENT.md) | Despliegue, GPU, copias de seguridad |
| [AI_PIPELINE](docs/AI_PIPELINE.md) | Transcripción, señales, puntuación y render |
| [STREAM_PROVIDERS](docs/STREAM_PROVIDERS.md) | Qué plataformas funcionan y con qué límites |
| [SECURITY](docs/SECURITY.md) | Exposición, auth, SSRF, secretos |
| [TESTING](docs/TESTING.md) | Pruebas, resultados y qué falta verificar |

## Desarrollo local

Requisitos:

- Node 24 y pnpm 11;
- Python 3.12;
- FFmpeg 7 u 8 en el `PATH`;
- PostgreSQL, Redis y un S3 compatible, como RustFS (para la API).

```bash
pnpm install
pnpm --filter @clipmaster/shared build

# Worker
cd services/worker
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt -r requirements-dev.txt   # en Linux: .venv/bin/pip
.venv/Scripts/python -m pytest -q          # incluye el e2e real: video → clips MP4

# API (con DATABASE_URL, REDIS_URL, S3_* y secretos en el entorno)
pnpm --filter @clipmaster/api exec prisma migrate deploy
pnpm dev:api

# Web (reenvía /api a http://localhost:4000)
pnpm dev:web
```

## Despliegue

Ver [docs/DOKPLOY_DEPLOYMENT.md](docs/DOKPLOY_DEPLOYMENT.md). Resumen:

- Docker Compose en Dokploy con `compose.yaml`;
- variables tomadas de `.env.example`;
- dos dominios para el mismo host: `/api` → `api:4000` y `/` → `web:3000`;
- GPU opcional con `compose.gpu.yaml`.

## Uso responsable

Procesa solo contenido propio o para el que tengas autorización. ClipMaster no evade DRM, inicios de sesión ni restricciones de las plataformas.
