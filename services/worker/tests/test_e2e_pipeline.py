"""
Prueba de extremo a extremo con video real y procesamiento real (FFmpeg, faster-whisper, OpenCV):
importar → extraer audio → transcribir → señales → candidatos → render MP4 → verificar con FFprobe → almacenamiento.
"""

from __future__ import annotations

import uuid

import pytest

from clipmaster_worker.analysis import run_analysis
from clipmaster_worker.capture import run_import
from clipmaster_worker.config import get_settings
from clipmaster_worker.context import JobContext
from clipmaster_worker.contracts import AnalyzeJobData, ImportJobData, RenderJobData
from clipmaster_worker.media import probe
from clipmaster_worker.render import run_render
from clipmaster_worker.storage import LocalStorage

pytestmark = pytest.mark.slow

USER = "u" + uuid.uuid4().hex[:8]
PROJECT = "p" + uuid.uuid4().hex[:8]


@pytest.fixture(scope="module")
def pipeline(sample_video, tmp_path_factory):
    video, has_speech = sample_video
    settings = get_settings()
    storage = LocalStorage(settings.local_storage_dir)
    upload_key = f"uploads/{USER}/{PROJECT}/source.mp4"
    storage.upload(video, upload_key, "video/mp4")
    events: list[tuple] = []

    def ctx(job_id: str) -> JobContext:
        return JobContext(job_id=job_id, project_id=PROJECT, settings=settings, storage=storage,
                          report=lambda *a: events.append(a), workdir=tmp_path_factory.mktemp(job_id))

    imp = run_import(ctx("import"), ImportJobData(
        kind="import", jobId="job-import", projectId=PROJECT, userId=USER,
        source={"type": "upload", "storageKey": upload_key}, outputPrefix=f"originals/{USER}/{PROJECT}", maxDurationSec=3600,
    ))
    asset = imp["asset"]
    analysis = run_analysis(ctx("analyze"), AnalyzeJobData(
        kind="analyze", jobId="job-analyze", projectId=PROJECT, userId=USER,
        sources=[{"key": asset["key"], "offsetSec": 0, "durationSec": asset["durationSec"]}],
        window={"start": 0, "end": asset["durationSec"]}, focus={"start": 0, "end": asset["durationSec"]},
        language=None, mode="REACTION",
        settings={"maxClips": 3, "minDuration": 8, "maxDuration": 20, "visualAnalysis": True, "semanticLLM": False},
        outputPrefix=f"analysis/{USER}/{PROJECT}",
    ))
    return {"storage": storage, "import": imp, "analysis": analysis, "has_speech": has_speech, "events": events, "ctx": ctx}


def test_import_produces_valid_original(pipeline):
    asset = pipeline["import"]["asset"]
    assert asset["hasVideo"] and asset["hasAudio"]
    assert abs(asset["durationSec"] - 40) < 0.5
    assert pipeline["storage"].size(asset["key"]) == asset["sizeBytes"] > 0


def test_transcription(pipeline):
    a = pipeline["analysis"]
    if not pipeline["has_speech"]:
        pytest.skip("No hay sintetizador de voz disponible para generar habla")
    assert a["modules"]["transcription"] == "ok"
    assert a["segments"], "Whisper no devolvió segmentos"
    text = " ".join(s["text"] for s in a["segments"]).lower()
    assert any(w in text for w in ("clips", "sistema", "proyecto", "gracias", "video")), text
    assert all(w["start"] <= w["end"] for s in a["segments"] for w in s["words"])
    assert a["srtKey"] and pipeline["storage"].size(a["srtKey"])


def test_candidates_detect_reaction(pipeline):
    a = pipeline["analysis"]
    assert a["modules"]["audio"] == "ok" and a["modules"]["visual"] == "ok"
    cands = a["candidates"]
    assert cands, "No se generaron candidatos"
    top = cands[0]
    # El momento con ráfaga + cambio de escena (15–22 s) debe estar dentro del mejor candidato.
    assert top["start"] <= 17 and top["end"] >= 19, top
    assert 8 - 0.01 <= top["end"] - top["start"] <= 20 + 0.01
    assert 0 <= top["score"] <= 100
    assert top["title"] and top["reason"]
    # Sin duplicados casi idénticos.
    for i, c in enumerate(cands):
        for d in cands[i + 1:]:
            inter = max(0, min(c["end"], d["end"]) - max(c["start"], d["start"]))
            assert inter / min(c["end"] - c["start"], d["end"] - d["start"]) <= 0.41


