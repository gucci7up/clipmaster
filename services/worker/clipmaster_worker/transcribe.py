"""Transcripción con faster-whisper (timestamps por palabra, VAD, detección de idioma)."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .config import Settings
from .devices import resolve_compute_type, resolve_device
from .media import CancelCheck, JobCancelled

log = logging.getLogger(__name__)

_lock = threading.Lock()
_models: dict[tuple[str, str, str], object] = {}

# Contexto inicial: mejora la puntuación y vocabulario en español coloquial/dominicano.
SPANISH_PROMPT = "Conversación en español, con expresiones dominicanas: vaina, klk, tiguere, chévere, diablo, mano."


@dataclass
class TranscriptResult:
    language: Optional[str]
    language_probability: Optional[float]
    duration: float
    segments: list[dict] = field(default_factory=list)
    device: str = "cpu"
    model: str = ""


def load_model(settings: Settings, force_cpu: bool = False):
    """Carga (una vez por proceso) el modelo; si CUDA falla al cargar, cae a CPU."""
    from faster_whisper import WhisperModel

    device = "cpu" if force_cpu else resolve_device(settings)
    compute = resolve_compute_type(settings, device) if device == "cuda" else (
        settings.whisper_compute_type if settings.whisper_compute_type != "auto" else "int8")
    key = (settings.whisper_model, device, compute)
    with _lock:
        if key in _models:
            return _models[key], device
        try:
            model = WhisperModel(
                settings.whisper_model,
                device=device,
                device_index=settings.cuda_device_index,
                compute_type=compute,
                cpu_threads=settings.whisper_cpu_threads,
                download_root=str(settings.whisper_models_dir),
            )
        except Exception as exc:  # noqa: BLE001
            if device == "cpu":
                raise
            log.warning("No se pudo cargar Whisper en CUDA (%s); usando CPU", exc)
            device, compute = "cpu", "int8"
            key = (settings.whisper_model, device, compute)
            model = WhisperModel(
                settings.whisper_model, device="cpu", compute_type="int8",
                cpu_threads=settings.whisper_cpu_threads, download_root=str(settings.whisper_models_dir),
            )
        _models[key] = model
        return model, device


def transcribe(audio: Path, settings: Settings, **kw) -> TranscriptResult:
    """Transcribe; si la GPU falla en ejecución (p. ej. cuDNN ausente o sin memoria), repite en CPU."""
    try:
        return _transcribe(audio, settings, **kw)
    except JobCancelled:
        raise
    except Exception as exc:  # noqa: BLE001
        if resolve_device(settings) != "cuda":
            raise
        log.warning("Transcripción en CUDA falló (%s); repitiendo en CPU", str(exc)[:200])
        return _transcribe(audio, settings, force_cpu=True, **kw)


def _transcribe(
    audio: Path,
    settings: Settings,
    *,
    language: Optional[str],
    duration: float,
    cancel: CancelCheck | None = None,
    on_progress: Callable[[float], None] | None = None,
    force_cpu: bool = False,
) -> TranscriptResult:
    model, device = load_model(settings, force_cpu=force_cpu)
    prompt = SPANISH_PROMPT if (language or "es").startswith("es") else None
    # Se pasa el PCM ya decodificado (float32 16 kHz): evita depender del decodificador PyAV de
    # faster-whisper, cuya API cambió en PyAV >= 19 (metadata_errors).
    from .audio_signals import read_wav

    samples = audio if not isinstance(audio, Path) else read_wav(audio)
    segments_iter, info = model.transcribe(  # type: ignore[attr-defined]
        samples,
        language=language or None,
        beam_size=settings.whisper_beam_size,
        word_timestamps=True,
        vad_filter=settings.whisper_vad,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,  # evita bucles de alucinación en audio largo
        initial_prompt=prompt,
    )
    out: list[dict] = []
    for i, seg in enumerate(segments_iter):
        if cancel and i % 5 == 0 and cancel():
            raise JobCancelled()
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(), "probability": round(w.probability, 3)}
            for w in (seg.words or [])
            if w.word.strip()
        ]
        text = seg.text.strip()
        # Descarta segmentos casi seguro sin voz (alucinaciones típicas en silencio/música).
        if not text or (seg.no_speech_prob > 0.8 and seg.avg_logprob < -1.0):
            continue
        out.append({
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": text,
            "words": words,
            "avgLogprob": round(seg.avg_logprob, 3),
            "noSpeechProb": round(seg.no_speech_prob, 3),
        })
        if on_progress and duration > 0:
            on_progress(min(1.0, seg.end / duration))
    out = resegment(out)
    return TranscriptResult(
        language=info.language,
        language_probability=round(float(info.language_probability), 3) if info.language_probability is not None else None,
        duration=float(info.duration),
        segments=out,
        device=device,
        model=settings.whisper_model,
    )


_TERMINAL = (".", "!", "?", "…")


def resegment(segments: list[dict], *, max_len: float = 12.0, pause: float = 0.7, min_words: int = 3) -> list[dict]:
    """
    Divide los segmentos de Whisper (a veces de 30 s) en frases usando los timestamps por palabra:
    corta en puntuación final, pausas largas o longitud máxima. Mejora límites de clips, títulos y subtítulos.
    """
    out: list[dict] = []
    for seg in segments:
        words = seg.get("words") or []
        if not words:
            out.append(seg)
            continue
        cur: list[dict] = []
        for i, w in enumerate(words):
            cur.append(w)
            nxt = words[i + 1] if i + 1 < len(words) else None
            gap = (nxt["start"] - w["end"]) if nxt else 0.0
            length = w["end"] - cur[0]["start"]
            if nxt is None or (len(cur) >= min_words and (w["word"].endswith(_TERMINAL) or gap > pause)) or length > max_len:
                out.append({
                    "start": cur[0]["start"],
                    "end": cur[-1]["end"],
                    "text": " ".join(x["word"] for x in cur).strip(),
                    "words": cur,
                    "avgLogprob": seg.get("avgLogprob"),
                    "noSpeechProb": seg.get("noSpeechProb"),
                })
                cur = []
    return out
