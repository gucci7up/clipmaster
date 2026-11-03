"""Utilidades FFmpeg/FFprobe. Siempre listas de argumentos: nunca se construyen comandos de shell."""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

log = logging.getLogger(__name__)

CancelCheck = Callable[[], bool]
ProgressFn = Callable[[float], None]


class JobCancelled(Exception):
    """El usuario canceló el proyecto."""


class MediaError(Exception):
    """Error de FFmpeg/FFprobe o de un archivo de medios inválido."""


def ffmpeg_bin() -> str:
    return shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_bin() -> str:
    return shutil.which("ffprobe") or "ffprobe"


@dataclass
class Probe:
    duration: float
    width: Optional[int]
    height: Optional[int]
    fps: Optional[float]
    has_video: bool
    has_audio: bool
    video_codec: Optional[str]
    audio_codec: Optional[str]
    container: Optional[str]
    rotation: int = 0

    def to_contract(self) -> dict:
        return {
            "durationSec": round(self.duration, 3),
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "hasVideo": self.has_video,
            "hasAudio": self.has_audio,
            "videoCodec": self.video_codec,
            "audioCodec": self.audio_codec,
            "container": self.container,
        }


def _fps(rate: str | None) -> Optional[float]:
    if not rate or rate in ("0/0", "0"):
        return None
    try:
        num, _, den = rate.partition("/")
        value = float(num) / float(den or 1)
        return round(value, 3) if value > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def probe(path_or_url: str | Path, timeout: float = 60) -> Probe:
    cmd = [
        ffprobe_bin(), "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path_or_url),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=timeout, check=True).stdout
    except subprocess.CalledProcessError as exc:
        raise MediaError(f"ffprobe no pudo leer el archivo: {exc.stderr.decode(errors='replace')[-400:]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise MediaError("ffprobe excedió el tiempo límite") from exc
    data = json.loads(out or b"{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    v = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(fmt.get("duration") or (v or {}).get("duration") or (a or {}).get("duration") or 0)
    rotation = 0
    if v:
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rotation = int(float(sd["rotation"])) % 360
        rotation = int(float(v.get("tags", {}).get("rotate", rotation))) % 360
    width, height = (v or {}).get("width"), (v or {}).get("height")
    if rotation in (90, 270) and width and height:
        width, height = height, width
    return Probe(
        duration=duration,
        width=width,
        height=height,
        fps=_fps((v or {}).get("avg_frame_rate")) or _fps((v or {}).get("r_frame_rate")),
        has_video=v is not None,
        has_audio=a is not None,
        video_codec=(v or {}).get("codec_name"),
        audio_codec=(a or {}).get("codec_name"),
        container=fmt.get("format_name"),
        rotation=rotation,
    )


def run_ffmpeg(
    args: Sequence[str],
    *,
    duration: float | None = None,
    on_progress: ProgressFn | None = None,
    cancel: CancelCheck | None = None,
    timeout: float | None = None,
    cwd: Path | None = None,
) -> None:
    """Ejecuta FFmpeg con progreso real (-progress) y cancelación cooperativa (mata el proceso)."""
    cmd = [ffmpeg_bin(), "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", *args]
    log.debug("ffmpeg %s", " ".join(cmd[1:]))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd)
    stderr_tail: list[str] = []

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for raw in proc.stderr:
            stderr_tail.append(raw.decode(errors="replace"))
            if len(stderr_tail) > 60:
                del stderr_tail[:20]

    t = threading.Thread(target=_drain_stderr, daemon=True)
    t.start()
    started = time.monotonic()
    last_cancel_check = 0.0
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode(errors="replace").strip()
            if on_progress and duration and line.startswith("out_time_us="):
                try:
                    us = int(line.split("=", 1)[1])
                    on_progress(max(0.0, min(1.0, us / 1e6 / duration)))
                except ValueError:
                    pass
            now = time.monotonic()
            if cancel and now - last_cancel_check > 2:
                last_cancel_check = now
                if cancel():
                    proc.kill()
                    raise JobCancelled()
            if timeout and now - started > timeout:
                proc.kill()
                raise MediaError("FFmpeg excedió el tiempo límite")
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        t.join(timeout=2)
    if proc.returncode != 0:
        raise MediaError(f"FFmpeg falló ({proc.returncode}): {''.join(stderr_tail)[-800:]}")


def extract_audio(src: str | Path, dest: Path, *, start: float | None = None, duration: float | None = None,
                  cancel: CancelCheck | None = None, on_progress: ProgressFn | None = None) -> Path:
    """PCM 16 kHz mono (formato nativo de Whisper y del análisis de audio)."""
    args: list[str] = []
    if start:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", str(src)]
    if duration:
        args += ["-t", f"{duration:.3f}"]
    args += ["-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dest)]
    run_ffmpeg(args, duration=duration, cancel=cancel, on_progress=on_progress)
    return dest


def concat_sources(paths: Sequence[str], dest: Path, workdir: Path, cancel: CancelCheck | None = None) -> Path:
    """Concatena segmentos (mismo códec) sin recodificar mediante el demuxer concat."""
    listfile = workdir / f"{dest.stem}.concat.txt"
    lines = []
    for p in paths:
        escaped = str(p).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    listfile.write_text("\n".join(lines) + "\n", encoding="utf-8")
    run_ffmpeg(["-f", "concat", "-safe", "0", "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
                "-i", str(listfile), "-c", "copy", "-movflags", "+faststart", str(dest)], cancel=cancel)
    return dest


def normalize_video(src: str | Path, dest: Path, info: Probe, *, max_height: int, cancel: CancelCheck | None,
                    on_progress: ProgressFn | None) -> str:
    """
    Garantiza un MP4 H.264/AAC con faststart (reproducción en navegador y seeks HTTP rápidos).
    Remuxa sin pérdida si ya es compatible; si no, recodifica limitando la altura.
    """
    compatible = (
        info.video_codec == "h264"
        and info.audio_codec in (None, "aac", "mp3")
        and (info.height or 0) <= max_height
        and info.rotation == 0
    )
    common = ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-movflags", "+faststart"]
    if compatible:
        run_ffmpeg(["-i", str(src), *common, "-c", "copy", str(dest)], duration=info.duration, cancel=cancel, on_progress=on_progress)
        return "remux"
    vf = f"scale=-2:'min({max_height},ih)'" if (info.height or 0) > max_height else "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    run_ffmpeg(
        ["-i", str(src), *common, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ac", "2", str(dest)],
        duration=info.duration, cancel=cancel, on_progress=on_progress,
    )
    return "transcode"


def thumbnail(src: Path, dest: Path, at: float, width: int = 540) -> Path:
    run_ffmpeg(["-ss", f"{max(0.0, at):.3f}", "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(dest)])
    return dest
