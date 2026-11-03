"""
Generación y puntuación de momentos destacados (0–100).

1. Se combinan señales instantáneas (semántica, emoción, audio, visual) en una curva de interés.
2. Se buscan picos (no cortes fijos cada N segundos).
3. Para cada pico se eligen los límites mirando el contexto: inicio en comienzo de frase o fin de
   silencio antes del pico (para incluir la preparación), final en cierre de frase o silencio después.
4. Cada candidato se puntúa con pesos configurables por modo (normalizados sobre las señales
   disponibles) y se suprimen duplicados.
La puntuación estima interés relativo dentro del video; no predice viralidad.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .audio_signals import AudioSignals
from .semantic import SegmentFeatures, best_sentence, make_title

INSTANT = ("semantic", "emotion", "audio", "visual")
CONNECTORS = ("y ", "pero ", "o ", "que ", "and ", "but ", "so ", "because ", "porque ")


@dataclass
class Signals:
    step: float
    origin: float  # tiempo absoluto de la celda 0
    audio: AudioSignals
    visual: Optional[dict[str, np.ndarray]] = None
    semantic: Optional[dict[str, np.ndarray]] = None
    feats: list[SegmentFeatures] = field(default_factory=list)
    segments: list[dict] = field(default_factory=list)

    @property
    def n(self) -> int:
        return self.audio.length


@dataclass
class ScoringConfig:
    weights: dict[str, float]
    min_duration: float
    max_duration: float
    max_candidates: int
    silence_penalty: float = 0.6
    preference: str = "balanced"


@dataclass
class Candidate:
    start: float
    end: float
    peak: float
    score: float
    components: dict[str, float]
    title: str
    reason: str
    text: str
    tags: list[str]
    starts_clean: bool = False
    ends_clean: bool = False

    def to_dict(self) -> dict:
        return {
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "peakTime": round(self.peak, 2),
            "score": round(self.score, 1),
            "title": self.title,
            "reason": self.reason,
            "text": self.text,
            "signals": {k: round(v, 3) for k, v in self.components.items()},
            "tags": self.tags,
        }


def _smooth(x: np.ndarray, sigma_cells: float) -> np.ndarray:
    if sigma_cells <= 0 or len(x) < 3:
        return x
    radius = int(3 * sigma_cells)
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma_cells) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(x, radius, mode="edge"), k, mode="valid")


def _dilate(x: np.ndarray, cells: int) -> np.ndarray:
    if cells <= 0:
        return x
    out = x.copy()
    for s in range(1, cells + 1):
        out[s:] = np.maximum(out[s:], x[:-s])
        out[:-s] = np.maximum(out[:-s], x[s:])
    return out


def channels(sig: Signals) -> dict[str, np.ndarray]:
    a = sig.audio
    n = sig.n
    ch: dict[str, np.ndarray] = {"audio": np.maximum(a.loud, 0.7 * a.onset)}
    verbal = sig.semantic["verbal_emotion"] if sig.semantic is not None else np.zeros(n)
    ch["emotion"] = np.maximum.reduce([a.burst, a.shout, verbal[:n]])
    if sig.semantic is not None and sig.semantic["speech"].any():
        ch["semantic"] = sig.semantic["semantic"][:n]
    if sig.visual is not None:
        v = sig.visual
        scene_near = _dilate(v["scene"][:n], int(1.0 / sig.step))
        ch["visual"] = np.clip(0.65 * v["motion"][:n] + 0.35 * scene_near, 0, 1)
    return ch


def available_weights(weights: dict[str, float], available: set[str]) -> dict[str, float]:
    """Renormaliza los pesos sobre las señales disponibles (p. ej. sin voz no hay semántica)."""
    w = {k: max(0.0, v) for k, v in weights.items() if k in available}
    total = sum(w.values())
    if total <= 0:
        return {k: 1 / len(available) for k in available} if available else {}
    return {k: v / total for k, v in w.items()}


def find_peaks(curve: np.ndarray, min_gap_cells: int, limit: int) -> list[int]:
    if len(curve) == 0:
        return []
    order = np.argsort(curve)[::-1]
    floor = float(np.percentile(curve, 50))
    picked: list[int] = []
    for idx in order:
        if curve[idx] <= floor and picked:
            break
        if all(abs(idx - p) >= min_gap_cells for p in picked):
            picked.append(int(idx))
        if len(picked) >= limit:
            break
    return picked


def _boundaries(sig: Signals) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Inicios/finales posibles con su bonificación (tiempo absoluto, bonus)."""
    starts: list[tuple[float, float]] = []
    ends: list[tuple[float, float]] = []
    for f in sig.feats:
        starts.append((f.start, 0.15))
        ends.append((f.end, 0.15 if f.terminal else 0.08))
    sil = sig.audio.silence
    for c in range(1, len(sil)):
        t = sig.origin + c * sig.step
        if sil[c - 1] > 0.5 and sil[c] < 0.5:
            starts.append((t, 0.10))
        if sil[c - 1] < 0.5 and sil[c] > 0.5:
            ends.append((t, 0.10))
    if sig.visual is not None:
        for c in np.nonzero(sig.visual["scene"][: sig.n] > 0.5)[0]:
            t = sig.origin + int(c) * sig.step
            starts.append((t, 0.06))
            ends.append((t, 0.06))
    # Rejilla de respaldo (cada 1 s) sin bonificación, para videos sin habla ni silencios claros.
    t0, t1 = sig.origin, sig.origin + sig.n * sig.step
    grid = np.arange(t0, t1 + 1e-6, 1.0)
    starts += [(float(t), 0.0) for t in grid]
    ends += [(float(t), 0.0) for t in grid]
    return starts, ends


