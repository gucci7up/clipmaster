"""Importación de videos (subida o URL) y captura segmentada de transmisiones en vivo."""

from __future__ import annotations

import csv
import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from .context import JobContext
from .contracts import ImportJobData, LiveCaptureJobData
from .media import JobCancelled, MediaError, ffmpeg_bin, normalize_video, probe
from .providers import ProviderError, get_provider
from .storage import join_key
from .url_guard import UnsafeUrl, check_url

log = logging.getLogger(__name__)


def run_import(ctx: JobContext, job: ImportJobData) -> dict:
    s = ctx.settings
    title: Optional[str] = None
    if job.source.type == "upload":
        ctx.progress("import", None, "Leyendo archivo subido", force=True)
        src: str = ctx.storage.input_url(job.source.storageKey)
    else:
        provider = get_provider(job.source.provider)
        try:
            check_url(job.source.url, allow_private=s.allow_private_networks, resolve=job.source.provider in ("DIRECT", "HLS"))
        except UnsafeUrl as exc:
            raise ProviderError(f"URL no permitida: {exc}") from exc
        ctx.progress("validate", None, "Validando enlace", force=True)
        v = provider.validate(job.source.url)
        if not v.ok:
            raise ProviderError(v.reason or "La URL no se puede procesar")
        if v.is_live:
            raise ProviderError("La fuente está en vivo: crea el proyecto como captura de directo")
        ctx.progress("download", 0.0, "Descargando", force=True)
        with ctx.timed("download"):
            path, title = provider.download(
                job.source.url, ctx.workdir, max_bytes=s.max_download_mb * 1024 * 1024, max_duration=job.maxDurationSec,
                progress=lambda p, m: ctx.progress("download", p, m), cancel=ctx.is_cancelled,
            )
        title = title or v.title
        src = str(path)

    info = probe(src)
    if not info.has_video:
        raise MediaError("El archivo no contiene una pista de video")
    if info.duration < 2:
        raise MediaError("El video es demasiado corto")
    if info.duration > job.maxDurationSec:
        raise MediaError(f"El video dura {info.duration / 60:.0f} min y supera el máximo de {job.maxDurationSec / 60:.0f} min")

    ctx.progress("import", 0.0, "Preparando video", force=True)
    out = ctx.workdir / "original.mp4"
    with ctx.timed("normalize"):
        method = normalize_video(src, out, info, max_height=s.import_max_height, cancel=ctx.is_cancelled,
                                 on_progress=ctx.stage_progress("import"))
    final = probe(out)
    key = join_key(job.outputPrefix, f"{job.jobId}.mp4")
    size = ctx.storage.upload(out, key, "video/mp4")
    ctx.progress("import", 1.0, f"Video listo ({method})", force=True)
    return {"asset": {**final.to_contract(), "key": key, "sizeBytes": size}, "title": title, "normalize": method, "timings": ctx.timings}


# ------------------------------------------------------------------ directos


SegmentCallback = Callable[[int, Path, float, float], None]


