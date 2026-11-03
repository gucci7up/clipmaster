"""Interfaz de proveedores: cada plataforma es un adaptador independiente registrado por id."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Protocol


@dataclass
class Validation:
    ok: bool
    provider: Optional[str]
    is_live: bool = False
    title: Optional[str] = None
    duration_sec: Optional[float] = None
    thumbnail: Optional[str] = None
    supports_live: bool = False
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "provider": self.provider,
            "isLive": self.is_live,
            "title": self.title,
            "durationSec": self.duration_sec,
            "thumbnail": self.thumbnail,
            "supportsLive": self.supports_live,
            "reason": self.reason,
        }


DownloadProgress = Callable[[Optional[float], str], None]


class ProviderError(Exception):
    """Error comprensible para el usuario (restricción del proveedor, privado, DRM…)."""


class Provider(Protocol):
    id: str
    supports_live: bool

    def validate(self, url: str) -> Validation: ...

    def download(self, url: str, dest_dir: Path, *, max_bytes: int, max_duration: float,
                  progress: DownloadProgress, cancel: Callable[[], bool]) -> tuple[Path, Optional[str]]: ...

    def open_live(self, url: str, quality: str):
        """Devuelve un objeto tipo archivo (read/close) con el flujo MPEG-TS del directo."""
        ...
