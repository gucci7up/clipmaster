"""Render de clips con FFmpeg: recorte temporal, reencuadre, subtítulos ASS, MP4 H.264/AAC y miniatura.

Opcionalmente aplica funciones de IA de NVIDIA (mirada a cámara, iluminación, voz del gancho y portada);
si una falla, el clip se entrega sin ella y el resultado indica qué falló."""

from __future__ import annotations

import logging
from pathlib import Path

from . import nvidia_media as nv
from .context import JobContext
from .contracts import ASPECT_SIZES, RenderJobData, Word
from .devices import resolve_encoder
from .media import MediaError, concat_sources, probe, run_ffmpeg, thumbnail
from .reframe import plan_crop, subject_track
from .storage import join_key
from .subtitles import build_ass, map_to_timeline
from .visual_signals import analyze_visual

log = logging.getLogger(__name__)


def _render_input(ctx: JobContext, job: RenderJobData, start: float, end: float, tag: str = "") -> tuple[str, float]:
    """Entrada FFmpeg y su tiempo absoluto de inicio (descarga y concatena segmentos si el tramo cruza varios)."""
    sources = sorted(job.sources, key=lambda s: s.offsetSec)
    needed = [s for s in sources if s.offsetSec < end and s.offsetSec + s.durationSec > start]
    if not needed:
        raise MediaError("No hay fuente que cubra el rango del clip")
    if len(needed) == 1:
        return ctx.storage.input_url(needed[0].key), needed[0].offsetSec
    local = [str(ctx.storage.download(s.key, ctx.workdir / f"seg{tag}_{i}.mp4")) for i, s in enumerate(needed)]
    joined = concat_sources(local, ctx.workdir / f"joined{tag}.mp4", ctx.workdir, cancel=ctx.is_cancelled)
    return str(joined), needed[0].offsetSec


def encoder_args(encoder: str, preset: str, crf: int) -> list[str]:
    if encoder == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", str(crf + 3), "-b:v", "0", "-profile:v", "high"]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-profile:v", "high"]


def _fonts(ctx: JobContext, job: RenderJobData) -> str | None:
    """Descarga las fuentes propias del clip a una carpeta que libass consulta (`fontsdir`)."""
    if not job.fonts:
        return None
    folder = ctx.workdir / "fonts"
    folder.mkdir(exist_ok=True)
    for i, f in enumerate(job.fonts):
        ext = Path(f.key).suffix.lower() if Path(f.key).suffix.lower() in (".ttf", ".otf") else ".ttf"
        ctx.storage.download(f.key, folder / f"font{i}{ext}")
    return "fonts"


def _ai_video(ctx: JobContext, job: RenderJobData, src: str, rel_start: float, duration: float, tag: str,
              status: dict[str, dict]) -> str | None:
    """Aplica mirada a cámara y/o iluminación de NVIDIA al tramo. Devuelve el archivo procesado o None."""
    ai = job.ai
    if not ai or not (ai.eyeContact or ai.relight is not None):
        return None
    steps = []
    if ai.eyeContact:
        steps.append(("eyeContact", "Mirada a cámara (NVIDIA)", lambda p, o: nv.eye_contact(ctx.settings, p, o)))
    if ai.relight is not None:
        steps.append(("relight", "Iluminación IA (NVIDIA)", lambda p, o: nv.relight(ctx.settings, p, o, ai.relight)))
    # En clips combinados no se reintenta en los demás tramos un efecto que ya falló.
    steps = [st for st in steps if status.get(st[0], {}).get("status") != "failed"]
    if not steps:
        return None
    fps = probe(src).fps or 30.0
    current = nv.prepare_segment(src, rel_start, duration, ctx.workdir / f"ai_in{tag}.mp4", fps=fps, cancel=ctx.is_cancelled)
    changed = False
    for name, label, fn in steps:
        ctx.progress("render", None, label, force=True)
        try:
            if changed:  # la salida del efecto anterior puede ser VFR: se normaliza antes del siguiente
                current = nv.prepare_segment(str(current), 0.0, duration, ctx.workdir / f"ai_cfr_{name}{tag}.mp4", fps=fps,
                                             cancel=ctx.is_cancelled)
            processed = fn(current, ctx.workdir / f"ai_{name}{tag}.mp4")
            info = probe(str(processed))
            if not info.has_video or abs(info.duration - duration) > max(1.0, duration * 0.1):
                raise nv.NvidiaMediaError(f"{label}: duración inesperada ({info.duration:.1f}s)")
            current, changed = processed, True
            status[name] = {"status": "ok"}
        except Exception as exc:  # noqa: BLE001
            if exc.__class__.__name__ == "JobCancelled":
                raise
            log.warning("%s falló; el clip sigue sin el efecto: %s", label, exc)
            status[name] = {"status": "failed", "error": nv.wrap_media_error(exc)}
    return str(current) if changed else None


