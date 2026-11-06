"""Reflejo en Pydantic de packages/shared/src/contracts.ts (validado con fixtures/jobs.json)."""

from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

QUEUE_PREFIX = "clipmaster"
QUEUE_CAPTURE = "capture"
QUEUE_AI = "ai"
QUEUE_RENDER = "render"
EVENTS_CHANNEL = "clipmaster:events"

AspectRatio = Literal["VERTICAL", "HORIZONTAL", "SQUARE"]
ContentMode = Literal["AUTO", "GAMING", "DOMINO", "PODCAST", "INTERVIEW", "REACTION", "HUMOR", "EDUCATION", "SPORTS", "CUSTOM"]
ProviderId = Literal["UPLOAD", "YOUTUBE", "TWITCH", "KICK", "TIKTOK", "DIRECT", "HLS"]

ASPECT_SIZES: dict[str, tuple[int, int]] = {
    "VERTICAL": (1080, 1920),
    "HORIZONTAL": (1920, 1080),
    "SQUARE": (1080, 1080),
}


def cancel_key(project_id: str) -> str:
    return f"clipmaster:cancel:{project_id}"


def stop_capture_key(capture_session_id: str) -> str:
    return f"clipmaster:stop:{capture_session_id}"


def heartbeat_key(role: str, worker_id: str) -> str:
    return f"clipmaster:worker:{role}:{worker_id}"


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


class MediaSource(_Model):
    key: str
    offsetSec: float
    durationSec: float


class Word(_Model):
    start: float
    end: float
    word: str
    probability: Optional[float] = None


class SubtitleStyle(_Model):
    preset: Literal["tiktok", "clean", "karaoke", "neon", "minimal", "podcast"] = "tiktok"
    # Familia instalada o `custom:<id>` (se resuelve con RenderJobData.fonts).
    font: str = "Montserrat"
    fontSize: int = 72
    primaryColor: str = "#FFFFFF"
    highlightColor: str = "#FFD400"
    outlineColor: str = "#000000"
    outlineWidth: float = 5
    position: Literal["bottom", "center", "top"] = "center"
    uppercase: bool = True
    maxWordsPerLine: int = 4


class CropKeyframe(_Model):
    t: float
    x: float
    y: float


class AnalyzeSettings(_Model):
    maxClips: int = Field(ge=1, le=50)
    minDuration: float = Field(ge=3)
    maxDuration: float = Field(ge=5)
    visualAnalysis: bool = True
    semanticLLM: bool = False
    visionLLM: bool = False
    weights: Optional[dict[str, float]] = None
    preference: Literal["balanced", "quality", "quantity"] = "balanced"


class UploadSource(_Model):
    type: Literal["upload"]
    storageKey: str


class UrlSource(_Model):
    type: Literal["url"]
    url: str
    provider: ProviderId


class ImportJobData(_Model):
    kind: Literal["import"]
    jobId: str
    projectId: str
    userId: str
    source: Union[UploadSource, UrlSource] = Field(discriminator="type")
    outputPrefix: str
    maxDurationSec: float


class LiveCaptureJobData(_Model):
    kind: Literal["live"]
    jobId: str
    projectId: str
    userId: str
    captureSessionId: str
    url: str
    provider: ProviderId
    segmentSeconds: int = 60
    maxDurationSec: float
    startIndex: int = 0
    startOffsetSec: float = 0
    outputPrefix: str


class Range(_Model):
    start: float
    end: float


class AnalyzeJobData(_Model):
    kind: Literal["analyze"]
    jobId: str
    projectId: str
    userId: str
    sources: list[MediaSource]
    window: Range
    focus: Range
    language: Optional[str] = None
    mode: ContentMode = "AUTO"
    settings: AnalyzeSettings
    outputPrefix: str
    segmentId: Optional[str] = None


class Subtitles(_Model):
    enabled: bool
    style: SubtitleStyle
    words: list[Word]


class Hook(_Model):
    text: str
    durationSec: float = 3.0


class FontRef(_Model):
    key: str
    family: str


class Segment(_Model):
    start: float
    end: float


class RenderAI(_Model):
    """Funciones de IA de NVIDIA para este render (opcionales; el usuario las activa en Ajustes)."""

    eyeContact: bool = False
    relight: Optional[int] = Field(default=None, ge=0, le=4)
    hookVoice: Optional[str] = Field(default=None, max_length=80, pattern=r"^Magpie-Multilingual\.ES-US\.[A-Za-z]+(\.[A-Za-z]+)?$")
    coverPrompt: Optional[str] = Field(default=None, max_length=600)


class Reframe(_Model):
    mode: Literal["auto", "center", "manual"] = "auto"
    manualX: Optional[float] = None
    manualY: Optional[float] = None


class RenderJobData(_Model):
    kind: Literal["render"]
    jobId: str
    projectId: str
    userId: str
    clipId: str
    renderId: str
    sources: list[MediaSource]
    start: float
    end: float
    aspect: AspectRatio
    subtitles: Subtitles
    hook: Optional[Hook] = None
    fonts: list[FontRef] = Field(default_factory=list)
    segments: Optional[list[Segment]] = None
    ai: Optional[RenderAI] = None
    reframe: Reframe
    track: Optional[list[CropKeyframe]] = None
    outputPrefix: str


class CopyJobData(_Model):
    kind: Literal["copy"]
    jobId: str
    projectId: str
    userId: str
    clipId: str
    text: str = Field(max_length=6000)
    title: str = Field(max_length=200)
    mode: ContentMode = "AUTO"
    language: Optional[str] = None


HEX = r"^#[0-9A-Fa-f]{6}$"


class ThumbnailStyle(_Model):
    font: str = Field(default="Bebas Neue", max_length=80)
    textColor: str = Field(default="#FFFFFF", pattern=HEX)
    strokeColor: str = Field(default="#000000", pattern=HEX)
    look: Literal["outline", "box"] = "outline"
    position: Literal["top", "center", "bottom"] = "bottom"
    size: Literal["m", "l", "xl"] = "l"
    uppercase: bool = True


THUMBNAIL_SIZES: dict[str, tuple[int, int]] = {"VERTICAL": (1080, 1920), "HORIZONTAL": (1280, 720), "SQUARE": (1080, 1080)}


class ThumbnailJobData(_Model):
    kind: Literal["thumbnail"]
    jobId: str
    projectId: str
    userId: str
    clipId: str
    sources: list[MediaSource]
    at: float = Field(ge=0)
    aspect: AspectRatio
    background: Literal["frame", "ai"] = "frame"
    prompt: Optional[str] = Field(default=None, max_length=600)
    text: str = Field(default="", max_length=120)
    style: ThumbnailStyle = Field(default_factory=ThumbnailStyle)
    fonts: list[FontRef] = Field(default_factory=list)
    reframe: Reframe = Field(default_factory=Reframe)
    outputPrefix: str


JobData = Union[ImportJobData, LiveCaptureJobData, AnalyzeJobData, RenderJobData, CopyJobData, ThumbnailJobData]

_BY_KIND = {
    "import": ImportJobData,
    "live": LiveCaptureJobData,
    "analyze": AnalyzeJobData,
    "render": RenderJobData,
    "copy": CopyJobData,
    "thumbnail": ThumbnailJobData,
}


def parse_job(data: dict) -> JobData:
    kind = data.get("kind")
    model = _BY_KIND.get(kind)  # type: ignore[arg-type]
    if model is None:
        raise ValueError(f"Tipo de job desconocido: {kind!r}")
    return model.model_validate(data)
