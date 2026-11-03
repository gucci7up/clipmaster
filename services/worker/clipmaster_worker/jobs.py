"""
Consumidor BullMQ (librería oficial `bullmq` para Python, compatible con la API Node).

Protocolo (ver docs/ARCHITECTURE.md §3):
  1. POST /internal/jobs/:id/start  → la API decide si procesar (idempotencia, cancelación) y,
     en directos, desde qué segmento reanudar.
  2. Progreso → /progress. Segmentos de directo → /captures/:id/segments.
  3. Resultado → /complete (si falla, se lanza excepción y BullMQ reintenta; salidas deterministas).
  4. Error → /fail con willRetry; cancelación o error de usuario → UnrecoverableError (sin reintento).
El trabajo pesado se ejecuta en un hilo para no bloquear la renovación de locks de BullMQ.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import redis

from .api_client import ApiClient
from .config import Settings
from .context import JobContext
from .contracts import (
    QUEUE_AI,
    QUEUE_CAPTURE,
    QUEUE_PREFIX,
    QUEUE_RENDER,
    AnalyzeJobData,
    ImportJobData,
    LiveCaptureJobData,
    RenderJobData,
    cancel_key,
    heartbeat_key,
    parse_job,
    stop_capture_key,
)
from .media import JobCancelled, MediaError
from .providers import ProviderError
from .storage import make_storage

log = logging.getLogger(__name__)

ROLE_QUEUES = {"capture": [QUEUE_CAPTURE], "ai": [QUEUE_AI], "render": [QUEUE_RENDER],
               "all": [QUEUE_CAPTURE, QUEUE_AI, QUEUE_RENDER]}

# Errores que no se arreglan reintentando: se informan al usuario directamente.
USER_ERRORS = (ProviderError, MediaError, ValueError)


class JobRunner:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.storage = make_storage(settings)
        self.api = ApiClient(settings.api_internal_url, settings.internal_api_token)
        self.redis = redis.Redis.from_url(settings.redis_url, decode_responses=True)
        self.busy = 0
        self.processed = 0

    def execute(self, data: dict, attempt: int, max_attempts: int) -> dict:
        """Ejecuta un job de forma síncrona (en un hilo). Devuelve el resultado o lanza excepción."""
        job = parse_job(data)
        start = self.api.start(job.jobId)
        if not start.get("proceed"):
            log.info("Job %s omitido: %s", job.jobId, start.get("reason"))
            return {"skipped": True, "reason": start.get("reason")}

        ctx = JobContext(
            job_id=job.jobId,
            project_id=job.projectId,
            settings=self.settings,
            storage=self.storage,
            report=lambda st, p, m, mt: self.api.progress(job.jobId, st, p, m, mt),
            is_cancelled=lambda: bool(self.redis.exists(cancel_key(job.projectId))),
        )
        t0 = time.monotonic()
        try:
            result = self._dispatch(ctx, job, start)
            result.setdefault("timings", ctx.timings)
            result["timings"]["total"] = round(time.monotonic() - t0, 3)
            self.api.complete(job.jobId, result)
            return result
        except JobCancelled:
            log.info("Job %s cancelado", job.jobId)
            raise
        except Exception as exc:
            user_error = isinstance(exc, USER_ERRORS)
            will_retry = not user_error and attempt + 1 < max_attempts
            log.exception("Job %s falló (intento %d/%d)", job.jobId, attempt + 1, max_attempts)
            try:
                self.api.fail(job.jobId, _message(exc), will_retry, attempt + 1)
            except Exception:  # noqa: BLE001 - el reconciliador de la API cubre este caso
                log.warning("No se pudo notificar el fallo de %s", job.jobId)
            raise
        finally:
            ctx.cleanup()

    def _dispatch(self, ctx: JobContext, job: Any, start: dict) -> dict:
        if isinstance(job, ImportJobData):
            from .capture import run_import

            return run_import(ctx, job)
        if isinstance(job, AnalyzeJobData):
            from .analysis import run_analysis

            return run_analysis(ctx, job)
        if isinstance(job, RenderJobData):
            from .render import run_render

            return run_render(ctx, job)
        if isinstance(job, LiveCaptureJobData):
            from .capture import run_live

            resume = start.get("resume") or {}
            job = job.model_copy(update={"startIndex": resume.get("startIndex", job.startIndex),
                                         "startOffsetSec": resume.get("startOffsetSec", job.startOffsetSec)})
            return run_live(
                ctx, job,
                notify_segment=lambda body: self.api.segment(job.captureSessionId, body),
                should_stop=lambda: bool(self.redis.exists(stop_capture_key(job.captureSessionId))),
            )
        raise ValueError("Job no soportado")

    def heartbeat(self, role: str, device: str) -> None:
        payload = {"role": role, "id": self.settings.worker_id, "device": device, "busy": self.busy,
                   "processed": self.processed, "model": self.settings.whisper_model,
                   "llm": self.settings.llm_label if role in ("ai", "all") else None,
                   "aiMedia": self.settings.ai_media if role in ("render", "all") else False, "at": int(time.time())}
        self.redis.set(heartbeat_key(role, self.settings.worker_id), json.dumps(payload), ex=60)


def _message(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return text[:1500]


async def run_workers(settings: Settings, runner: JobRunner) -> list:
    """Arranca un Worker BullMQ por cola del rol, con concurrencia y lock configurables."""
    from bullmq import Worker
    from bullmq.custom_errors import UnrecoverableError

    async def process(job, token):  # noqa: ANN001 - firma definida por bullmq
        attempts = int((job.opts or {}).get("attempts", 1))
        runner.busy += 1
        try:
            return await asyncio.to_thread(runner.execute, job.data, job.attemptsMade, attempts)
        except JobCancelled as exc:
            raise UnrecoverableError("Cancelado por el usuario") from exc
        except USER_ERRORS as exc:
            raise UnrecoverableError(_message(exc)) from exc
        finally:
            runner.busy -= 1
            runner.processed += 1

    workers = []
    for queue in ROLE_QUEUES[settings.worker_role]:
        lock = settings.job_lock_ms
        workers.append(Worker(queue, process, {
            "connection": settings.redis_url,
            "prefix": QUEUE_PREFIX,
            "concurrency": settings.concurrency,
            "lockDuration": lock,
            "stalledInterval": lock,
            "maxStalledCount": 2,
            "name": f"{settings.worker_role}-{settings.worker_id}",
        }))
        log.info("Escuchando cola %s (concurrencia %d)", queue, settings.concurrency)
    return workers
