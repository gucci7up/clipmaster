"""
Proceso del worker: FastAPI (salud, info y validación interna de URLs) + consumidores BullMQ en el
mismo bucle asyncio.  Uso:  WORKER_ROLE=ai python -m clipmaster_worker.main
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import platform
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from . import __version__
from .config import get_settings
from .devices import cuda_device_count, nvenc_available, resolve_device
from .jobs import JobRunner, run_workers
from .log import setup_logging
from .media import ffmpeg_bin, ffprobe_bin

settings = get_settings()
setup_logging(settings.worker_role, settings.log_level)
log = logging.getLogger("clipmaster.worker")
state: dict = {"workers": [], "runner": None, "device": "cpu"}


async def _heartbeat_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(state["runner"].heartbeat, settings.worker_role, state["device"])
        except Exception as exc:  # noqa: BLE001
            log.warning("Heartbeat falló: %s", exc)
        await asyncio.sleep(20)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    state["device"] = resolve_device(settings) if settings.worker_role in ("ai", "all") else "cpu"
    runner = JobRunner(settings)
    state["runner"] = runner
    state["workers"] = await run_workers(settings, runner)
    hb = asyncio.create_task(_heartbeat_loop())
    log.info("Worker %s listo (rol=%s, dispositivo=%s)", settings.worker_id, settings.worker_role, state["device"])
    yield
    hb.cancel()
    await asyncio.gather(*(w.close() for w in state["workers"]), return_exceptions=True)


app = FastAPI(title="ClipMaster Worker", version=__version__, lifespan=lifespan)


def require_internal(authorization: str = Header(default="")) -> None:
    expected = f"Bearer {settings.internal_api_token}"
    if not settings.internal_api_token or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Token interno inválido")


@app.get("/health")
def health() -> dict:
    runner = state.get("runner")
    return {"ok": True, "role": settings.worker_role, "busy": runner.busy if runner else 0}


@app.get("/info", dependencies=[Depends(require_internal)])
def info() -> dict:
    return {
        "version": __version__,
        "role": settings.worker_role,
        "python": platform.python_version(),
        "device": state["device"],
        "cudaDevices": cuda_device_count(),
        "nvenc": nvenc_available() if settings.worker_role in ("render", "all") else None,
        "whisperModel": settings.whisper_model,
        "ffmpeg": ffmpeg_bin(),
        "ffprobe": ffprobe_bin(),
    }


class ValidateBody(BaseModel):
    url: str
    provider: str | None = None


@app.post("/validate", dependencies=[Depends(require_internal)])
def validate(body: ValidateBody) -> dict:
    """Validación real de una URL: anti-SSRF + adaptador del proveedor (yt-dlp / HLS / directo)."""
    from .providers import ProviderError, detect, get_provider
    from .providers.base import Validation
    from .url_guard import UnsafeUrl, check_url

    pid = detect(body.url)
    if not pid:
        return Validation(False, None, reason="URL no compatible").to_dict()
    try:
        check_url(body.url, allow_private=settings.allow_private_networks, resolve=pid in ("DIRECT", "HLS"))
    except UnsafeUrl as exc:
        return Validation(False, pid, reason=f"URL no permitida: {exc}").to_dict()
    try:
        return get_provider(pid).validate(body.url).to_dict()
    except ProviderError as exc:
        return Validation(False, pid, reason=str(exc)).to_dict()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.http_port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
