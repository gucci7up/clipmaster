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
    s3_endpoint: str = "http://storage:9000"
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
    # 0 = todos los núcleos disponibles.
    whisper_cpu_threads: int = 0
    # Inferencia por lotes de faster-whisper (segmentos de voz en paralelo); 0 = secuencial.
    whisper_batch_size: int = 8
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
    # Análisis con fotogramas (modelo de visión de NVIDIA): se usa si el usuario activa «análisis visual con IA».
    nvidia_vision_model: str = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"

    # Funciones de IA de NVIDIA para el render (opcionales; envían video, audio o texto a NVIDIA).
    # Los IDs son las funciones públicas de build.nvidia.com; se pueden cambiar si NVIDIA los rota.
    nvidia_grpc_target: str = "grpc.nvcf.nvidia.com:443"
    nvidia_eyecontact_function: str = "480bffcb-6fea-4571-9741-eb50212c9c0f"
    nvidia_relight_function: str = "253bc77f-2d6c-4b9d-86c6-c6fb0f9e239c"
    nvidia_tts_url: str = "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize"
    # Modelo de imagen para portadas y miniaturas con fondo IA:
    # - flux2-klein: FLUX.2 klein 4B, licencia Apache 2.0 (uso comercial libre). Predeterminado.
    # - flux1-dev: FLUX.1-dev, más realista, pero su licencia sólo permite usar el modelo sin fines comerciales
    #   (las imágenes sí pueden usarse comercialmente). Para cobrar por el servicio hace falta licencia de BFL.
    nvidia_image_model: Literal["flux2-klein", "flux1-dev"] = "flux2-klein"
    # Opcional: otro ID de función NVCF para el modelo elegido (si NVIDIA lo rota). Vacío = el conocido.
    nvidia_image_function: str = ""
    nvidia_media_timeout_sec: float = 300.0

    # Modelo local para recortar a la persona en miniaturas y portadas (se descarga si falta; ver segment.py).
    segmentation_model_path: str = "/opt/models/u2net_human_seg.onnx"

    render_encoder: Literal["auto", "libx264", "h264_nvenc"] = "auto"
    render_preset: str = "veryfast"
    render_crf: int = 20
    render_max_upscale: float = 1.5
    ffmpeg_threads: int = 0
    subtitle_font: str = "Montserrat"

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
    def ai_media(self) -> bool:
        """Efectos, voz y portadas de NVIDIA disponibles en este worker (hace falta la clave)."""
        return bool(self.nvidia_api_key)

    @property
    def modes(self) -> dict:
        return load_modes()


@lru_cache
def load_modes() -> dict:
    return json.loads(_find_modes_file().read_text(encoding="utf-8"))


@lru_cache
def get_settings() -> Settings:
    return Settings()
