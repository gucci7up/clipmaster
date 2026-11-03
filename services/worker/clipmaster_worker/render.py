"""Render de clips con FFmpeg: recorte temporal, reencuadre, subtítulos ASS, MP4 H.264/AAC y miniatura."""

from __future__ import annotations

import logging
from pathlib import Path

from .context import JobContext
from .contracts import ASPECT_SIZES, RenderJobData
from .devices import resolve_encoder
from .media import MediaError, concat_sources, probe, run_ffmpeg, thumbnail
from .reframe import plan_crop, subject_track
from .storage import join_key
from .subtitles import build_ass
from .visual_signals import analyze_visual

log = logging.getLogger(__name__)


def _render_input(ctx: JobContext, job: RenderJobData) -> tuple[str, float]:
    """Entrada FFmpeg y su tiempo absoluto de inicio (descarga y concatena segmentos si el clip cruza varios)."""
    sources = sorted(job.sources, key=lambda s: s.offsetSec)
    needed = [s for s in sources if s.offsetSec < job.end and s.offsetSec + s.durationSec > job.start]
    if not needed:
        raise MediaError("No hay fuente que cubra el rango del clip")
    if len(needed) == 1:
        return ctx.storage.input_url(needed[0].key), needed[0].offsetSec
    local = [str(ctx.storage.download(s.key, ctx.workdir / f"seg_{i}.mp4")) for i, s in enumerate(needed)]
    joined = concat_sources(local, ctx.workdir / "joined.mp4", ctx.workdir, cancel=ctx.is_cancelled)
    return str(joined), needed[0].offsetSec


def encoder_args(encoder: str, preset: str, crf: int) -> list[str]:
    if encoder == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", str(crf + 3), "-b:v", "0", "-profile:v", "high"]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high"]


def run_render(ctx: JobContext, job: RenderJobData) -> dict:
    s = ctx.settings
    src, origin = _render_input(ctx, job)
    info = probe(src)
    if not info.has_video or not info.width or not info.height:
        raise MediaError("La fuente no tiene video")
    rel_start = max(0.0, job.start - origin)
    duration = job.end - job.start
    if duration <= 0.5:
        raise MediaError("Duración de clip inválida")
    target_w, target_h = ASPECT_SIZES[job.aspect]

    # Trayectoria del sujeto para el reencuadre automático (sobre el propio rango del clip).
    track: list[tuple[float, float, float]] = []
    if job.track:
        track = [(k.t, k.x, k.y) for k in job.track]
    elif job.reframe.mode == "auto":
        ctx.progress("render", 0.02, "Detectando sujeto para el encuadre", force=True)
        try:
            samples = analyze_visual(src, start=rel_start, duration=duration, fps=3.0, width=s.visual_width, faces=True,
                                     cancel=ctx.is_cancelled)
            track = subject_track(samples, clip_start=rel_start)
        except Exception as exc:  # noqa: BLE001
            if exc.__class__.__name__ == "JobCancelled":
                raise
            log.warning("Seguimiento falló, se usará recorte central: %s", exc)
    plan = plan_crop(info.width, info.height, target_w, target_h, mode=job.reframe.mode, track=track,
                     manual_x=job.reframe.manualX, manual_y=job.reframe.manualY, max_upscale=s.render_max_upscale)

    vf = [f"crop={plan.crop_w}:{plan.crop_h}:{plan.x_expr}:{plan.y_expr}",
          f"scale={plan.out_w}:{plan.out_h}:flags=lanczos", "setsar=1"]
    subtitle_key = None
    ass_name = "subs.ass"
    if job.subtitles.enabled and job.subtitles.words:
        ass = build_ass(job.subtitles.words, job.subtitles.style, plan.out_w, plan.out_h, s.subtitle_font, job.start, job.end)
        (ctx.workdir / ass_name).write_text(ass, encoding="utf-8")
        # Ruta relativa con cwd=workdir: evita problemas de escape de rutas en el filtro.
        vf.append(f"ass={ass_name}")
        subtitle_key = join_key(job.outputPrefix, f"{job.renderId}.ass")
    vf.append("format=yuv420p")

    encoder = resolve_encoder(s)
    out = ctx.workdir / "clip.mp4"
    args = ["-ss", f"{rel_start:.3f}", "-i", src, "-t", f"{duration:.3f}",
            "-map", "0:v:0", "-map", "0:a:0?", "-vf", ",".join(vf),
            *encoder_args(encoder, s.render_preset, s.render_crf),
            "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000",
            "-movflags", "+faststart", "-avoid_negative_ts", "make_zero"]
    if s.ffmpeg_threads:
        args += ["-threads", str(s.ffmpeg_threads)]
    args.append(str(out))
    ctx.progress("render", 0.05, "Renderizando", force=True)
    with ctx.timed("render"):
        try:
            run_ffmpeg(args, duration=duration, on_progress=ctx.stage_progress("render", 0.05, 0.95),
                       cancel=ctx.is_cancelled, cwd=ctx.workdir)
        except MediaError:
            if encoder == "libx264":
                raise
            log.warning("NVENC falló; reintentando con libx264")
            encoder = "libx264"
            idx = args.index("-c:v")
            args[idx:idx + len(encoder_args("h264_nvenc", "", 0))] = encoder_args("libx264", s.render_preset, s.render_crf)
            run_ffmpeg(args, duration=duration, on_progress=ctx.stage_progress("render", 0.05, 0.95),
                       cancel=ctx.is_cancelled, cwd=ctx.workdir)

    # Verificación del resultado: debe abrirse con FFprobe y tener la duración esperada.
    result = probe(out)
    if not result.has_video or abs(result.duration - duration) > max(1.0, duration * 0.05):
        raise MediaError(f"Render inválido: duración {result.duration:.2f}s, esperada {duration:.2f}s")

    thumb = ctx.workdir / "thumb.jpg"
    peak_rel = min(duration * 0.4, max(0.0, duration - 0.5))
    thumbnail(out, thumb, at=peak_rel)

    out_key = join_key(job.outputPrefix, f"{job.renderId}.mp4")
    thumb_key = join_key(job.outputPrefix.replace("clips/", "thumbnails/", 1), f"{job.renderId}.jpg")
    size = ctx.storage.upload(out, out_key, "video/mp4")
    ctx.storage.upload(thumb, thumb_key, "image/jpeg")
    if subtitle_key:
        ctx.storage.upload(ctx.workdir / ass_name, join_key(job.outputPrefix.replace("clips/", "subtitles/", 1), f"{job.renderId}.ass"), "text/x-ssa")
        subtitle_key = join_key(job.outputPrefix.replace("clips/", "subtitles/", 1), f"{job.renderId}.ass")
    ctx.progress("render", 1.0, "Clip listo", force=True)
    return {
        "outputKey": out_key,
        "thumbnailKey": thumb_key,
        "subtitleKey": subtitle_key,
        "durationSec": round(result.duration, 3),
        "width": result.width,
        "height": result.height,
        "sizeBytes": size,
        "encoder": encoder,
        "hasAudio": result.has_audio,
        "reframe": plan.mode,
    }
