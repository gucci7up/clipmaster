"""Registro de proveedores. Para añadir una plataforma basta con registrar un nuevo adaptador."""

from __future__ import annotations

from urllib.parse import urlsplit

from .base import Provider, ProviderError, Validation
from .direct import DirectProvider, HlsProvider
from .platforms import KICK, TIKTOK, TWITCH, YOUTUBE

HOSTS: dict[str, tuple[str, ...]] = {
    "YOUTUBE": ("youtube.com", "youtu.be"),
    "TWITCH": ("twitch.tv",),
    "KICK": ("kick.com",),
    "TIKTOK": ("tiktok.com",),
}

REGISTRY: dict[str, Provider] = {
    "YOUTUBE": YOUTUBE,
    "TWITCH": TWITCH,
    "KICK": KICK,
    "TIKTOK": TIKTOK,
    "DIRECT": DirectProvider(),
    "HLS": HlsProvider(),
}


def detect(url: str) -> str | None:
    """Misma lógica que packages/shared/src/providers.ts (detectProvider)."""
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    for pid, hosts in HOSTS.items():
        if any(host == h or host.endswith("." + h) for h in hosts):
            return pid
    path = parts.path.lower()
    if path.endswith(".m3u8"):
        return "HLS"
    if path.endswith((".mp4", ".mov", ".m4v", ".webm", ".mkv")):
        return "DIRECT"
    return None


def get_provider(pid: str) -> Provider:
    try:
        return REGISTRY[pid]
    except KeyError as exc:
        raise ProviderError(f"Proveedor no soportado: {pid}") from exc


__all__ = ["REGISTRY", "detect", "get_provider", "Provider", "ProviderError", "Validation"]
