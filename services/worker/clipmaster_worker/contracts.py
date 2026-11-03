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
    preset: Literal["tiktok", "clean", "karaoke"] = "tiktok"
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
    reframe: Reframe
    track: Optional[list[CropKeyframe]] = None
    outputPrefix: str


JobData = Union[ImportJobData, LiveCaptureJobData, AnalyzeJobData, RenderJobData]

_BY_KIND = {
    "import": ImportJobData,
    "live": LiveCaptureJobData,
    "analyze": AnalyzeJobData,
    "render": RenderJobData,
}


def parse_job(data: dict) -> JobData:
    kind = data.get("kind")
    model = _BY_KIND.get(kind)  # type: ignore[arg-type]
    if model is None:
        raise ValueError(f"Tipo de job desconocido: {kind!r}")
    return model.model_validate(data)
