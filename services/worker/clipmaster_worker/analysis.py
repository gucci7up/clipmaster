"""Pipeline de análisis: audio → transcripción → señales → semántica/LLM → candidatos."""

from __future__ import annotations

import logging
from pathlib import Path

from . import audio_signals, scoring, semantic, transcribe, visual_signals
from .context import JobContext
from .contracts import AnalyzeJobData
from .media import concat_sources, extract_audio, probe
from .storage import join_key
from .subtitles import build_srt

log = logging.getLogger(__name__)


def resolve_input(ctx: JobContext, job: AnalyzeJobData) -> tuple[str, float]:
    """Devuelve (entrada para FFmpeg, tiempo absoluto del inicio de esa entrada)."""
    if len(job.sources) == 1:
        src = job.sources[0]
        return ctx.storage.input_url(src.key), src.offsetSec
    local = []
    for i, src in enumerate(sorted(job.sources, key=lambda s: s.offsetSec)):
        local.append(str(ctx.storage.download(src.key, ctx.workdir / f"src_{i}.mp4")))
    joined = concat_sources(local, ctx.workdir / "joined.mp4", ctx.workdir, cancel=ctx.is_cancelled)
    return str(joined), min(s.offsetSec for s in job.sources)


def mode_weights(job: AnalyzeJobData, modes: dict) -> tuple[dict[str, float], dict]:
    mode_cfg = modes["modes"].get(job.mode, modes["modes"]["AUTO"])
    weights = dict(mode_cfg["weights"])
    if job.settings.weights:
        weights.update({k: float(v) for k, v in job.settings.weights.items() if k in weights})
    return weights, mode_cfg