def _inside_segment(sig: Signals, t: float) -> bool:
    """¿Cortar en t parte una frase por la mitad?"""
    return any(f.start + 0.25 < t < f.end - 0.25 for f in sig.feats)


def _cells(sig: Signals, a: float, b: float) -> slice:
    i = max(0, int(round((a - sig.origin) / sig.step)))
    j = min(sig.n, max(i + 1, int(round((b - sig.origin) / sig.step))))
    return slice(i, j)


def generate_candidates(sig: Signals, cfg: ScoringConfig, *, focus: tuple[float, float] | None = None) -> list[Candidate]:
    ch = channels(sig)
    inst_w = available_weights({k: cfg.weights.get(k, 0) for k in INSTANT}, set(ch))
    if not inst_w:
        return []
    interest = sum(inst_w[k] * ch[k] for k in inst_w)
    interest = _smooth(np.asarray(interest, dtype=np.float32), 2.0 / sig.step)
    peak_norm = float(interest.max()) or 1.0

    min_gap = max(1, int((cfg.min_duration / 2) / sig.step))
    peaks = find_peaks(interest, min_gap, limit=max(6, cfg.max_candidates * 4))
    starts, ends = _boundaries(sig)
    lo, hi = sig.origin, sig.origin + sig.n * sig.step
    silence = sig.audio.silence

    csum_i = np.concatenate([[0.0], np.cumsum(interest, dtype=np.float64)])
    csum_s = np.concatenate([[0.0], np.cumsum(silence, dtype=np.float64)])
    inside_cache: dict[float, bool] = {}
    seg_bounds = sorted((f.start, f.end) for f in sig.feats)
    seg_starts = np.array([a for a, _ in seg_bounds]) if seg_bounds else np.zeros(0)

    def inside(t: float) -> bool:
        if t not in inside_cache:
            i = int(np.searchsorted(seg_starts, t)) - 1
            inside_cache[t] = any(seg_bounds[k][0] + 0.25 < t < seg_bounds[k][1] - 0.25 for k in range(max(0, i - 2), min(len(seg_bounds), i + 2)))
        return inside_cache[t]

    def mean(cs: np.ndarray, a: float, b: float) -> float:
        sl = _cells(sig, a, b)
        return float((cs[sl.stop] - cs[sl.start]) / max(1, sl.stop - sl.start))

    out: list[Candidate] = []
    for p_idx in peaks:
        peak_t = sig.origin + p_idx * sig.step
        if focus and not (focus[0] <= peak_t < focus[1]):
            continue
        best: tuple[float, float, float, bool, bool] | None = None
        s_opts = sorted(
            {(round(t, 2), b) for t, b in starts if peak_t - 0.85 * cfg.max_duration <= t <= peak_t - 0.5 and t >= lo},
            key=lambda x: -x[1],
        )[:40]
        near_ends = sorted({(round(t, 2), b) for t, b in ends if peak_t + 1.0 <= t <= min(peak_t + cfg.max_duration, hi)}, key=lambda x: -x[1])
        mid = (cfg.min_duration + cfg.max_duration) / 2
        for s, sb in s_opts:
            clean_s = not inside(s)
            e_opts = [(t, b) for t, b in near_ends if s + cfg.min_duration <= t <= s + cfg.max_duration][:40]
            for e, eb in e_opts:
                content = mean(csum_i, s, e) / peak_norm
                pos = (peak_t - s) / max(1e-6, e - s)
                pos_bonus = 0.12 if 0.25 <= pos <= 0.85 else 0.0
                sil_frac = mean(csum_s, s, e)
                clean_e = not inside(e)
                dur_pen = 0.05 * abs((e - s) - mid) / max(1.0, cfg.max_duration - cfg.min_duration)
                q = content + sb + eb + pos_bonus - 0.4 * max(0.0, sil_frac - 0.2) - dur_pen
                q -= 0.0 if clean_s else 0.2
                q -= 0.0 if clean_e else 0.2
                if best is None or q > best[0]:
                    best = (q, s, e, clean_s, clean_e)
        if best is None:
            # Contexto insuficiente (p. ej. pico al principio): ventana centrada ajustada a los límites.
            d = cfg.min_duration
            s = max(lo, peak_t - 0.4 * d)
            e = min(hi, s + d)
            s = max(lo, e - d)
            if e - s < min(cfg.min_duration, hi - lo) - 0.01:
                continue
            best = (0.0, s, e, not _inside_segment(sig, s), not _inside_segment(sig, e))
        _, s, e, clean_s, clean_e = best
        out.append(score_window(sig, ch, cfg, s, e, peak_t, clean_s, clean_e))

    out.sort(key=lambda c: c.score, reverse=True)
    return dedupe(out)[: cfg.max_candidates]