def _render_piece(ctx: JobContext, job: RenderJobData, start: float, end: float, out: Path, ass_name: str | None,
                  fonts_dir: str | None, encoder: str, lo: float, hi: float, tag: str = "",
                  status: dict[str, dict] | None = None, voice: Path | None = None) -> tuple[str, str]:
    """Corta [start, end] de la línea de tiempo del proyecto, lo reencuadra y quema los subtítulos."""
    s = ctx.settings
    src, origin = _render_input(ctx, job, start, end, tag)
    info = probe(src)
    if not info.has_video or not info.width or not info.height:
        raise MediaError("La fuente no tiene video")
    rel_start = max(0.0, start - origin)
    duration = end - start
    processed = _ai_video(ctx, job, src, rel_start, duration, tag, status if status is not None else {})
    if processed:
        src, rel_start = processed, 0.0
        info = probe(src)
    target_w, target_h = ASPECT_SIZES[job.aspect]

    # Trayectoria del sujeto para el reencuadre automático (sobre el propio tramo).
    track: list[tuple[float, float, float]] = []
    if job.track and not job.segments:
        track = [(k.t, k.x, k.y) for k in job.track]
    elif job.reframe.mode == "auto":
        ctx.progress("render", lo, "Detectando sujeto para el encuadre", force=True)
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
    if ass_name:
        # Rutas relativas con cwd=workdir: evita problemas de escape de rutas en el filtro.
        vf.append(f"ass={ass_name}" + (f":fontsdir={fonts_dir}" if fonts_dir else ""))
    vf.append("format=yuv420p")

    args = ["-ss", f"{rel_start:.3f}", "-t", f"{duration:.3f}", "-i", src]
    if voice:
        # Voz del gancho: se mezcla al inicio y el audio original baja mientras suena.
        voice_len = probe(str(voice)).duration or 0.0
        args += ["-i", str(voice)]
        vo = "[1:a]aresample=48000,adelay=150:all=1"
        audio = (f"[0:a]volume=0.3:enable='lt(t,{voice_len + 0.3:.2f})'[bg];{vo}[vo];"
                 "[bg][vo]amix=inputs=2:duration=first:normalize=0[a]"
                 if info.has_audio else f"{vo},apad[a]")
        args += ["-filter_complex", f"[0:v]{','.join(vf)}[v];{audio}", "-map", "[v]", "-map", "[a]"]
    else:
        args += ["-map", "0:v:0", "-map", "0:a:0?", "-vf", ",".join(vf)]
    args += [*encoder_args(encoder, s.render_preset, s.render_crf),
            "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000",
            "-movflags", "+faststart", "-avoid_negative_ts", "make_zero"]
    if voice:
        args += ["-t", f"{duration:.3f}"]
    if s.ffmpeg_threads:
        args += ["-threads", str(s.ffmpeg_threads)]
    args.append(str(out))
    progress = ctx.stage_progress("render", lo + (hi - lo) * 0.05, hi)
    try:
        run_ffmpeg(args, duration=duration, on_progress=progress, cancel=ctx.is_cancelled, cwd=ctx.workdir)
    except MediaError:
        if encoder == "libx264":
            raise
        log.warning("NVENC falló; reintentando con libx264")
        encoder = "libx264"
        idx = args.index("-c:v")
        args[idx:idx + len(encoder_args("h264_nvenc", "", 0))] = encoder_args("libx264", s.render_preset, s.render_crf)
        run_ffmpeg(args, duration=duration, on_progress=progress, cancel=ctx.is_cancelled, cwd=ctx.workdir)
    return encoder, plan.mode


def _out_size(job: RenderJobData, ctx: JobContext, start: float, end: float) -> tuple[int, int]:
    """Tamaño de salida del primer tramo (los subtítulos se componen a esa resolución)."""
    first = next((x for x in sorted(job.sources, key=lambda x: x.offsetSec) if x.offsetSec < end and x.offsetSec + x.durationSec > start), None)
    if first is None:
        raise MediaError("No hay fuente que cubra el rango del clip")
    info = probe(ctx.storage.input_url(first.key))
    target_w, target_h = ASPECT_SIZES[job.aspect]
    plan = plan_crop(info.width or target_w, info.height or target_h, target_w, target_h, mode="center", track=[],
                     manual_x=None, manual_y=None, max_upscale=ctx.settings.render_max_upscale)
    return plan.out_w, plan.out_h