def run_analysis(ctx: JobContext, job: AnalyzeJobData) -> dict:
    s = ctx.settings
    modules: dict[str, str] = {}
    src, src_origin = resolve_input(ctx, job)
    win_start, win_end = job.window.start, job.window.end
    rel_start = max(0.0, win_start - src_origin)
    duration = max(0.1, win_end - win_start)

    # 1) Audio
    ctx.progress("audio", 0.0, "Extrayendo audio", force=True)
    info = probe(src)
    if not info.has_audio and not info.has_video:
        raise ValueError("El archivo no contiene pistas de audio ni de video")
    wav = ctx.workdir / "audio.wav"
    with ctx.timed("audio_extract"):
        if info.has_audio:
            extract_audio(src, wav, start=rel_start, duration=duration, cancel=ctx.is_cancelled,
                          on_progress=ctx.stage_progress("audio"))
    samples = audio_signals.read_wav(wav) if info.has_audio else None

    # 2) Transcripción
    segments: list[dict] = []
    language, lang_prob, device, model = job.language, None, "cpu", None
    if samples is not None and len(samples) > 16000:
        ctx.progress("transcribe", 0.0, "Transcribiendo", force=True)
        with ctx.timed("transcribe"):
            tr = transcribe.transcribe(wav, s, language=job.language, duration=duration, cancel=ctx.is_cancelled,
                                       on_progress=ctx.stage_progress("transcribe"))
        # Tiempos absolutos en la línea de tiempo del proyecto.
        for seg in tr.segments:
            seg["start"] = round(seg["start"] + win_start, 3)
            seg["end"] = round(seg["end"] + win_start, 3)
            for w in seg["words"]:
                w["start"] = round(w["start"] + win_start, 3)
                w["end"] = round(w["end"] + win_start, 3)
        segments = tr.segments
        language, lang_prob, device, model = tr.language, tr.language_probability, tr.device, tr.model
        modules["transcription"] = "ok"
    else:
        modules["transcription"] = "skipped"

    # 3) Señales de audio
    ctx.progress("audio_analysis", None, "Analizando audio", force=True)
    with ctx.timed("audio_analysis"):
        if samples is not None:
            asig = audio_signals.analyze_audio(samples)
            modules["audio"] = "ok"
        else:
            import numpy as np

            n = max(1, int(duration / audio_signals.STEP))
            z = np.zeros(n, dtype=np.float32)
            asig = audio_signals.AudioSignals(audio_signals.STEP, z, z, z, z, np.zeros(n, dtype=np.float32), z - 90)
            modules["audio"] = "skipped"
    n_cells = asig.length

    # 4) Señales visuales (configurables por modo y por recursos)
    vgrid = None
    if job.settings.visualAnalysis and info.has_video and duration / 60 <= s.visual_max_minutes:
        ctx.progress("visual_analysis", None, "Analizando video", force=True)
        try:
            with ctx.timed("visual_analysis"):
                vs = visual_signals.analyze_visual(src, start=rel_start, duration=duration, fps=s.visual_fps,
                                                   width=s.visual_width, faces=True, cancel=ctx.is_cancelled)
                vgrid = visual_signals.visual_grid(vs, n_cells, asig.step, win_start)
            modules["visual"] = "ok"
        except Exception as exc:  # noqa: BLE001 - el visual es opcional; se registra y se continúa
            if exc.__class__.__name__ == "JobCancelled":
                raise
            log.warning("Análisis visual falló: %s", exc)
            modules["visual"] = "failed"
    else:
        modules["visual"] = "skipped"

    # 5) Semántica
    ctx.progress("semantic", None, "Analizando contenido", force=True)
    with ctx.timed("semantic"):
        feats = semantic.segment_features(segments, job.mode)
        sgrid = semantic.semantic_grid(feats, n_cells, asig.step, win_start) if segments else None
    modules["semantic_lexical"] = "ok" if segments else "skipped"

    # 6) Candidatos
    ctx.progress("scoring", None, "Seleccionando momentos", force=True)
    weights, mode_cfg = mode_weights(job, s.modes)
    cfg = scoring.ScoringConfig(
        weights=weights,
        min_duration=job.settings.minDuration,
        max_duration=job.settings.maxDuration,
        max_candidates=max(job.settings.maxClips * 3, 6),
        silence_penalty=mode_cfg.get("silencePenalty", 0.6),
        preference=job.settings.preference,
    )
    sig = scoring.Signals(step=asig.step, origin=win_start, audio=asig, visual=vgrid, semantic=sgrid, feats=feats, segments=segments)
    with ctx.timed("scoring"):
        cands = scoring.generate_candidates(sig, cfg, focus=(job.focus.start, job.focus.end))

    # 7) LLM opcional sobre los mejores candidatos
    if job.settings.semanticLLM and segments and semantic.llm_available(s):
        with ctx.timed("llm"):
            cands, modules["semantic_llm"] = apply_llm(ctx, sig, cfg, cands, job.mode)
    else:
        modules["semantic_llm"] = "skipped" if not job.settings.semanticLLM else "unavailable"

    # 8) Persistencia de artefactos
    base = f"{job.jobId}"
    transcript_key = srt_key = None
    if segments:
        transcript_key = join_key(job.outputPrefix, f"{base}-transcript.json")
        ctx.storage.put_json(transcript_key, {"language": language, "segments": segments})
        srt_key = join_key(job.outputPrefix, f"{base}.srt")
        srt_path = ctx.workdir / "transcript.srt"
        srt_path.write_text(build_srt(segments), encoding="utf-8")
        ctx.storage.upload(srt_path, srt_key, "application/x-subrip")
    ctx.storage.put_json(join_key(job.outputPrefix, f"{base}-signals.json"), {
        "origin": win_start, "step": asig.step, "audio": asig.to_dict(),
        "visual": {k: v.round(3).tolist() for k, v in (vgrid or {}).items()},
    })

    return {
        "language": language,
        "languageProbability": lang_prob,
        "durationSec": round(duration, 3),
        "transcriptKey": transcript_key,
        "srtKey": srt_key,
        "segments": segments,
        "candidates": [c.to_dict() for c in cands],
        "timings": ctx.timings,
        "modules": modules,
        "device": device,
        "model": model,
    }


def apply_llm(ctx: JobContext, sig: scoring.Signals, cfg: scoring.ScoringConfig, cands: list[scoring.Candidate],
              mode: str) -> tuple[list[scoring.Candidate], str]:
    """Re-puntúa los mejores candidatos con el LLM. Devuelve los candidatos y el estado del módulo:
    "ok" si al menos un veredicto fue válido y "failed" si ninguno lo fue. Si el proveedor deja de estar
    disponible (cuota, clave), los candidatos restantes conservan su puntuación local."""
    ch = scoring.channels(sig)
    out: list[scoring.Candidate] = []
    limit = ctx.settings.llm_max_candidates
    judged = attempted = 0
    stopped = False
    for i, c in enumerate(cands):
        if i < limit and c.text and not stopped:
            ctx.progress("semantic", i / max(1, min(limit, len(cands))), "Evaluando con LLM")
            attempted += 1
            try:
                verdict = semantic.llm_judge(ctx.settings, c.text, mode)
            except semantic.LLMUnavailable as exc:
                log.warning("LLM no disponible, se continúa con la puntuación local: %s", exc)
                stopped, verdict = True, None
            if verdict:
                judged += 1
                out.append(scoring.score_window(sig, ch, cfg, c.start, c.end, c.peak, c.starts_clean, c.ends_clean,
                                                llm=verdict.model_dump()))
                out[-1].tags.append(f"llm:{verdict.category}")
                continue
        out.append(c)
    out.sort(key=lambda x: x.score, reverse=True)
    status = "ok" if judged else ("failed" if attempted else "skipped")
    return scoring.dedupe(out), status