class LiveRecorder:
    """
    Streamlink → FFmpeg (copy) → segmentos MP4 de N segundos. Cada segmento cerrado se entrega al
    callback (subida + aviso a la API) mientras la captura continúa. Reconecta ante cortes.
    """

    def __init__(self, ctx: JobContext, job: LiveCaptureJobData, on_segment: SegmentCallback, should_stop: Callable[[], bool]):
        self.ctx = ctx
        self.job = job
        self.on_segment = on_segment
        self.should_stop = should_stop
        self.index = job.startIndex
        self.offset = job.startOffsetSec

    def _ffmpeg(self, outdir: Path) -> subprocess.Popen:
        cmd = [
            ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0",
            "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", "-bsf:a", "aac_adtstoasc",
            "-f", "segment", "-segment_time", str(self.job.segmentSeconds), "-reset_timestamps", "1",
            "-segment_format", "mp4", "-segment_format_options", "movflags=+faststart",
            "-segment_list", str(outdir / "list.csv"), "-segment_list_type", "csv",
            str(outdir / "seg_%05d.mp4"),
        ]
        return subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def _watch(self, outdir: Path, done: threading.Event, base_offset: float) -> None:
        """Entrega segmentos a medida que FFmpeg los anota como cerrados en list.csv."""
        seen = 0
        listfile = outdir / "list.csv"
        while True:
            finished = done.is_set()
            if listfile.exists():
                with listfile.open(newline="", encoding="utf-8") as fh:
                    rows = list(csv.reader(fh))
                for row in rows[seen:]:
                    if len(row) < 3:
                        continue
                    name, start, end = row[0], float(row[1]), float(row[2])
                    path = outdir / name
                    if path.exists() and path.stat().st_size > 0 and end - start > 0.5:
                        self.on_segment(self.index, path, base_offset + start, end - start)
                        self.index += 1
                        self.offset = base_offset + end
                        path.unlink(missing_ok=True)
                seen = len(rows)
            if finished:
                return
            time.sleep(1)

    def record(self) -> dict:
        from .providers.platforms import is_live_now

        provider = get_provider(self.job.provider)
        reconnects = 0
        started = time.monotonic()
        ended = "stream_ended"
        while True:
            try:
                fd, quality = provider.open_live(self.job.url, self.ctx.settings.live_quality)
            except ProviderError as exc:
                if reconnects >= self.ctx.settings.live_max_reconnects or (self.index == self.job.startIndex and reconnects == 0):
                    if self.index > self.job.startIndex:
                        break
                    raise
                reconnects += 1
                self.ctx.progress("reconnecting", None, f"Reconectando ({reconnects}): {exc}", force=True)
                time.sleep(min(60, 5 * 2 ** reconnects))
                continue
            outdir = self.ctx.workdir / f"run_{reconnects}_{self.index}"
            outdir.mkdir(parents=True, exist_ok=True)
            proc = self._ffmpeg(outdir)
            done = threading.Event()
            watcher = threading.Thread(target=self._watch, args=(outdir, done, self.offset), daemon=True)
            watcher.start()
            self.ctx.progress("capture", None, f"Grabando directo ({quality})", force=True,
                              metrics={"segments": self.index, "capturedSec": round(self.offset, 1)})
            stream_error: Optional[str] = None
            try:
                while True:
                    if self.should_stop():
                        ended = "stopped"
                        break
                    if self.ctx.is_cancelled():
                        raise JobCancelled()
                    if time.monotonic() - started > self.job.maxDurationSec - self.job.startOffsetSec:
                        ended = "max_duration"
                        break
                    chunk = fd.read(256 * 1024)
                    if not chunk:
                        stream_error = "fin del flujo"
                        break
                    assert proc.stdin is not None
                    proc.stdin.write(chunk)
                    self.ctx.progress("capture", None, "Grabando directo",
                                      metrics={"segments": self.index, "capturedSec": round(self.offset, 1)})
            except (OSError, IOError) as exc:
                stream_error = str(exc)
            finally:
                try:
                    fd.close()
                except Exception:  # noqa: BLE001
                    pass
                if proc.stdin:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
                try:
                    proc.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    proc.kill()
                done.set()
                watcher.join(timeout=120)
            if ended in ("stopped", "max_duration"):
                break
            # Corte: ¿sigue en vivo? Reintento con backoff; si terminó, se cierra la captura.
            if reconnects >= self.ctx.settings.live_max_reconnects:
                ended = "error"
                break
            reconnects += 1
            self.ctx.progress("reconnecting", None, f"Conexión interrumpida ({stream_error}); reintentando", force=True)
            time.sleep(min(60, 5 * 2 ** reconnects))
            if not is_live_now(self.job.url if self.job.provider != "HLS" else f"hls://{self.job.url}"):
                ended = "stream_ended"
                break
        return {"segments": self.index - self.job.startIndex, "durationSec": round(self.offset, 3), "endedReason": ended,
                "reconnects": reconnects}


def run_live(ctx: JobContext, job: LiveCaptureJobData, notify_segment: Callable[[dict], None], should_stop: Callable[[], bool]) -> dict:
    def on_segment(index: int, path: Path, start: float, duration: float) -> None:
        key = join_key(job.outputPrefix, f"{job.captureSessionId}-{index:05d}.mp4")
        size = ctx.storage.upload(path, key, "video/mp4")
        notify_segment({"jobId": job.jobId, "index": index, "key": key, "startSec": round(start, 3),
                        "durationSec": round(duration, 3), "sizeBytes": size})

    return LiveRecorder(ctx, job, on_segment, should_stop).record()