def score_window(sig: Signals, ch: dict[str, np.ndarray], cfg: ScoringConfig, s: float, e: float, peak_t: float,
                 clean_s: bool, clean_e: bool, llm: Optional[dict] = None) -> Candidate:
    sl = _cells(sig, s, e)
    comp: dict[str, float] = {}
    if "semantic" in ch:
        vals = np.sort(ch["semantic"][sl])[::-1]
        top = vals[: max(1, int(len(vals) * 0.3))]
        comp["semantic"] = float(top.mean())
    comp["emotion"] = float(np.percentile(ch["emotion"][sl], 90))
    comp["audio"] = float(np.percentile(ch["audio"][sl], 90))
    if "visual" in ch:
        comp["visual"] = float(ch["visual"][sl].mean())

    feats_in = [f for f in sig.feats if f.end > s and f.start < e]
    speech = float(sig.semantic["speech"][sl].mean()) if sig.semantic is not None else 0.0
    pos = (peak_t - s) / max(1e-6, e - s)
    has_arc = any(f.story > 0 for f in feats_in) or any(f.conclusion > 0 for f in feats_in)
    ends_terminal = bool(feats_in) and feats_in[-1].terminal and clean_e
    comp["narrative"] = (0.3 if clean_s else 0) + (0.3 if (ends_terminal or (not feats_in and clean_e)) else 0) \
        + (0.2 if has_arc else 0) + (0.2 if 0.25 <= pos <= 0.85 else 0)
    first_text = feats_in[0].text.strip().lower() if feats_in else ""
    starts_connector = first_text.startswith(CONNECTORS)
    if feats_in:
        comp["standalone"] = min(1.0, 0.4 * min(1.0, speech / 0.5) + 0.3 * (0 if starts_connector else 1) + 0.3 * (1 if clean_s and clean_e else 0))
    else:
        comp["standalone"] = 0.6  # sin habla: depende de la acción visual/sonora
    if llm:
        if "semantic" in comp:
            comp["semantic"] = 0.4 * comp["semantic"] + 0.6 * llm["score"] / 100
        comp["standalone"] = 0.5 * comp["standalone"] + 0.5 * llm["standalone"]

    w = available_weights(cfg.weights, set(comp))
    raw = sum(w[k] * comp[k] for k in w)
    sil_frac = float(sig.audio.silence[sl].mean())
    raw *= 1 - cfg.silence_penalty * max(0.0, sil_frac - 0.3)
    score = float(np.clip(100 * raw, 0, 100))

    best = best_sentence(sig.feats, s, e)
    text = " ".join(f.text for f in feats_in)[:5000]
    tags = _tags(sig, ch, comp, feats_in, sl)
    title = llm["title"] if llm else (make_title(best.text) if best else _fallback_title(tags, peak_t))
    reason = llm["reason"] if llm else _reason(comp, tags, best.text if best else None)
    return Candidate(start=s, end=e, peak=peak_t, score=score, components=comp, title=title, reason=reason,
                     text=text, tags=tags, starts_clean=clean_s, ends_clean=clean_e)


