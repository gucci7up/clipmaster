"""
Capturador remoto: descarga desde una conexión normal (p. ej. el PC del usuario) los enlaces de
proveedores que bloquean las IPs de servidores (YouTube) y entrega el video al servidor.

Sólo hace conexiones salientes HTTPS a la API pública con un token de capturador; no necesita
Redis, el almacenamiento ni puertos abiertos. Ejecuta exactamente la misma importación que el
capture-worker (`run_import`: validación, descarga con yt-dlp, normalización con FFmpeg) y sube
el MP4 resultante por trozos.

    CLIPMASTER_SERVER=https://clips.ejemplo.com CLIPMASTER_AGENT_TOKEN=cma_... python -m clipmaster_worker.agent
"""

from __future__ import annotations

import logging
import math
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import httpx
from pydantic_settings import BaseSettings, SettingsConfigDict

from . import __version__
from .config import get_settings
from .context import JobContext
from .contracts import ImportJobData, parse_job
from .media import JobCancelled, MediaError
from .providers import ProviderError

log = logging.getLogger("clipmaster.agent")

USER_ERRORS = (ProviderError, MediaError, ValueError)
KEEPALIVE_SEC = 30
# Una descarga larga ocupa varias veces el tamaño del video (pistas separadas, mezcla, normalización).
MIN_FREE_GB = 20


class AgentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CLIPMASTER_", env_file=None, extra="ignore")

    server: str = ""
    agent_token: str = ""
    poll_sec: float = 5.0
    part_mb: int = 8
    # Carpeta de trabajo temporal; conviene un disco con espacio (por defecto, el TEMP del sistema).
    work_dir: str = ""


class AgentError(RuntimeError):
    pass


class AgentApi:
    """Cliente de /api/capture-agent con reintentos ante cortes de red y errores 5xx/429."""

    def __init__(self, server: str, token: str, client: Optional[httpx.Client] = None):
        base = server.rstrip("/")
        if not base.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise AgentError("CLIPMASTER_SERVER debe empezar por https://")
        self.base = f"{base}/api/capture-agent"
        self.client = client or httpx.Client(timeout=httpx.Timeout(60, connect=15))
        self.client.headers["Authorization"] = f"Bearer {token}"
        self.client.headers["User-Agent"] = f"clipmaster-agent/{__version__}"

    def _call(self, method: str, path: str, *, retries: int = 5, **kw: Any) -> Any:
        delay = 2.0
        for attempt in range(retries):
            try:
                r = self.client.request(method, f"{self.base}{path}", **kw)
                if r.status_code < 300:
                    return r.json() if r.content else None
                if r.status_code == 401:
                    raise AgentError("Token de capturador inválido o revocado. Crea uno nuevo en Administración.")
                if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                    raise AgentError(f"{method} {path} → {r.status_code}: {r.text[:300]}")
                log.warning("%s %s → %s, reintento %d", method, path, r.status_code, attempt + 1)
            except httpx.HTTPError as exc:
                log.warning("%s %s falló (%s), reintento %d", method, path, exc.__class__.__name__, attempt + 1)
            time.sleep(delay)
            delay = min(delay * 2, 30)
        raise AgentError(f"No se pudo contactar con el servidor ({path})")

    def hello(self) -> dict:
        return self._call("POST", "/hello") or {}

    def claim(self) -> Optional[dict]:
        return (self._call("POST", "/claim", retries=1) or {}).get("job")

    def start(self, job_id: str) -> dict:
        return self._call("POST", f"/jobs/{job_id}/start") or {}

    def progress(self, job_id: str, stage: Optional[str] = None, value: Optional[float] = None,
                 message: Optional[str] = None, metrics: Optional[dict] = None) -> bool:
        """Devuelve True si el usuario canceló el proyecto. Sin `stage` sólo renueva el lease."""
        body = {"stage": stage, "progress": value, "message": message, "metrics": metrics} if stage else {}
        return bool((self._call("POST", f"/jobs/{job_id}/progress", json=body, retries=2) or {}).get("cancelled"))

    def upload(self, job_id: str, src: Path, key: str, part_bytes: int,
               on_progress: Callable[[float], None] = lambda p: None) -> int:
        size = src.stat().st_size
        parts = max(1, math.ceil(size / part_bytes))
        self._call("POST", f"/jobs/{job_id}/upload/init", json={"key": key})
        with src.open("rb") as fh:
            for n in range(1, parts + 1):
                chunk = fh.read(part_bytes)
                self._call("PUT", f"/jobs/{job_id}/upload/parts/{n}", content=chunk,
                           headers={"Content-Type": "application/octet-stream"}, retries=6)
                on_progress(n / parts)
        return int((self._call("POST", f"/jobs/{job_id}/upload/finish", json={"parts": parts}) or {}).get("sizeBytes", size))

    def complete(self, job_id: str, result: dict) -> None:
        self._call("POST", f"/jobs/{job_id}/complete", json={"result": result})

    def fail(self, job_id: str, error: str, user_error: bool) -> None:
        self._call("POST", f"/jobs/{job_id}/fail", json={"error": error[:1500], "userError": user_error}, retries=3)


class RemoteStorage:
    """Almacenamiento visto desde el capturador: sólo puede subir la salida de su trabajo, vía la API."""

    def __init__(self, api: AgentApi, job_id: str, part_bytes: int, on_progress: Callable[[float], None]):
        self.api, self.job_id, self.part_bytes, self.on_progress = api, job_id, part_bytes, on_progress

    def upload(self, src: Path, key: str, content_type: str) -> int:
        return self.api.upload(self.job_id, Path(src), key, self.part_bytes, self.on_progress)

    def input_url(self, key: str, expires: int = 0) -> str:
        raise ValueError("El capturador remoto sólo procesa enlaces, no archivos subidos")

    def download(self, key: str, dest: Path) -> Path:
        raise ValueError("No disponible en el capturador remoto")

    def put_json(self, key: str, data: object) -> int:
        raise ValueError("No disponible en el capturador remoto")

    def size(self, key: str) -> int | None:
        return None

    def delete(self, key: str) -> None:
        return None


