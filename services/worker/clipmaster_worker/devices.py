"""Detección de dispositivo (CUDA/CPU) y codificador de video, con caída segura a CPU."""

from __future__ import annotations

import logging
import subprocess
from functools import lru_cache

from .config import Settings
from .media import ffmpeg_bin

log = logging.getLogger(__name__)


@lru_cache
def cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:  # noqa: BLE001 - sin CUDA o librerías ausentes
        return 0


def resolve_device(settings: Settings) -> str:
    """'auto' usa CUDA sólo si CTranslate2 ve una GPU; si no, CPU."""
    if settings.device == "cpu":
        return "cpu"
    count = cuda_device_count()
    if count > settings.cuda_device_index:
        return "cuda"
    if settings.device == "cuda":
        log.warning("DEVICE=cuda pero no hay GPU CUDA visible; se usará CPU")
    return "cpu"


def resolve_compute_type(settings: Settings, device: str) -> str:
    """
    'auto' deja que CTranslate2 elija el tipo más rápido soportado por el dispositivo.
    Pascal (p. ej. GTX 1080 Ti, CC 6.1) no tiene FP16 eficiente: CTranslate2 elegirá int8/float32.
    """
    if settings.whisper_compute_type != "auto":
        return settings.whisper_compute_type
    return "auto" if device == "cuda" else "int8"


@lru_cache
def nvenc_available() -> bool:
    """Comprueba que FFmpeg tenga h264_nvenc y que realmente pueda codificar (driver + capacidad 'video')."""
    try:
        encoders = subprocess.run([ffmpeg_bin(), "-hide_banner", "-encoders"], capture_output=True, timeout=20).stdout.decode()
        if "h264_nvenc" not in encoders:
            return False
        test = subprocess.run(
            [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2",
             "-c:v", "h264_nvenc", "-f", "null", "-"],
            capture_output=True, timeout=30,
        )
        return test.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def resolve_encoder(settings: Settings) -> str:
    if settings.render_encoder == "libx264":
        return "libx264"
    if settings.render_encoder == "h264_nvenc":
        if nvenc_available():
            return "h264_nvenc"
        log.warning("RENDER_ENCODER=h264_nvenc no disponible; se usará libx264")
        return "libx264"
    return "h264_nvenc" if settings.device != "cpu" and nvenc_available() else "libx264"
