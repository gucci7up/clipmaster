"""
Miniatura o portada de un clip, al tamaño de cada red (1080×1920 vertical, 1280×720 YouTube, 1080×1080).

- Fotograma: el instante elegido, encuadrado sobre el sujeto, con un texto grande encima.
- Imagen de IA: un fondo de FLUX (NVIDIA) con el texto encima.
- Persona recortada (`cutout`): la persona del fotograma, recortada en local con U²-Net y con borde blanco, delante
  de un fondo (el mismo fotograma desenfocado y oscurecido, o una imagen de FLUX), con el título al lado (16:9, 1:1)
  o encima (9:16, 1:1).

El texto se compone con libass, igual que los subtítulos, para usar las mismas fuentes.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .context import JobContext
from .contracts import THUMBNAIL_SIZES, ThumbnailJobData, ThumbnailStyle
from .media import MediaError, probe, run_ffmpeg
from .reframe import plan_crop, subject_track
from .storage import join_key
from .subtitles import _ass_color, _escape

log = logging.getLogger(__name__)

SIZE_FACTOR = {"m": 0.075, "l": 0.095, "xl": 0.12}
# Un poco más de contraste y color: las miniaturas se ven pequeñas y en pantallas con brillo.
ENHANCE = "eq=contrast=1.08:saturation=1.15"
# Por debajo de esta fracción del fotograma no se considera que haya una persona.
MIN_PERSON_AREA = 0.01


def _layout(style: ThumbnailStyle, width: int, height: int) -> tuple[int, int, int, int]:
    """Alineación ASS y márgenes (izq., der., vertical) del texto sobre el fotograma completo."""
    align = {"top": 8, "center": 5, "bottom": 2}[style.position]
    margin_v = int(height * (0.10 if height > width else 0.07)) if style.position != "center" else 0
    margin_lr = int(width * 0.06)
    return align, margin_lr, margin_lr, margin_v


def build_thumbnail_ass(text: str, style: ThumbnailStyle, width: int, height: int,
                        layout: tuple[int, int, int, int] | None = None, boost: float = 1.0) -> str:
    """ASS de un único evento (0–5 s) con el texto de la miniatura; sin evento si no hay texto.
    `layout` = (alineación ASS, margen izq., margen der., margen vertical); por defecto según `style.position`.
    `boost` agranda el texto (con la persona recortada el título va al lado y puede ser más grande)."""
    body = text.strip().upper() if style.uppercase else text.strip()
    size = max(24, int(min(width, height) * SIZE_FACTOR[style.size] * (1.25 if height > width else 1.0) * boost))
    align, margin_l, margin_r, margin_v = layout or _layout(style, width, height)
    text_c, stroke_c = _ass_color(style.textColor), _ass_color(style.strokeColor)
    if style.look == "box":
        colors, border, outline, shadow = (text_c, text_c, stroke_c, stroke_c), 3, max(8.0, size * 0.18), 0.0
    else:
        colors, border, outline, shadow = (text_c, text_c, stroke_c, "&H64000000"), 1, max(3.0, size * 0.09), max(2.0, size * 0.05)
    line = (f"Style: Thumb,{style.font},{size},{','.join(colors)},-1,0,0,0,100,100,0,0,{border},{outline:.1f},"
            f"{shadow:.1f},{align},{margin_l},{margin_r},{margin_v},1")
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


def _ai_image(ctx: JobContext, job: ThumbnailJobData) -> Path:
    from .nvidia_media import NvidiaMediaError, cover_image

    if not (job.prompt or "").strip():
        raise ValueError("Describe la imagen de fondo para generarla con IA")
    raw = ctx.workdir / "thumb_ai.jpg"
    try:
        cover_image(ctx.settings, job.prompt.strip(), job.aspect, raw)
    except NvidiaMediaError as exc:
        raise ValueError(f"No se pudo generar el fondo con IA: {exc}") from exc
    return raw


def _ai_background(ctx: JobContext, job: ThumbnailJobData, width: int, height: int, out: Path) -> None:
    raw = _ai_image(ctx, job)
    # FLUX genera a 768×1344 / 1344×768: se escala cubriendo el formato final.
    vf = f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height},setsar=1"
    run_ffmpeg(["-i", str(raw), "-frames:v", "1", "-vf", vf, "-q:v", "2", str(out)], cancel=ctx.is_cancelled, cwd=ctx.workdir)


# ------------------------------------------------------------------ persona recortada


def _cover_fit(img: np.ndarray, width: int, height: int) -> np.ndarray:
    """Escala cubriendo width×height y recorta al centro."""
    import cv2

    h, w = img.shape[:2]
    scale = max(width / w, height / h)
    img = cv2.resize(img, (max(width, round(w * scale)), max(height, round(h * scale))), interpolation=cv2.INTER_AREA)
    y0, x0 = (img.shape[0] - height) // 2, (img.shape[1] - width) // 2
    return img[y0:y0 + height, x0:x0 + width]


def _full_frame(ctx: JobContext, job: ThumbnailJobData) -> np.ndarray:
    import cv2

    src, rel = _source_at(ctx, job)
    out = ctx.workdir / "thumb_full.png"
    run_ffmpeg(["-ss", f"{rel:.3f}", "-i", src, "-frames:v", "1", str(out)], cancel=ctx.is_cancelled, cwd=ctx.workdir)
    img = cv2.imread(str(out))
    if img is None:
        raise MediaError("No se pudo leer el fotograma")
    return img


def _cutout_box(aspect: str, width: int, height: int) -> tuple[float, float, str]:
    """Ancho y alto máximos de la persona (fracción del lienzo) y dónde se apoya."""
    if aspect == "VERTICAL":
        return 0.96, 0.64, "bottom-center"
    if aspect == "SQUARE":
        return 0.90, 0.62, "bottom-center"
    return 0.52, 0.94, "bottom-right"


def compose_cutout(frame: np.ndarray, mask: np.ndarray, background: np.ndarray, aspect: str, width: int,
                   height: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """
    Pone a la persona (máscara 0–1 del fotograma) con borde blanco y sombra sobre `background` (ya a width×height).
    Devuelve la imagen y el hueco libre para el texto como `layout` de build_thumbnail_ass.
    """
    import cv2

    ys, xs = np.where(mask > 0.5)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    person, alpha = frame[y0:y1, x0:x1], mask[y0:y1, x0:x1]
    max_w, max_h, anchor = _cutout_box(aspect, width, height)
    scale = min(width * max_w / person.shape[1], height * max_h / person.shape[0])
    pw, ph = max(1, round(person.shape[1] * scale)), max(1, round(person.shape[0] * scale))
    person = cv2.resize(person, (pw, ph), interpolation=cv2.INTER_LANCZOS4 if scale > 1 else cv2.INTER_AREA)
    alpha = cv2.resize(alpha, (pw, ph), interpolation=cv2.INTER_LINEAR)
    # Un poco más de contraste y color en la persona, como el fotograma completo.
    person = np.clip((person.astype(np.float32) - 128) * 1.06 + 128, 0, 255)
    hsv = cv2.cvtColor(person.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.12, 0, 255)
    person = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)

    margin = round(width * 0.03)
    ox = (width - pw) // 2 if anchor == "bottom-center" else width - pw - margin
    oy = height - ph  # apoyada abajo: el corte del fotograma coincide con el borde
    full = np.zeros((height, width), np.float32)
    layer = np.zeros((height, width, 3), np.float32)
    full[oy:oy + ph, ox:ox + pw] = alpha
    layer[oy:oy + ph, ox:ox + pw] = person

    canvas = background.astype(np.float32)
    hard = (full > 0.5).astype(np.uint8)
    thick = max(5, round(min(width, height) * 0.014)) * 2 + 1
    stroke = cv2.dilate(hard, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (thick, thick))).astype(np.float32)
    shadow = cv2.GaussianBlur(stroke, (0, 0), min(width, height) * 0.02) * 0.6
    canvas *= 1 - shadow[..., None]
    stroke = cv2.GaussianBlur(stroke, (0, 0), 1.2)
    canvas = canvas * (1 - stroke[..., None]) + 255 * stroke[..., None]
    a = cv2.GaussianBlur(full, (0, 0), 0.8)[..., None]
    canvas = canvas * (1 - a) + layer * a

    # Hueco para el texto: al lado de la persona (16:9) o encima (9:16, 1:1).
    side = round(width * 0.05)
    if anchor == "bottom-center":
        layout = (8, side, side, round(height * 0.06))
    else:
        layout = (4, side, max(side, width - ox + side // 2), 0)
    return np.clip(canvas, 0, 255).astype(np.uint8), layout


def _blurred_without_person(frame: np.ndarray, mask: np.ndarray, width: int, height: int) -> np.ndarray:
    """El mismo fotograma sin la persona (rellenada con lo que la rodea), desenfocado y oscurecido, para que la
    persona recortada y el texto destaquen sin un «fantasma» detrás."""
    import cv2

    h, w = frame.shape[:2]
    small_w = 320
    small_h = max(1, round(h * small_w / w))
    small = cv2.resize(frame, (small_w, small_h), interpolation=cv2.INTER_AREA)
    hole = cv2.resize((mask > 0.3).astype(np.uint8), (small_w, small_h), interpolation=cv2.INTER_NEAREST)
    hole = cv2.dilate(hole, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    clean = cv2.inpaint(small, hole, 9, cv2.INPAINT_TELEA)
    clean = cv2.resize(clean, (w, h), interpolation=cv2.INTER_CUBIC)
    return cv2.GaussianBlur(_cover_fit(clean, width, height), (0, 0), max(width, height) / 60) * 0.55


def _cutout(ctx: JobContext, job: ThumbnailJobData, width: int, height: int, out: Path) -> tuple[int, int, int, int]:
    import cv2

    from .segment import main_subject, person_mask

    frame = _full_frame(ctx, job)
    mask = main_subject(person_mask(ctx.settings, frame))
    if float((mask > 0.5).mean()) < MIN_PERSON_AREA:
        raise ValueError("No se ve a ninguna persona en ese fotograma: elige otro instante o usa el fotograma completo")
    if job.background == "ai":
        bg = _cover_fit(cv2.imread(str(_ai_image(ctx, job))), width, height).astype(np.float32) * 0.85
    else:
        bg = _blurred_without_person(frame, mask, width, height)
    image, layout = compose_cutout(frame, mask, bg.astype(np.uint8), job.aspect, width, height)
    cv2.imwrite(str(out), image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return layout


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
    layout = None
    if job.cutout:
        layout = _cutout(ctx, job, width, height, bg)
    elif job.background == "ai":
        _ai_background(ctx, job, width, height, bg)
    else:
        _frame(ctx, job, width, height, bg)

    out = ctx.workdir / "thumb.jpg"
    boost = 1.35 if layout is not None and job.aspect == "HORIZONTAL" else 1.0
    ass = build_thumbnail_ass(job.text, job.style, width, height, layout, boost)
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
