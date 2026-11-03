"""
Adaptadores de plataformas basados en yt-dlp (VOD/metadatos) y Streamlink (directos).

Sólo se usan los extractores de la plataforma (allowed_extractors): el extractor genérico queda
desactivado, de modo que una URL no puede convertir a yt-dlp en un cliente HTTP arbitrario (SSRF).
No se usan cookies ni credenciales: el contenido privado, de suscriptores, con DRM o que exige
inicio de sesión se rechaza con un mensaje claro.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Callable, Optional

from ..media import JobCancelled
from .base import DownloadProgress, ProviderError, Validation

log = logging.getLogger(__name__)

_AUTH_HINTS = re.compile(r"sign in|log ?in|private|members-only|subscriber|premium|\bage\b|age-restricted|confirm your age")
# YouTube responde «Sign in to confirm you're not a bot» a las IPs de centros de datos: es un bloqueo
# de la plataforma, no contenido privado, así que se comprueba antes que las pistas de autenticación.
_BLOCK_HINTS = re.compile(r"not a bot|captcha|too many requests|http error 429|http error 403|cloudflare")
_DRM_HINTS = ("drm",)


def _friendly(exc: Exception) -> str:
    msg = str(exc).lower().replace("’", "'")
    log.warning("yt-dlp: %s", str(exc)[:500])
    if any(h in msg for h in _DRM_HINTS):
        return "El contenido está protegido con DRM y no puede procesarse."
    if _BLOCK_HINTS.search(msg):
        return ("La plataforma bloqueó el acceso desde este servidor (verificación anti-bot). "
                "Descarga tu video y súbelo como archivo.")
    if _AUTH_HINTS.search(msg):
        return "El contenido es privado o requiere iniciar sesión. Sube tu propia grabación."
    if "not currently live" in msg or "is offline" in msg or "not live" in msg:
        return "La transmisión no está en vivo en este momento."
    if "unavailable" in msg or "not available" in msg or "404" in msg:
        return "El video no está disponible."
    if "unsupported url" in msg:
        return "URL no compatible con este proveedor."
    return "No se pudo acceder al contenido."


class YtDlpProvider:
    def __init__(self, provider_id: str, extractors: list[str], supports_live: bool, live_via_streamlink: bool = True):
        self.id = provider_id
        self.extractors = extractors
        self.supports_live = supports_live
        self.live_via_streamlink = live_via_streamlink

    def _opts(self, extra: Optional[dict] = None) -> dict:
        opts = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "playlist_items": "1",
            "allowed_extractors": self.extractors,
            "socket_timeout": 20,
            "retries": 3,
            "extractor_retries": 2,
            "cachedir": False,
            "nocheckcertificate": False,
            "allow_unplayable_formats": False,
        }
        opts.update(extra or {})
        return opts

    def validate(self, url: str) -> Validation:
        import yt_dlp

        try:
            with yt_dlp.YoutubeDL(self._opts({"skip_download": True})) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as exc:  # noqa: BLE001 - yt-dlp lanza tipos variados
            return Validation(ok=False, provider=self.id, supports_live=self.supports_live, reason=_friendly(exc))
        if info.get("_type") == "playlist":
            entries = [e for e in (info.get("entries") or []) if e]
            if not entries:
                return Validation(False, self.id, reason="La URL es una lista sin videos accesibles.")
            info = entries[0]
        availability = info.get("availability")
        if availability in ("private", "premium_only", "subscriber_only", "needs_auth"):
            return Validation(False, self.id, reason="El contenido es privado o requiere suscripción/inicio de sesión.")
        if info.get("_has_drm") or any(f.get("has_drm") for f in info.get("formats") or []):
            return Validation(False, self.id, reason="El contenido está protegido con DRM y no puede procesarse.")
        live_status = info.get("live_status")
        is_live = bool(info.get("is_live")) or live_status == "is_live"
        if live_status in ("is_upcoming",):
            return Validation(False, self.id, reason="La transmisión aún no ha comenzado.")
        if is_live and not self.supports_live:
            return Validation(False, self.id, is_live=True, supports_live=False,
                              reason="Este proveedor no permite capturar directos. Descarga tu directo y súbelo.")
        return Validation(
            ok=True, provider=self.id, is_live=is_live, title=info.get("title"),
            duration_sec=float(info["duration"]) if info.get("duration") else None,
            thumbnail=info.get("thumbnail"), supports_live=self.supports_live,
        )

    def download(self, url: str, dest_dir: Path, *, max_bytes: int, max_duration: float,
                 progress: DownloadProgress, cancel: Callable[[], bool]) -> tuple[Path, Optional[str]]:
        import yt_dlp

        def hook(d: dict) -> None:
            if cancel():
                raise JobCancelled()
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                done = d.get("downloaded_bytes") or 0
                if total and total > max_bytes:
                    raise ProviderError("El archivo supera el tamaño máximo permitido")
                progress((done / total) if total else None, "Descargando")

        def match_filter(info: dict, *, incomplete: bool) -> Optional[str]:
            dur = info.get("duration")
            if dur and dur > max_duration:
                return f"El video dura {int(dur // 60)} min y supera el máximo permitido"
            if info.get("is_live"):
                return "Es una transmisión en vivo: usa la captura de directos"
            return None

        opts = self._opts({
            "outtmpl": str(dest_dir / "source.%(ext)s"),
            "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
            "merge_output_format": "mp4",
            "max_filesize": max_bytes,
            "progress_hooks": [hook],
            "match_filter": match_filter,
            "concurrent_fragment_downloads": 4,
        })
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except JobCancelled:
            raise
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            cause = exc
            while getattr(cause, "exc_info", None) and cause.exc_info and cause.exc_info[1] is not None:  # type: ignore[attr-defined]
                if isinstance(cause.exc_info[1], JobCancelled):  # type: ignore[attr-defined]
                    raise JobCancelled() from exc
                cause = cause.exc_info[1]  # type: ignore[attr-defined]
            raise ProviderError(_friendly(exc)) from exc
        files = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
        files = [f for f in files if not f.name.endswith((".part", ".ytdl"))]
        if not files:
            raise ProviderError("La descarga no produjo ningún archivo (¿excede la duración o tamaño máximo?)")
        return files[0], (info or {}).get("title")

    def open_live(self, url: str, quality: str):
        return open_streamlink(url, quality)


def open_streamlink(url: str, quality: str):
    """Abre el flujo del directo con Streamlink y devuelve (stream_fd, calidad elegida)."""
    from streamlink import Streamlink
    from streamlink.exceptions import NoPluginError, PluginError

    session = Streamlink()
    session.set_option("stream-timeout", 30)
    session.set_option("hls-live-edge", 3)
    try:
        streams = session.streams(url)
    except NoPluginError as exc:
        raise ProviderError("Streamlink no admite esta URL") from exc
    except PluginError as exc:
        raise ProviderError(_friendly(exc)) from exc
    if not streams:
        raise ProviderError("La transmisión no está en vivo en este momento.")
    for q in [x.strip() for x in quality.split(",") if x.strip()]:
        if q in streams:
            return streams[q].open(), q
    best = streams.get("best") or next(iter(streams.values()))
    return best.open(), "best"


def is_live_now(url: str) -> bool:
    from streamlink import Streamlink

    try:
        return bool(Streamlink().streams(url))
    except Exception:  # noqa: BLE001
        return False


YOUTUBE = YtDlpProvider("YOUTUBE", ["youtube", "YoutubeYtBe", "youtube:clip", "YoutubeLivestreamEmbed", "youtube:tab"], supports_live=True)
TWITCH = YtDlpProvider("TWITCH", ["twitch:stream", "twitch:vod", "twitch:clips"], supports_live=True)
KICK = YtDlpProvider("KICK", ["kick:live", "kick:vod", "kick:clip"], supports_live=True)
# Los directos de TikTok no se capturan (sin soporte estable ni API oficial para terceros).
TIKTOK = YtDlpProvider("TIKTOK", ["TikTok", "vm.tiktok"], supports_live=False)
