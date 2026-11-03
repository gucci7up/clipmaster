"""Archivos de video por URL directa y fuentes HLS (.m3u8) públicas sin DRM."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit

import httpx

from ..config import get_settings
from ..media import JobCancelled, run_ffmpeg
from ..url_guard import UnsafeUrl, check_url
from .base import DownloadProgress, ProviderError, Validation

VIDEO_TYPES = ("video/", "application/octet-stream", "binary/octet-stream", "application/mp4")
MAX_REDIRECTS = 5


def _client() -> httpx.Client:
    return httpx.Client(follow_redirects=False, timeout=httpx.Timeout(20, read=60), headers={"User-Agent": "ClipMasterAI/0.1"})


def safe_request(client: httpx.Client, method: str, url: str, **kw) -> httpx.Response:
    """Sigue redirecciones manualmente validando cada destino contra SSRF."""
    allow_private = get_settings().allow_private_networks
    for _ in range(MAX_REDIRECTS + 1):
        try:
            check_url(url, allow_private=allow_private)
        except UnsafeUrl as exc:
            raise ProviderError(f"URL no permitida: {exc}") from exc
        req = client.build_request(method, url, **kw)
        resp = client.send(req, stream=True)
        if resp.is_redirect and "location" in resp.headers:
            resp.close()
            url = urljoin(url, resp.headers["location"])
            continue
        return resp
    raise ProviderError("Demasiadas redirecciones")


class DirectProvider:
    id = "DIRECT"
    supports_live = False

    def validate(self, url: str) -> Validation:
        with _client() as c:
            try:
                r = safe_request(c, "GET", url, headers={"Range": "bytes=0-1023"})
            except httpx.HTTPError as exc:
                return Validation(False, self.id, reason=f"No se pudo conectar: {exc.__class__.__name__}")
            except ProviderError as exc:
                return Validation(False, self.id, reason=str(exc))
            try:
                if r.status_code >= 400:
                    return Validation(False, self.id, reason=f"El servidor respondió {r.status_code}")
                ctype = r.headers.get("content-type", "").lower()
                if not any(ctype.startswith(t) for t in VIDEO_TYPES):
                    return Validation(False, self.id, reason="La URL no apunta a un archivo de video")
            finally:
                r.close()
        name = Path(urlsplit(url).path).name or "video"
        return Validation(True, self.id, title=name[:200])

    def download(self, url: str, dest_dir: Path, *, max_bytes: int, max_duration: float,
                 progress: DownloadProgress, cancel: Callable[[], bool]) -> tuple[Path, Optional[str]]:
        dest = dest_dir / "source.bin"
        with _client() as c:
            r = safe_request(c, "GET", url)
            try:
                if r.status_code >= 400:
                    raise ProviderError(f"El servidor respondió {r.status_code}")
                total = int(r.headers.get("content-length") or 0) or None
                if total and total > max_bytes:
                    raise ProviderError("El archivo supera el tamaño máximo permitido")
                done = 0
                with dest.open("wb") as fh:
                    for chunk in r.iter_bytes(1024 * 1024):
                        done += len(chunk)
                        if done > max_bytes:
                            raise ProviderError("El archivo supera el tamaño máximo permitido")
                        fh.write(chunk)
                        if cancel():
                            raise JobCancelled()
                        progress(done / total if total else None, "Descargando")
            finally:
                r.close()
        return dest, Path(urlsplit(url).path).name or None

    def open_live(self, url: str, quality: str):
        raise ProviderError("Las URLs directas no son transmisiones en vivo")


_DRM_KEY = re.compile(r"#EXT-X-(?:SESSION-)?KEY:.*(?:SAMPLE-AES|KEYFORMAT=\"(?!identity))", re.I)


class HlsProvider:
    id = "HLS"
    supports_live = True

    def _playlist(self, url: str) -> str:
        with _client() as c:
            r = safe_request(c, "GET", url)
            try:
                if r.status_code >= 400:
                    raise ProviderError(f"El servidor respondió {r.status_code}")
                body = r.read()[:2_000_000].decode("utf-8", errors="replace")
            finally:
                r.close()
        if not body.lstrip().startswith("#EXTM3U"):
            raise ProviderError("No es una lista HLS válida")
        if _DRM_KEY.search(body):
            raise ProviderError("La fuente HLS usa DRM y no puede procesarse")
        return body

    def validate(self, url: str) -> Validation:
        try:
            body = self._playlist(url)
            if "#EXT-X-STREAM-INF" in body:  # lista maestra → comprobamos la primera variante
                variant = next(line for line in body.splitlines() if line and not line.startswith("#"))
                body = self._playlist(urljoin(url, variant))
        except (ProviderError, httpx.HTTPError, StopIteration) as exc:
            return Validation(False, self.id, reason=str(exc) or "No se pudo leer la lista HLS")
        is_live = "#EXT-X-ENDLIST" not in body
        return Validation(True, self.id, is_live=is_live, title=Path(urlsplit(url).path).name, supports_live=True)

    def download(self, url: str, dest_dir: Path, *, max_bytes: int, max_duration: float,
                 progress: DownloadProgress, cancel: Callable[[], bool]) -> tuple[Path, Optional[str]]:
        self._playlist(url)
        dest = dest_dir / "source.mp4"
        run_ffmpeg(["-protocol_whitelist", "https,http,tls,tcp,crypto", "-i", url, "-t", str(max_duration),
                    "-c", "copy", "-bsf:a", "aac_adtstoasc", "-fs", str(max_bytes), str(dest)],
                   cancel=cancel, on_progress=lambda p: progress(p, "Descargando"), duration=None)
        return dest, Path(urlsplit(url).path).name

    def open_live(self, url: str, quality: str):
        from .platforms import open_streamlink

        return open_streamlink(f"hls://{url}", quality)