class Agent:
    def __init__(self, api: AgentApi, poll_sec: float = 5.0, part_mb: int = 8, work_dir: str = ""):
        self.api = api
        self.poll_sec = poll_sec
        self.part_bytes = part_mb * 1024 * 1024
        self.work_dir = Path(work_dir or tempfile.gettempdir())
        self.settings = get_settings()
        self.processed = 0

    def prepare_work_dir(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        # Restos de trabajos interrumpidos (Ctrl+C, apagado): se retoman desde cero, así que se borran.
        for stale in self.work_dir.glob("cm-agent-*"):
            shutil.rmtree(stale, ignore_errors=True)
        free_gb = shutil.disk_usage(self.work_dir).free / 1024 ** 3
        log.info("Carpeta de trabajo: %s (%.0f GB libres)", self.work_dir, free_gb)
        if free_gb < MIN_FREE_GB:
            log.warning("Quedan menos de %d GB libres en %s: los videos largos pueden no caber. "
                        "Usa CLIPMASTER_WORK_DIR para elegir otro disco.", MIN_FREE_GB, self.work_dir)

    def run_forever(self) -> None:
        self.prepare_work_dir()
        info = self.api.hello()
        log.info("Conectado como «%s». Esperando enlaces…", info.get("name", "capturador"))
        idle_since = time.monotonic()
        while True:
            try:
                job = self.api.claim()
            except AgentError as exc:
                if "Token" in str(exc):
                    raise
                log.warning("%s", exc)
                job = None
            if job:
                try:
                    self.run_job(job)
                except AgentError as exc:
                    # Lease perdido, servidor caído…: el servidor devolverá el trabajo a la cola.
                    if "Token" in str(exc):
                        raise
                    log.warning("%s", exc)
                idle_since = time.monotonic()
                continue
            if time.monotonic() - idle_since > 600:
                log.info("Sin trabajos pendientes; sigo esperando (%d procesados)", self.processed)
                idle_since = time.monotonic()
            time.sleep(self.poll_sec)

    def run_job(self, data: dict) -> None:
        job = parse_job(data)
        if not isinstance(job, ImportJobData) or job.source.type != "url":
            self.api.fail(str(data.get("jobId")), "El capturador sólo procesa enlaces", True)
            return
        log.info("Trabajo %s: %s", job.jobId, job.source.url)
        start = self.api.start(job.jobId)
        if not start.get("proceed"):
            log.info("Trabajo %s omitido: %s", job.jobId, start.get("reason"))
            return

        cancelled = threading.Event()
        done = threading.Event()

        def report(stage: str, value: Optional[float], message: Optional[str], metrics: Optional[dict]) -> None:
            if self.api.progress(job.jobId, stage, value, message, metrics):
                cancelled.set()

        def keepalive() -> None:
            # Renueva el lease aunque una etapa larga no informe progreso (p. ej. normalización sin duración).
            while not done.wait(KEEPALIVE_SEC):
                try:
                    if self.api.progress(job.jobId):
                        cancelled.set()
                except AgentError as exc:
                    log.warning("No se pudo renovar el trabajo: %s", exc)

        ctx = JobContext(job_id=job.jobId, project_id=job.projectId, settings=self.settings, storage=None,  # type: ignore[arg-type]
                         report=report, is_cancelled=cancelled.is_set,
                         workdir=Path(tempfile.mkdtemp(prefix="cm-agent-", dir=self.work_dir)))
        ctx.storage = RemoteStorage(self.api, job.jobId, self.part_bytes,  # type: ignore[assignment]
                                    lambda p: ctx.progress("import", p, f"Subiendo al servidor ({p * 100:.0f} %)"))
        threading.Thread(target=keepalive, daemon=True).start()
        t0 = time.monotonic()
        try:
            from .capture import run_import

            result = run_import(ctx, job)
            result.setdefault("timings", ctx.timings)
            result["timings"]["total"] = round(time.monotonic() - t0, 3)
            self.api.complete(job.jobId, result)
            self.processed += 1
            log.info("Trabajo %s entregado en %.0f s", job.jobId, time.monotonic() - t0)
        except JobCancelled:
            log.info("Trabajo %s cancelado por el usuario", job.jobId)
        except Exception as exc:  # noqa: BLE001 - se informa al servidor, que decide si reintenta
            user_error = isinstance(exc, USER_ERRORS)
            log.error("Trabajo %s falló: %s", job.jobId, exc, exc_info=not user_error)
            try:
                self.api.fail(job.jobId, str(exc).strip() or exc.__class__.__name__, user_error)
            except AgentError as err:
                log.warning("No se pudo informar el fallo (el servidor lo recuperará): %s", err)
        finally:
            done.set()
            ctx.cleanup()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = AgentSettings()
    if not cfg.server or not cfg.agent_token:
        log.error("Faltan CLIPMASTER_SERVER y/o CLIPMASTER_AGENT_TOKEN")
        return 2
    try:
        Agent(AgentApi(cfg.server, cfg.agent_token), cfg.poll_sec, cfg.part_mb, cfg.work_dir).run_forever()
    except KeyboardInterrupt:
        log.info("Capturador detenido")
    except AgentError as exc:
        log.error("%s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