@pytest.mark.parametrize("aspect,ratio", [("VERTICAL", 9 / 16), ("HORIZONTAL", 16 / 9), ("SQUARE", 1.0)])
def test_render_mp4(pipeline, aspect, ratio):
    a = pipeline["analysis"]
    top = a["candidates"][0]
    words = [w for s in a["segments"] for w in s["words"] if w["end"] > top["start"] and w["start"] < top["end"]]
    render_id = f"r{aspect.lower()}"
    res = run_render(pipeline["ctx"](f"render-{aspect}"), RenderJobData(
        kind="render", jobId=f"job-render-{aspect}", projectId=PROJECT, userId=USER, clipId="clip1", renderId=render_id,
        sources=[{"key": pipeline["import"]["asset"]["key"], "offsetSec": 0, "durationSec": 40}],
        start=top["start"], end=top["end"], aspect=aspect,
        subtitles={"enabled": True, "style": {}, "words": words}, reframe={"mode": "auto"},
        outputPrefix=f"clips/{USER}/{PROJECT}",
    ))
    storage = pipeline["storage"]
    path = storage.path(res["outputKey"])
    info = probe(path)  # FFprobe debe poder abrirlo
    assert info.has_video and info.has_audio
    assert info.video_codec == "h264" and info.audio_codec == "aac"
    assert abs(info.duration - (top["end"] - top["start"])) < 0.6
    assert abs(info.width / info.height - ratio) < 0.02
    assert info.height <= 1920 and info.width <= 1920
    assert storage.size(res["thumbnailKey"]) > 0
    if words:
        assert res["subtitleKey"] and storage.size(res["subtitleKey"]) > 0


def test_progress_events_are_real(pipeline):
    stages = {e[0] for e in pipeline["events"]}
    assert {"import", "audio", "scoring"} <= stages
    values = [e[1] for e in pipeline["events"] if e[1] is not None]
    assert all(0 <= v <= 1 for v in values)


def test_render_merged_clip_with_hook_template_and_custom_font(pipeline, tmp_path):
    """Clip combinado de dos tramos con título gancho, plantilla neon y una fuente subida por el usuario."""
    import shutil
    from pathlib import Path

    a = pipeline["analysis"]
    storage = pipeline["storage"]
    words = [w for s in a["segments"] for w in s["words"]]
    fonts = []
    candidates = [Path(r"C:\Windows\Fonts\arial.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    font_file = next((p for p in candidates if p.exists()), None)
    if font_file:
        key = f"fonts/{USER}/f1.ttf"
        storage.upload(font_file, key, "font/ttf")
        fonts = [{"key": key, "family": "Arial" if "arial" in font_file.name else "DejaVu Sans"}]
    segments = [{"start": 2.0, "end": 8.0}, {"start": 20.0, "end": 26.5}]
    res = run_render(pipeline["ctx"]("render-merged"), RenderJobData(
        kind="render", jobId="job-render-merged", projectId=PROJECT, userId=USER, clipId="clip2", renderId="rmerged",
        sources=[{"key": pipeline["import"]["asset"]["key"], "offsetSec": 0, "durationSec": 40}],
        start=2.0, end=26.5, aspect="VERTICAL", segments=segments,
        subtitles={"enabled": True, "style": {"preset": "neon", "font": fonts[0]["family"] if fonts else "DejaVu Sans"}, "words": words},
        hook={"text": "Esto no te lo esperas", "durationSec": 2.5}, fonts=fonts, reframe={"mode": "center"},
        outputPrefix=f"clips/{USER}/{PROJECT}",
    ))
    info = probe(storage.path(res["outputKey"]))
    assert info.has_video and info.has_audio and info.video_codec == "h264"
    assert abs(info.duration - 12.5) < 0.6  # 6 s + 6.5 s
    assert abs(info.width / info.height - 9 / 16) < 0.02
    ass = storage.path(res["subtitleKey"]).read_text(encoding="utf-8")
    assert "Esto no te lo esperas" in ass and r"\blur" in ass
    shutil.rmtree(tmp_path, ignore_errors=True)