def run_render(ctx: JobContext, job: RenderJobData) -> dict:
    s = ctx.settings
    pieces = [(g.start, g.end) for g in job.segments] if job.segments else [(job.start, job.end)]
    if any(b - a <= 0.5 for a, b in pieces):
        raise MediaError("Duración de clip inválida")
    duration = sum(b - a for a, b in pieces)
    out_w, out_h = _out_size(job, ctx, *pieces[0])
    fonts_dir = _fonts(ctx, job)

    # Subtítulos y título gancho sobre la línea de tiempo del clip resultante; cada tramo recibe su parte.
    words: list[Word] = map_to_timeline(job.subtitles.words, pieces) if job.subtitles.enabled else []
    hook = job.hook.text if job.hook else None
    want_ass = bool(words) or bool(hook)
    subtitle_key = None
    full_ass = "subs.ass"
    if want_ass:
        ass = build_ass(words, job.subtitles.style, out_w, out_h, s.subtitle_font, 0.0, duration,
                        hook=hook, hook_duration=job.hook.durationSec if job.hook else 3.0)
        (ctx.workdir / full_ass).write_text(ass, encoding="utf-8")
        subtitle_key = join_key(job.outputPrefix.replace("clips/", "subtitles/", 1), f"{job.renderId}.ass")

    ai_status: dict[str, dict] = {}
    voice = _hook_voice(ctx, job, hook, ai_status)

    encoder = resolve_encoder(s)
    out = ctx.workdir / "clip.mp4"
    reframe_mode = job.reframe.mode
    ctx.progress("render", 0.02, "Renderizando", force=True)
    with ctx.timed("render"):
        if len(pieces) == 1:
            encoder, reframe_mode = _render_piece(ctx, job, *pieces[0], out, full_ass if want_ass else None, fonts_dir, encoder,
                                                  0.0, 0.95, status=ai_status, voice=voice)
        else:
            parts: list[str] = []
            offset = 0.0
            for i, (a, b) in enumerate(pieces):
                ass_name = None
                if want_ass:
                    part_words = [Word(start=w.start - offset, end=w.end - offset, word=w.word) for w in words
                                  if w.start >= offset - 1e-6 and w.end <= offset + (b - a) + 1e-6]
                    ass = build_ass(part_words, job.subtitles.style, out_w, out_h, s.subtitle_font, 0.0, b - a,
                                    hook=hook if i == 0 else None, hook_duration=job.hook.durationSec if job.hook else 3.0)
                    ass_name = f"subs_{i}.ass"
                    (ctx.workdir / ass_name).write_text(ass, encoding="utf-8")
                part = ctx.workdir / f"part_{i}.mp4"
                lo = 0.95 * i / len(pieces)
                encoder, reframe_mode = _render_piece(ctx, job, a, b, part, ass_name, fonts_dir, encoder, lo,
                                                      0.95 * (i + 1) / len(pieces), tag=f"_{i}", status=ai_status,
                                                      voice=voice if i == 0 else None)
                parts.append(str(part))
                offset += b - a
            # Mismo códec, resolución y parámetros en todas las partes: se unen sin recodificar.
            concat_sources(parts, out, ctx.workdir, cancel=ctx.is_cancelled)

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
        ctx.storage.upload(ctx.workdir / full_ass, subtitle_key, "text/x-ssa")
    cover_key = _cover(ctx, job, ai_status)
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
        "reframe": reframe_mode,
        "coverKey": cover_key,
        "ai": ai_status or None,
    }


def _hook_voice(ctx: JobContext, job: RenderJobData, hook: str | None, status: dict[str, dict]) -> Path | None:
    """Locución del título gancho con la voz elegida (Magpie TTS). None si no se pidió o falló."""
    if not (job.ai and job.ai.hookVoice and hook):
        return None
    ctx.progress("render", None, "Generando voz del gancho (NVIDIA)", force=True)
    try:
        path = nv.synthesize(ctx.settings, hook, job.ai.hookVoice, ctx.workdir / "hook_voice.wav")
    except nv.NvidiaMediaError as exc:
        log.warning("Voz del gancho falló; el clip sigue sin ella: %s", exc)
        status["hookVoice"] = {"status": "failed", "error": nv.wrap_media_error(exc)}
        return None
    status["hookVoice"] = {"status": "ok"}
    return path


def _cover(ctx: JobContext, job: RenderJobData, status: dict[str, dict]) -> str | None:
    """Portada generada con FLUX.2 klein a partir del prompt del usuario. None si no se pidió o falló."""
    if not (job.ai and job.ai.coverPrompt):
        return None
    ctx.progress("render", 0.97, "Generando portada (NVIDIA)", force=True)
    try:
        path = nv.cover_image(ctx.settings, job.ai.coverPrompt, job.aspect, ctx.workdir / "cover.jpg")
    except nv.NvidiaMediaError as exc:
        log.warning("Portada IA falló: %s", exc)
        status["cover"] = {"status": "failed", "error": nv.wrap_media_error(exc)}
        return None
    key = join_key(job.outputPrefix.replace("clips/", "covers/", 1), f"{job.renderId}.jpg")
    ctx.storage.upload(path, key, "image/jpeg")
    status["cover"] = {"status": "ok"}
    return key
