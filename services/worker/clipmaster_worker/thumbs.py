"""
Miniatura de un clip: un fotograma del video encuadrado sobre el sujeto (o una imagen de FLUX si el
usuario lo eligió) con un texto grande encima, al tamaño de cada red (1080×1920 vertical, 1280×720 YouTube).
El texto se compone con libass, igual que los subtítulos, para usar las mismas fuentes.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .context import JobContext
from .contracts import THUMBNAIL_SIZES, ThumbnailJobData, ThumbnailStyle
from .media import MediaError, probe, run_ffmpeg
from .reframe import plan_crop, subject_track
from .storage import join_key
from .subtitles import _ass_color, _escape, _style_line

log = logging.getLogger(__name__)

SIZE_FACTOR = {"m": 0.075, "l": 0.095, "xl": 0.12}
# Un poco más de contraste y color: las miniaturas se ven pequeñas y en pantallas con brillo.
ENHANCE = "eq=contrast=1.08:saturation=1.15"


def build_thumbnail_ass(text: str, style: ThumbnailStyle, width: int, height: int) -> str:
    """ASS de un único evento (0–5 s) con el texto de la miniatura; vacío si no hay texto."""
    body = text.strip().upper() if style.uppercase else text.strip()
    size = max(24, int(min(width, height) * SIZE_FACTOR[style.size] * (1.25 if height > width else 1.0)))
    align = {"top": 8, "center": 5, "bottom": 2}[style.position]
    margin_v = int(height * (0.10 if height > width else 0.07)) if style.position != "center" else 0
    margin_lr = int(width * 0.06)
    text_c, stroke_c = _ass_color(style.textColor), _ass_color(style.strokeColor)
    if style.look == "box":
        line = _style_line("Thumb", style.font, size, text_c, text_c, stroke_c, stroke_c, -1, 3,
                           max(8.0, size * 0.18), 0, align, margin_lr, margin_v)
    else:
        line = _style_line("Thumb", style.font, size, text_c, text_c, stroke_c, "&H64000000", -1, 1,
                           max(3.0, size * 0.09), max(2.0, size * 0.05), align, margin_lr, margin_v)
    events = f"Dialogue: 0,0:00:00.00,0:00:05.00,Thumb,,0,0,0,,{_escape(body)}\n" if body else ""
    return (f"[Script Info]\nScriptType: v4.00+\nPlayResX: {width}\nPlayResY: {height}\nWrapStyle: 0\n"
            f"ScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
            "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
            f"MarginR, MarginV, Encoding\n{line}\n\n[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + events)


def _source_at(ctx: JobContext, job: ThumbnailJobData) -> tuple[str, float]:
    """Entrada FFmpeg que contiene `at` y el instante relativo dentro de ella."""
    for s in sorted(job.sources, key=lambda x: x.offsetSec):
        if s.offsetSec <= job.at < s.offsetSec + s.durationSec:
            return ctx.storage.input_url(s.key), job.at - s.offsetSec
    raise MediaError("El instante elegido está fuera del video")


def _frame(ctx: JobContext, job: ThumbnailJobData, width: int, height: int, out: Path) -> None:
    """Fotograma en `at`, recortado al formato de salida centrando el sujeto (rostro o movimiento)."""
    s = ctx.settings
    src, rel = _source_at(ctx, job)
    info = probe(src)
    if not info.has_video or not info.width or not info.height:
        raise MediaError("La fuente no tiene video")
    cx = cy = None
    mode = job.reframe.mode
    if mode == "manual" and job.reframe.manualX is not None:
        cx, cy = job.reframe.manualX, job.reframe.manualY
    elif mode == "auto":
        try:
            from .visual_signals import analyze_visual

            start = max(0.0, rel - 0.5)
            samples = analyze_visual(src, start=start, duration=1.0, fps=4.0, width=s.visual_width, faces=True,
                                     cancel=ctx.is_cancelled)
            track = subject_track(samples, clip_start=start)
            if track:
                # Muestra más cercana al instante elegido.
                t, cx, cy = min(track, key=lambda k: abs(k[0] - (rel - start)))
        except Exception as exc:  # noqa: BLE001 - sin sujeto, recorte central
            if exc.__class__.__name__ == "JobCancelled":
                raise
            log.warning("Detección de sujeto para la miniatura falló: %s", exc)
    plan = plan_crop(info.width, info.height, width, height, mode="manual" if cx is not None else "center", track=[],
                     manual_x=cx, manual_y=cy, max_upscale=10.0)
    vf = (f"crop={plan.crop_w}:{plan.crop_h}:{plan.x_expr}:{plan.y_expr},scale={width}:{height}:flags=lanczos,"
          f"setsar=1,{ENHANCE}")
    run_ffmpeg(["-ss", f"{rel:.3f}", "-i", src, "-frames:v", "1", "-vf", vf, "-q:v", "2", str(out)],
               cancel=ctx.is_cancelled, cwd=ctx.workdir)


def _ai_background(ctx: JobContext, job: ThumbnailJobData, width: int, height: int, out: Path) -> None:
    from .nvidia_media import NvidiaMediaError, cover_image

    if not (job.prompt or "").strip():
        raise ValueError("Describe la imagen de fondo para generarla con IA")
    raw = ctx.workdir / "thumb_ai.jpg"
    try:
        cover_image(ctx.settings, job.prompt.strip(), job.aspect, raw)
    except NvidiaMediaError as exc:
        raise ValueError(f"No se pudo generar el fondo con IA: {exc}") from exc
    # FLUX genera a 768×1344 / 1344×768: se escala cubriendo el formato final.
    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height},setsar=1"
    run_ffmpeg(["-i", str(raw), "-frames:v", "1", "-vf", vf, "-q:v", "2", str(out)], cancel=ctx.is_cancelled, cwd=ctx.workdir)


def _fonts(ctx: JobContext, job: ThumbnailJobData) -> str | None:
    if not job.fonts:
        return None
    folder = ctx.workdir / "fonts"
    folder.mkdir(exist_ok=True)
    for i, f in enumerate(job.fonts):
        ext = Path(f.key).suffix.lower() if Path(f.key).suffix.lower() in (".ttf", ".otf") else ".ttf"
        ctx.storage.download(f.key, folder / f"font{i}{ext}")
    return "fonts"


def run_thumbnail(ctx: JobContext, job: ThumbnailJobData) -> dict:
    width, height = THUMBNAIL_SIZES[job.aspect]
    bg = ctx.workdir / "thumb_bg.jpg"
    if job.background == "ai":
        _ai_background(ctx, job, width, height, bg)
    else:
        _frame(ctx, job, width, height, bg)

    out = ctx.workdir / "thumb.jpg"
    ass = build_thumbnail_ass(job.text, job.style, width, height)
    if "Dialogue:" in ass:
        (ctx.workdir / "thumb.ass").write_text(ass, encoding="utf-8")
        fonts = _fonts(ctx, job)
        vf = "ass=thumb.ass" + (f":fontsdir={fonts}" if fonts else "")
        run_ffmpeg(["-loop", "1", "-i", bg.name, "-frames:v", "1", "-vf", vf, "-q:v", "2", out.name],
                   cancel=ctx.is_cancelled, cwd=ctx.workdir)
    else:
        bg.replace(out)
    key = join_key(job.outputPrefix, f"custom-{job.clipId}-{job.jobId}.jpg")
    ctx.storage.upload(out, key, "image/jpeg")
    return {"key": key, "width": width, "height": height}
