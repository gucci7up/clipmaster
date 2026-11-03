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


def build_ass(words: list[Word], style: SubtitleStyle, width: int, height: int, font: str, clip_start: float, clip_end: float) -> str:
    """
    Genera un ASS con tiempos relativos al clip. Presets:
      tiktok  – bloque de pocas palabras con la palabra actual resaltada en otro color.
      karaoke – relleno progresivo por palabra (\\k).
      clean   – líneas simples sin resaltado.
    """
    scale = height / 1920 if height >= width else width / 1920
    font_size = max(18, int(style.fontSize * scale * (0.75 if style.preset == "clean" else 1)))
    outline = max(0.0, style.outlineWidth * scale)
    align = {"bottom": 2, "center": 5, "top": 8}[style.position]
    margin_v = int(height * (0.18 if style.position == "bottom" else 0.08)) if style.position != "center" else 0
    if style.position == "center" and height > width:
        align, margin_v = 2, int(height * 0.30)  # vertical: algo por debajo del centro, estilo Reels
    primary = _ass_color(style.primaryColor)
    highlight = _ass_color(style.highlightColor)
    outline_c = _ass_color(style.outlineColor)
    bold = -1 if style.preset != "clean" else 0

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{font_size},{primary if style.preset != 'karaoke' else highlight},{primary},{outline_c},&H80000000,{bold},0,0,0,100,100,0,0,1,{outline:.1f},{max(0.0, outline / 3):.1f},{align},{int(width * 0.06)},{int(width * 0.06)},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    rel = [
        Word(start=max(0.0, w.start - clip_start), end=min(clip_end, w.end) - clip_start, word=w.word.strip(), probability=w.probability)
        for w in words
        if w.end > clip_start and w.start < clip_end and w.word.strip()
    ]
    events: list[str] = []
    for ch in chunk_words(rel, style.maxWordsPerLine):
        texts = [(w.word.upper() if style.uppercase else w.word) for w in ch.words]
        end = ch.end + 0.15
        if style.preset == "clean":
            events.append(f"Dialogue: 0,{_ts_ass(ch.start)},{_ts_ass(end)},Default,,0,0,0,,{_escape(' '.join(texts))}")
        elif style.preset == "karaoke":
            parts = []
            for w, t in zip(ch.words, texts):
                dur_cs = max(1, int(round((w.end - w.start) * 100)))
                parts.append(f"{{\\k{dur_cs}}}{_escape(t)}")
            events.append(f"Dialogue: 0,{_ts_ass(ch.start)},{_ts_ass(end)},Default,,0,0,0,,{' '.join(parts)}")
        else:
            for i, w in enumerate(ch.words):
                w_end = ch.words[i + 1].start if i + 1 < len(ch.words) else end
                line = " ".join(
                    (f"{{\\c{highlight}\\fscx110\\fscy110}}{_escape(t)}{{\\c{primary}\\fscx100\\fscy100}}" if j == i else _escape(t))
                    for j, t in enumerate(texts)
                )
                events.append(f"Dialogue: 0,{_ts_ass(w.start if i else ch.start)},{_ts_ass(max(w_end, w.start + 0.05))},Default,,0,0,0,,{line}")
    return header + "\n".join(events) + "\n"
