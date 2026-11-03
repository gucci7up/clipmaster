"""Configuración por variables de entorno (sin cambios de código para CPU/GPU)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_modes_file() -> Path:
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        candidate = parent / "packages" / "shared" / "config" / "modes.json"
        if candidate.exists():
            return candidate
        candidate = parent / "shared-config" / "modes.json"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("No se encontró packages/shared/config/modes.json")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    worker_role: Literal["capture", "ai", "render", "all"] = "all"
    worker_id: str = Field(default_factory=lambda: __import__("socket").gethostname())
    concurrency: int = 1
    job_lock_ms: int = 120_000
    http_port: int = 8000

    redis_url: str = "redis://localhost:6379"
    api_internal_url: str = "http://api:4000/api"
    internal_api_token: str = ""

    storage_backend: Literal["s3", "local"] = "s3"
    local_storage_dir: Path = Path("/data/storage")
    s3_endpoint: str = "http://minio:9000"
    s3_region: str = "us-east-1"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_bucket: str = "clipmaster"

    work_dir: Path = Path("/data/work")

    # Dispositivo: auto detecta CUDA y cae a CPU si no está disponible o falla.
    device: Literal["auto", "cpu", "cuda"] = "auto"
    cuda_device_index: int = 0
    whisper_model: str = "small"
    whisper_compute_type: str = "auto"
    whisper_beam_size: int = 1
    whisper_cpu_threads: int = 4
    whisper_models_dir: Path = Path("/models")
    whisper_vad: bool = True

    visual_fps: float = 2.0
    visual_width: int = 480
    visual_max_minutes: float = 240.0

    # LLM semántico opcional: "ollama" (local) o "nvidia" (API de build.nvidia.com, compatible con OpenAI).
    # NVIDIA sólo se usa si hay NVIDIA_API_KEY; envía fragmentos de transcripción fuera del servidor.
    llm_provider: Literal["ollama", "nvidia"] = "ollama"
    ollama_url: str = ""
    ollama_model: str = "qwen2.5:3b-instruct"
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = "nvidia/nemotron-3.5-lightning-30b-a3b"
    # Modelos con "razonamiento" (Nemotron 3.5, etc.): se desactiva para obtener sólo el JSON, más rápido
    # y con menos tokens. Ponlo a false si un modelo rechaza `chat_template_kwargs`.
    nvidia_disable_thinking: bool = True
    llm_timeout_sec: float = 60.0
    llm_max_candidates: int = 12

    render_encoder: Literal["auto", "libx264", "h264_nvenc"] = "auto"
    render_preset: str = "veryfast"
    render_crf: int = 20
    render_max_upscale: float = 1.5
    ffmpeg_threads: int = 0
    subtitle_font: str = "DejaVu Sans"

    import_max_height: int = 1080
    max_download_mb: int = 8192
    allow_private_networks: bool = False
    live_quality: str = "720p,720p60,best"
    live_max_reconnects: int = 6

    log_level: str = "INFO"

    @property
    def llm_label(self) -> str | None:
        """Proveedor LLM configurado (para el heartbeat), o None si no hay ninguno."""
        if self.llm_provider == "nvidia":
            return f"nvidia:{self.nvidia_model}" if self.nvidia_api_key else None
        return f"ollama:{self.ollama_model}" if self.ollama_url else None

    @property
    def modes(self) -> dict:
        return load_modes()


@lru_cache
def load_modes() -> dict:
    return json.loads(_find_modes_file().read_text(encoding="utf-8"))


@lru_cache
def get_settings() -> Settings:
    return Settings()
