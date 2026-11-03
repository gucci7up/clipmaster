# ClipMaster AI — Arquitectura

## 1. Visión general

```
                 ┌──────────────── Traefik (Dokploy) ─────────────────┐
                 │  https://clips.ejemplo.com/       → web:3000        │
                 │  https://clips.ejemplo.com/api/*  → api:4000        │
                 └───────────────┬───────────────────────┬─────────────┘
                                 │                       │
                        ┌────────▼──────┐        ┌───────▼────────┐
                        │ web (Next.js) │        │ api (NestJS)   │──── PostgreSQL (Prisma)
                        └───────────────┘        │  REST + SSE    │──── RustFS (S3, privado)
                                                 │  orquestador   │──── Redis (BullMQ + pub/sub)
                                                 └──┬──────────▲──┘
                         BullMQ (Redis) jobs        │          │  HTTP interno (token)
                ┌───────────────────┬───────────────┘          │  progreso / resultados
                ▼                   ▼                   ▼      │
       ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
       │ capture-worker │  │   ai-worker    │  │ render-worker  │  (Python + FastAPI health)
       │ yt-dlp,        │  │ faster-whisper │  │ FFmpeg, libass │
       │ streamlink,    │  │ OpenCV, numpy  │  │ reencuadre     │
       │ FFmpeg segment │  │ Ollama (opc.)  │  │ NVENC opc.     │
       └────────────────┘  └────────────────┘  └────────────────┘
```

Flujo: **CAPTURA → SEGMENTOS → COLA → ANÁLISIS IA → SELECCIÓN → RENDERIZADO → CLIPS**.

## 2. Decisiones clave

| Decisión | Motivo |
|---|---|
| Monorepo pnpm (`apps/web`, `apps/api`, `packages/shared`, `services/worker`) | Contratos y configuración compartidos sin duplicar. |
| **Un solo código Python** (`services/worker`) con 3 roles (`WORKER_ROLE=capture|ai|render`) y una sola imagen | Comparten utilidades de FFmpeg, almacenamiento, SSRF y protocolo. Se despliegan como 3 contenedores con concurrencia y recursos independientes. |
| Mismo dominio, ruta `/api` → API | Cookies de sesión first‑party, sin CORS, un solo certificado. |
| Almacenamiento S3 (RustFS) **nunca** expuesto | Los medios se sirven a través de la API con **URLs firmadas HMAC** de corta duración y soporte `Range` (streaming en `<video>`). |
| Ollama opcional (perfil `llm`) | El análisis semántico funciona sin LLM con un analizador léxico/heurístico; el LLM mejora la calidad cuando hay recursos. |
| Prisma 6, NestJS 11, Next.js 16, TypeScript 5.9 | Versiones estables y mantenidas, evitando *majors* recién publicados. |

## 3. Protocolo de colas (Node ↔ Python)

BullMQ guarda los trabajos en Redis con una estructura que la librería oficial `bullmq` de Python (Taskforce.sh, misma organización) implementa de forma compatible: el productor es la API (Node `bullmq@5`) y los consumidores son los workers (Python `bullmq==3.4.6`). El protocolo se define explícitamente:

* **Prefijo** `clipmaster`, colas `capture`, `ai`, `render`.
* **jobId = `ProcessingJob.id`** (UUID en PostgreSQL) → BullMQ rechaza duplicados (idempotencia en encolado).
* **Payload**: JSON definido en `packages/shared/src/contracts.ts` y reflejado en `services/worker/clipmaster_worker/contracts.py` (Pydantic). Un fixture compartido (`packages/shared/fixtures/jobs.json`) se valida en ambos lados en las pruebas de contrato.
* **Opciones** puestas por la API: `attempts`, `backoff: exponential`, `removeOnComplete/Fail` con retención.
* **Retorno worker → API**: HTTP interno `POST /api/internal/...` con `Authorization: Bearer $INTERNAL_API_TOKEN`, sólo accesible en la red Docker (las rutas `/api/internal` son rechazadas si llegan con cabeceras de proxy `X-Forwarded-*`). Endpoints: progreso, segmento de live terminado, completado, fallido. Son **idempotentes**.
* Si el worker no logra notificar el resultado, el job falla y BullMQ lo reintenta; las salidas en el almacenamiento usan claves deterministas, por lo que repetir es seguro.
* **Cancelación**: la API marca la BD y escribe `clipmaster:cancel:<projectId>` en Redis; los workers lo consultan entre etapas y durante procesos FFmpeg largos (matan el proceso) y terminan con `UnrecoverableError`.
* **Capturador remoto** (`AGENT_PROVIDERS`, por defecto YouTube): esas importaciones no pasan por BullMQ. Quedan en `ProcessingJob` con `queue='capture-agent'` y etapa `waiting_agent`; un capturador las toma con `UPDATE … FOR UPDATE SKIP LOCKED`, mantiene un lease de 120 s en Redis con cada llamada, sube el MP4 por partes de 8 MiB a través de `/api/capture-agent` y termina con los mismos manejadores que los workers. Si el lease caduca, el reconciliador devuelve el trabajo a la cola (hasta `JOB_ATTEMPTS`). Ver `CAPTURADOR.md`.
* **Recuperación**: al iniciar y cada minuto, la API reconcilia `ProcessingJob` en `QUEUED/RUNNING` con el estado real de BullMQ (job perdido → reencolado; fallido → marcado y el proyecto se desbloquea).

## 4. Pipeline de IA (resumen; detalle en `AI_PIPELINE.md`)

1. Extracción de audio PCM 16 kHz mono (FFmpeg).
2. Transcripción faster-whisper con timestamps por palabra y VAD.
3. Señales de audio (RMS, picos, silencios, ráfagas de reacción).
4. Señales visuales (OpenCV: cambios de escena, movimiento, rostros) a baja resolución y fps configurables.
5. Señales semánticas (léxico ES/EN con expresiones dominicanas + LLM opcional con salida JSON validada).
6. Generación de candidatos alrededor de picos y unidades narrativas, ajuste de límites a frases/silencios, puntuación 0–100 con pesos por modo, supresión de duplicados.
7. Render FFmpeg: recorte, reencuadre seguido (cara/actividad), subtítulos ASS con resaltado por palabra, miniatura.

## 5. Datos

PostgreSQL contiene el estado; el almacenamiento S3 (RustFS, servicio `storage`) los binarios. Ver `apps/api/prisma/schema.prisma`. Claves de objeto: `<prefijo>/<userId>/<projectId>/<uuid>.<ext>` generadas por el servidor (sin rutas del usuario → sin traversal).

## 6. Tiempo real

Los workers reportan progreso → la API persiste `ProcessingEvent` y publica en Redis pub/sub → cada instancia API reenvía por **SSE** (`GET /api/events`) sólo a los usuarios propietarios.
