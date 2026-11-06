"""Miniaturas con FFmpeg y libass reales: fotograma encuadrado o fondo de IA (simulado) con texto encima."""

from __future__ import annotations

import uuid
from pathlib import Path

import numpy as np
import pytest

from clipmaster_worker import nvidia_media
from clipmaster_worker.config import get_settings
from clipmaster_worker.context import JobContext
from clipmaster_worker.contracts import ThumbnailJobData, ThumbnailStyle
from clipmaster_worker.media import MediaError, probe, run_ffmpeg
from clipmaster_worker.storage import LocalStorage
from clipmaster_worker.thumbs import build_thumbnail_ass, run_thumbnail

USER, PROJECT = "u" + uuid.uuid4().hex[:6], "p" + uuid.uuid4().hex[:6]


@pytest.fixture(scope="module")
def env(sample_video, tmp_path_factory):
    video, _ = sample_video
    settings = get_settings()
    storage = LocalStorage(settings.local_storage_dir)
    key = f"originals/{USER}/{PROJECT}/o.mp4"
    storage.upload(video, key, "video/mp4")
    duration = probe(str(video)).duration

    def ctx(name: str, s=settings) -> JobContext:
        return JobContext(job_id=name, project_id=PROJECT, settings=s, storage=storage, report=lambda *a: None,
                          workdir=tmp_path_factory.mktemp(name))

    return {"settings": settings, "storage": storage, "key": key, "duration": duration, "ctx": ctx}


def _job(env, job_id: str, **kw) -> ThumbnailJobData:
    data = dict(kind="thumbnail", jobId=job_id, projectId=PROJECT, userId=USER, clipId="c1",
                sources=[{"key": env["key"], "offsetSec": 0, "durationSec": env["duration"]}], at=min(2.0, env["duration"] / 2),
                aspect="HORIZONTAL", text="", outputPrefix=f"thumbnails/{USER}/{PROJECT}")
    data.update(kw)
    return ThumbnailJobData.model_validate(data)


def _pixels(path: Path, tmp: Path) -> np.ndarray:
    raw = tmp / (path.stem + ".rgb")
    info = probe(str(path))
    run_ffmpeg(["-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", str(raw)])
    return np.frombuffer(raw.read_bytes(), dtype=np.uint8).reshape(info.height, info.width, 3).astype(int)


def test_frame_thumbnail_sizes_and_text(env, tmp_path):
    plain = run_thumbnail(env["ctx"]("t-plain"), _job(env, "t-plain"))
    texted = run_thumbnail(env["ctx"]("t-text"), _job(env, "t-text", text="¡La capicúa del año!",
                                                        style={"size": "xl", "position": "bottom"}))
    assert (plain["width"], plain["height"]) == (1280, 720)
    a = env["storage"].download(plain["key"], tmp_path / "a.jpg")
    b = env["storage"].download(texted["key"], tmp_path / "b.jpg")
    pa, pb = _pixels(a, tmp_path), _pixels(b, tmp_path)
    assert pa.shape == (720, 1280, 3)
    # El texto cambia la franja inferior y deja la superior prácticamente igual.
    assert np.abs(pa[-200:] - pb[-200:]).mean() > 5
    assert np.abs(pa[:200] - pb[:200]).mean() < 2

    vertical = run_thumbnail(env["ctx"]("t-vert"), _job(env, "t-vert", aspect="VERTICAL", text="Klk", reframe={"mode": "center"}))
    assert (vertical["width"], vertical["height"]) == (1080, 1920)
    assert probe(str(env["storage"].download(vertical["key"], tmp_path / "v.jpg"))).height == 1920


def test_frame_outside_video_is_a_user_error(env):
    with pytest.raises(MediaError, match="fuera del video"):
        run_thumbnail(env["ctx"]("t-out"), _job(env, "t-out", at=env["duration"] + 50))


def test_ai_background_uses_flux_and_fills_the_format(env, tmp_path, monkeypatch):
    calls = []

    def fake_cover(settings, prompt, aspect, out, **kw):
        calls.append((prompt, aspect))
        run_ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=1344x768", "-frames:v", "1", str(out)])
        return out

    monkeypatch.setattr(nvidia_media, "cover_image", fake_cover)
    r = run_thumbnail(env["ctx"]("t-ai"), _job(env, "t-ai", background="ai", prompt="mesa de dominó", text="Tranque"))
    assert calls == [("mesa de dominó", "HORIZONTAL")]
    px = _pixels(env["storage"].download(r["key"], tmp_path / "ai.jpg"), tmp_path)
    assert px.shape == (720, 1280, 3) and px[:100, :100, 0].mean() > 200  # fondo rojo de la "IA" sin bordes negros

    with pytest.raises(ValueError, match="Describe la imagen"):
        run_thumbnail(env["ctx"]("t-ai2"), _job(env, "t-ai2", background="ai", prompt="  "))


def test_ass_styles():
    style = ThumbnailStyle(look="box", position="top", uppercase=True)
    ass = build_thumbnail_ass("hola {mundo}", style, 1280, 720)
    assert "HOLA (MUNDO)" in ass and ",3," in ass.split("Style: Thumb")[1]
    assert "Dialogue" not in build_thumbnail_ass("   ", style, 1280, 720)