def _tags(sig: Signals, ch: dict[str, np.ndarray], comp: dict[str, float], feats_in: list[SegmentFeatures], sl: slice) -> list[str]:
    tags: list[str] = []
    a = sig.audio
    if float(a.burst[sl].max(initial=0)) > 0.8 or any(f.humor > 0.3 for f in feats_in):
        tags.append("risas")
    if float(a.shout[sl].max(initial=0)) > 0.6:
        tags.append("voz_elevada")
    if float(a.loud[sl].max(initial=0)) > 0.8:
        tags.append("pico_audio")
    if sig.visual is not None and float(sig.visual["scene"][sl].max(initial=0)) > 0.5:
        tags.append("cambio_escena")
    if comp.get("visual", 0) > 0.5:
        tags.append("accion")
    if any(f.story > 0 for f in feats_in):
        tags.append("historia")
    if any(f.debate > 0 for f in feats_in):
        tags.append("discusion")
    if any(f.educational > 0.3 for f in feats_in):
        tags.append("explicacion")
    if any(f.domino > 0 for f in feats_in):
        tags.append("domino")
    if any(f.question for f in feats_in):
        tags.append("pregunta")
    return tags


_TAG_TEXT = {
    "risas": "posibles risas o vítores",
    "voz_elevada": "voz elevada",
    "pico_audio": "pico de volumen",
    "cambio_escena": "cambio de escena",
    "accion": "mucha actividad en pantalla",
    "historia": "una historia con desarrollo",
    "discusion": "una discusión",
    "explicacion": "una explicación útil",
    "domino": "comentarios de la partida",
}

_COMP_TEXT = {
    "semantic": "contenido verbal destacado",
    "emotion": "reacción emocional intensa",
    "audio": "energía sonora alta",
    "visual": "actividad visual",
    "narrative": "inicio y cierre coherentes",
    "standalone": "se entiende sin contexto",
}


def _reason(comp: dict[str, float], tags: list[str], quote: Optional[str]) -> str:
    top = sorted(comp.items(), key=lambda kv: kv[1], reverse=True)[:2]
    parts = [_COMP_TEXT[k] for k, v in top if v > 0.2]
    parts += [_TAG_TEXT[t] for t in tags if t in _TAG_TEXT][:2]
    seen: list[str] = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    text = ("Destaca por " + ", ".join(seen)) if seen else "Fragmento con mayor interés relativo del video"
    if quote:
        q = quote.strip()
        text += f'. Frase clave: "{q[:120]}{"…" if len(q) > 120 else ""}"'
    return text


def _fallback_title(tags: list[str], t: float) -> str:
    stamp = f"{int(t // 60):02d}:{int(t % 60):02d}"
    if "risas" in tags:
        return f"Reacción con risas en {stamp}"
    if "voz_elevada" in tags or "pico_audio" in tags:
        return f"Momento intenso en {stamp}"
    if "accion" in tags or "cambio_escena" in tags:
        return f"Acción destacada en {stamp}"
    return f"Momento destacado en {stamp}"


def overlap(a: Candidate, b: Candidate) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    shorter = min(a.end - a.start, b.end - b.start)
    return inter / shorter if shorter > 0 else 0.0


def _jaccard(a: str, b: str) -> float:
    sa, sb = set(a.lower().split()), set(b.lower().split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def dedupe(cands: list[Candidate], max_overlap: float = 0.4, max_text_sim: float = 0.6) -> list[Candidate]:
    """Supresión de no máximos: evita clips casi idénticos (por tiempo o por texto)."""
    kept: list[Candidate] = []
    for c in sorted(cands, key=lambda x: x.score, reverse=True):
        if any(overlap(c, k) > max_overlap or (c.text and _jaccard(c.text, k.text) > max_text_sim) for k in kept):
            continue
        kept.append(c)
    return kept


def finite(x: float) -> float:
    return x if math.isfinite(x) else 0.0
