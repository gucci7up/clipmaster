"""Subtítulos SRT (transcripción completa) y ASS (render con estilo TikTok/Reels y resaltado por palabra)."""

from __future__ import annotations

from dataclasses import dataclass

from .contracts import SubtitleStyle, Word


def _ts_srt(t: float) -> str:
    t = max(0.0, t)
    h, rem = divmod(int(t * 1000), 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_ass(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, rem = divmod(cs, 360_000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def build_srt(segments: list[dict], offset: float = 0.0) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        lines += [str(i), f"{_ts_srt(seg['start'] - offset)} --> {_ts_srt(seg['end'] - offset)}", seg["text"].strip(), ""]
    return "\n".join(lines)


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    """#RRGGBB → &HAABBGGRR (formato ASS)."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


@dataclass
class Chunk:
    words: list[Word]

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end


def chunk_words(words: list[Word], max_words: int, max_gap: float = 0.6, max_chars: int = 28) -> list[Chunk]:
    """Agrupa palabras en líneas cortas, cortando en pausas y signos de puntuación."""
    chunks: list[Chunk] = []
    cur: list[Word] = []
    for w in words:
        if cur:
            gap = w.start - cur[-1].end
            chars = sum(len(x.word) + 1 for x in cur) + len(w.word)
            if len(cur) >= max_words or gap > max_gap or chars > max_chars or cur[-1].word.endswith((".", "?", "!", ",")):
                chunks.append(Chunk(cur))
                cur = []
        cur.append(w)
    if cur:
        chunks.append(Chunk(cur))
    return chunks


def _style_line(name: str, font: str, size: int, primary: str, secondary: str, outline_c: str, back: str, bold: int,
                border_style: int, outline: float, shadow: float, align: int, margin_lr: int, margin_v: int) -> str:
    return (f"Style: {name},{font},{size},{primary},{secondary},{outline_c},{back},{bold},0,0,0,100,100,0,0,"
            f"{border_style},{outline:.1f},{shadow:.1f},{align},{margin_lr},{margin_lr},{margin_v},1")


def build_ass(words: list[Word], style: SubtitleStyle, width: int, height: int, font: str, clip_start: float, clip_end: float,
              hook: str | None = None, hook_duration: float = 3.0) -> str:
    """
    Genera un ASS con tiempos relativos al clip. Plantillas:
      tiktok  – bloque de pocas palabras con la palabra actual resaltada en otro color.
      karaoke – relleno progresivo por palabra (\\k).
      clean   – líneas simples sin resaltado.
      neon    – texto con brillo del color de resaltado y palabra activa iluminada.
      minimal – texto más pequeño, sin borde, con sombra suave.
      podcast – caja opaca detrás del texto y palabra activa resaltada.
    `hook` añade un título en la parte superior durante los primeros `hook_duration` segundos.
    """
    font = (style.font or "").strip() or font
    scale = height / 1920 if height >= width else width / 1920
    size_factor = {"clean": 0.75, "minimal": 0.7, "podcast": 0.8}.get(style.preset, 1.0)
    font_size = max(18, int(style.fontSize * scale * size_factor))
    outline = max(0.0, style.outlineWidth * scale)
    align = {"bottom": 2, "center": 5, "top": 8}[style.position]
    margin_v = int(height * (0.18 if style.position == "bottom" else 0.08)) if style.position != "center" else 0
    if style.position == "center" and height > width:
        align, margin_v = 2, int(height * 0.30)  # vertical: algo por debajo del centro, estilo Reels
    if hook and style.position == "top":
        margin_v += int(height * 0.12)  # deja sitio al título gancho
    primary = _ass_color(style.primaryColor)
    highlight = _ass_color(style.highlightColor)
    outline_c = _ass_color(style.outlineColor)
    bold = 0 if style.preset in ("clean", "minimal") else -1
    margin_lr = int(width * 0.06)

    if style.preset == "karaoke":
        line = _style_line("Default", font, font_size, highlight, primary, outline_c, "&H80000000", bold, 1, outline, outline / 3, align, margin_lr, margin_v)
    elif style.preset == "neon":
        line = _style_line("Default", font, font_size, primary, primary, highlight, "&H00000000", bold, 1, max(2.0, outline), 0, align, margin_lr, margin_v)
    elif style.preset == "minimal":
        line = _style_line("Default", font, font_size, primary, primary, outline_c, "&H96000000", bold, 1, 0, max(1.0, 3 * scale), align, margin_lr, margin_v)
    elif style.preset == "podcast":
        # BorderStyle 3: caja opaca con el color del borde (ligeramente transparente).
        line = _style_line("Default", font, font_size, primary, primary, _ass_color(style.outlineColor, 0x30), "&H00000000", bold, 3,
                           max(6.0, 14 * scale), 0, align, margin_lr, margin_v)
    else:
        line = _style_line("Default", font, font_size, primary, primary, outline_c, "&H80000000", bold, 1, outline, outline / 3, align, margin_lr, margin_v)
    hook_size = max(18, int(64 * scale))
    hook_line = _style_line("Hook", font, hook_size, "&H00111111", "&H00111111", "&H00FFFFFF", "&H00000000", -1, 3,
                            max(6.0, 18 * scale), 0, 8, int(width * 0.08), int(height * 0.07))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{line}
{hook_line}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rel = [
        Word(start=max(0.0, w.start - clip_start), end=min(clip_end, w.end) - clip_start, word=w.word.strip(), probability=w.probability)
        for w in words
        if w.end > clip_start and w.start < clip_end and w.word.strip()
    ]
    events: list[str] = []
    if hook and hook.strip():
        dur = max(1.0, min(hook_duration, clip_end - clip_start))
        events.append(f"Dialogue: 1,{_ts_ass(0)},{_ts_ass(dur)},Hook,,0,0,0,,{{\\fad(150,300)}}{_escape(hook.strip())}")
    glow = f"{{\\blur{max(2, int(6 * scale))}}}" if style.preset == "neon" else ""
    for ch in chunk_words(rel, style.maxWordsPerLine):
        texts = [(w.word.upper() if style.uppercase else w.word) for w in ch.words]
        end = ch.end + 0.15
        if style.preset in ("clean", "minimal"):
            events.append(f"Dialogue: 0,{_ts_ass(ch.start)},{_ts_ass(end)},Default,,0,0,0,,{_escape(' '.join(texts))}")
        elif style.preset == "karaoke":
            parts = []
            for w, t in zip(ch.words, texts):
                dur_cs = max(1, int(round((w.end - w.start) * 100)))
                parts.append(f"{{\\k{dur_cs}}}{_escape(t)}")
            events.append(f"Dialogue: 0,{_ts_ass(ch.start)},{_ts_ass(end)},Default,,0,0,0,,{' '.join(parts)}")
        else:
            grow = style.preset != "podcast"
            for i, w in enumerate(ch.words):
                w_end = ch.words[i + 1].start if i + 1 < len(ch.words) else end
                on = f"{{\\c{highlight}\\fscx110\\fscy110}}" if grow else f"{{\\c{highlight}}}"
                off = f"{{\\c{primary}\\fscx100\\fscy100}}" if grow else f"{{\\c{primary}}}"
                line_text = " ".join((f"{on}{_escape(t)}{off}" if j == i else _escape(t)) for j, t in enumerate(texts))
                events.append(f"Dialogue: 0,{_ts_ass(w.start if i else ch.start)},{_ts_ass(max(w_end, w.start + 0.05))},Default,,0,0,0,,{glow}{line_text}")
    return header + "\n".join(events) + "\n"


def map_to_timeline(words: list[Word], segments: list[tuple[float, float]]) -> list[Word]:
    """
    Clip combinado: pasa las palabras de la línea de tiempo del proyecto a la del clip resultante,
    donde los tramos van uno detrás de otro. Las palabras que cruzan un corte se recortan al tramo.
    """
    out: list[Word] = []
    offset = 0.0
    for a, b in segments:
        for w in words:
            if w.end > a and w.start < b:
                out.append(Word(start=offset + max(w.start, a) - a, end=offset + min(w.end, b) - a, word=w.word, probability=w.probability))
        offset += b - a
    return out
