"""
Prueba real contra la API de NVIDIA (consume créditos): render con mirada a cámara, iluminación, voz del gancho
y portada, y análisis con fotogramas. No se ejecuta por defecto.

    NVIDIA_LIVE_TESTS=1 NVIDIA_API_KEY=nvapi-… NVIDIA_LIVE_VIDEO=/ruta/persona_hablando.mp4 pytest tests/test_nvidia_live.py

El video debe mostrar a una persona de frente (≥ 10 s); por ejemplo los de ejemplo de NVIDIA-Maxine/nim-clients.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import numpy as np
import pytest

from clipmaster_worker import semantic
from clipmaster_worker.analysis import candidate_frames
from clipmaster_worker.config import Settings
from clipmaster_worker.context import JobContext
from clipmaster_worker.contracts import RenderJobData
from clipmaster_worker.media import probe, run_ffmpeg
from clipmaster_worker.render import run_render
from clipmaster_worker.storage import LocalStorage

VIDEO = os.environ.get("NVIDIA_LIVE_VIDEO", "")
pytestmark = pytest.mark.skipif(
    not (os.environ.get("NVIDIA_LIVE_TESTS") == "1" and os.environ.get("NVIDIA_API_KEY") and Path(VIDEO).is_file()),
    reason="Requiere NVIDIA_LIVE_TESTS=1, NVIDIA_API_KEY y NVIDIA_LIVE_VIDEO",
)


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    settings = Settings(nvidia_api_key=os.environ["NVIDIA_API_KEY"], llm_provider="nvidia",
                        local_storage_dir=tmp_path_factory.mktemp("storage"))
    storage = LocalStorage(settings.local_storage_dir)
    key = f"originals/u/p/{uuid.uuid4().hex[:6]}.mp4"
    storage.upload(Path(VIDEO), key, "video/mp4")
    duration = probe(VIDEO).duration

    def ctx(name: str) -> JobContext:
        return JobContext(job_id=name, project_id="p", settings=settings, storage=storage,
                          report=lambda *a: None, workdir=tmp_path_factory.mktemp(name))

    return {"settings": settings, "storage": storage, "key": key, "duration": duration, "ctx": ctx}


def _job(env, render_id: str, ai: dict | None) -> RenderJobData:
    end = min(10.0, env["duration"] - 0.5)
    return RenderJobData(
        kind="render", jobId=render_id, projectId="p", userId="u", clipId="c", renderId=render_id,
        sources=[{"key": env["key"], "offsetSec": 0, "durationSec": env["duration"]}], start=1.0, end=end,
        aspect="VERTICAL", subtitles={"enabled": False, "style": {}, "words": []},
        hook={"text": "¡Mira lo que pasó!", "durationSec": 3}, reframe={"mode": "center"},
        outputPrefix="clips/u/p", ai=ai,
    )


def _frame(path: Path, at: float, out: Path) -> np.ndarray:
    import cv2

    run_ffmpeg(["-ss", f"{at:.2f}", "-i", str(path), "-frames:v", "1", str(out)])
    return cv2.imread(str(out)).astype(np.float32)


def _loudness(path: Path, start: float, dur: float) -> float:
    import subprocess

    r = subprocess.run(["ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(dur), "-i", str(path), "-af", "volumedetect",
                        "-f", "null", "-"], capture_output=True, text=True)
    line = next(ln for ln in r.stderr.splitlines() if "mean_volume" in ln)
    return float(line.split(":")[1].split()[0])


def test_render_con_todas_las_funciones_de_nvidia(env, tmp_path):
    plain = run_render(env["ctx"]("plain"), _job(env, "rplain", None))
    res = run_render(env["ctx"]("ai"), _job(env, "rai", {
        "eyeContact": True, "relight": 1, "hookVoice": "Magpie-Multilingual.ES-US.Diego.Happy",
        "coverPrompt": "vertical cover photo, person talking to camera in a studio, dramatic lighting, no text",
    }))
    assert res["ai"] == {k: {"status": "ok"} for k in ("hookVoice", "eyeContact", "relight", "cover")}, res["ai"]

    storage = env["storage"]
    a, b = storage.path(plain["outputKey"]), storage.path(res["outputKey"])
    info = probe(b)
    assert info.has_video and info.has_audio and info.video_codec == "h264"
    assert abs(info.duration - plain["durationSec"]) < 0.6
    assert (info.width, info.height) == (plain["width"], plain["height"])
    # La iluminación cambia la imagen de forma visible respecto al render sin IA.
    diff = np.abs(_frame(a, 4, tmp_path / "a.png") - _frame(b, 4, tmp_path / "b.png")).mean()
    assert diff > 4, diff
    # La voz del gancho se oye al inicio: más volumen que el original en los mismos segundos.
    assert _loudness(b, 0.2, 1.5) > _loudness(a, 0.2, 1.5) - 1
    cover = storage.path(res["coverKey"])
    assert cover.read_bytes()[:3] == b"\xff\xd8\xff" and cover.stat().st_size > 20_000


def test_analisis_con_fotogramas(env):
    frames = candidate_frames(env["ctx"]("vision"), str(storage_path(env)), 1.0, 8.0)
    assert len(frames) == 3 and all(f[:3] == b"\xff\xd8\xff" for f in frames)
    verdict = semantic.llm_judge(env["settings"], "Hola a todos, hoy les cuento algo increíble que me pasó.", "PODCAST", frames)
    assert verdict is not None and 0 <= verdict.score <= 100 and verdict.title


def storage_path(env) -> Path:
    return env["storage"].path(env["key"])
