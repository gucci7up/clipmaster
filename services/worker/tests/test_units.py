"""Pruebas unitarias del motor: contratos, SSRF, señales, scoring, subtítulos, reencuadre, proveedores."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from clipmaster_worker import audio_signals, scoring
from clipmaster_worker.contracts import SubtitleStyle, Word, parse_job
from clipmaster_worker.providers import detect
from clipmaster_worker.reframe import piecewise_expr, plan_crop, simplify
from clipmaster_worker.semantic import LLMVerdict, make_title, segment_features
from clipmaster_worker.storage import LocalStorage, validate_key
from clipmaster_worker.subtitles import build_ass, build_srt, chunk_words, map_to_timeline
from clipmaster_worker.url_guard import UnsafeUrl, check_url

SHARED = Path(__file__).resolve().parents[3] / "packages" / "shared"


# ---------------------------------------------------------------- contratos


def test_contract_fixtures_parse():
    fixtures = json.loads((SHARED / "fixtures" / "jobs.json").read_text(encoding="utf-8"))
    kinds = {parse_job(f).kind for f in fixtures}
    assert kinds == {"import", "live", "analyze", "render", "copy", "thumbnail"}


def test_unknown_job_kind_rejected():
    with pytest.raises(ValueError):
        parse_job({"kind": "rm -rf"})


# ---------------------------------------------------------------- SSRF


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/video.mp4", "http://localhost/x.mp4", "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/a.mp4", "http://192.168.1.10/a.mp4", "http://[::1]/a.mp4", "http://[::ffff:127.0.0.1]/a.mp4",
    "http://minio:9000/clipmaster/x", "http://postgres/x", "file:///etc/passwd", "ftp://example.com/a.mp4",
    "http://user:pass@example.com/a.mp4", "http://example.com:6379/a.mp4", "http://0.0.0.0/a.mp4",
    "http://metadata.google.internal/computeMetadata/v1/", "http://app.internal/a.mp4",
])
def test_ssrf_blocked(url):
    with pytest.raises(UnsafeUrl):
        check_url(url, resolve=False)


def test_public_ip_allowed():
    assert check_url("https://8.8.8.8/video.mp4", resolve=False) == "8.8.8.8"


def test_storage_key_traversal():
    for bad in ["../etc/passwd", "/abs/key", "clips/../../x", "clips\\a\\b"]:
        with pytest.raises(ValueError):
            validate_key(bad)
    assert validate_key("clips/u1/p1/abc-123.mp4")


def test_local_storage_confined(tmp_path):
    st = LocalStorage(tmp_path)
    with pytest.raises(ValueError):
        st.path("clips/../../outside.mp4")


# ---------------------------------------------------------------- proveedores


@pytest.mark.parametrize("url,pid", [
    ("https://www.youtube.com/watch?v=x", "YOUTUBE"), ("https://youtu.be/x", "YOUTUBE"),
    ("https://www.twitch.tv/chan", "TWITCH"), ("https://kick.com/chan", "KICK"),
    ("https://www.tiktok.com/@a/video/1", "TIKTOK"), ("https://cdn.example.com/l/index.m3u8", "HLS"),
    ("https://cdn.example.com/v.mp4", "DIRECT"), ("https://evilyoutube.com/x", None), ("javascript:alert(1)", None),
])
def test_detect_provider(url, pid):
    assert detect(url) == pid


# ---------------------------------------------------------------- audio


def _tone(seconds: float, amp: float, sr: int = 16000) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def test_audio_signals_detect_loud_burst_and_silence():
    rng = np.random.default_rng(0)
    quiet = _tone(20, 0.02)
    burst_t = np.arange(5 * 16000) / 16000
    burst = (rng.standard_normal(len(burst_t)) * (0.5 + 0.5 * np.sin(2 * np.pi * 5 * burst_t)) * 0.4).astype(np.float32)
    silence = np.zeros(10 * 16000, dtype=np.float32) + rng.standard_normal(10 * 16000).astype(np.float32) * 1e-4
    sig = audio_signals.analyze_audio(np.concatenate([quiet, burst, silence]))
    cell = lambda t: int(t / sig.step)  # noqa: E731
    assert sig.loud[cell(21):cell(24)].max() > 0.7
    assert sig.loud[cell(5):cell(15)].max() < 0.3
    assert sig.burst[cell(21):cell(24)].max() > sig.burst[cell(5):cell(15)].max()
    assert sig.silence[cell(27):cell(34)].mean() > 0.9


# ---------------------------------------------------------------- semántica y scoring


def test_lexical_features_spanish_dominican():
    segs = [
        {"start": 0, "end": 3, "text": "Hola, bienvenidos al programa."},
        {"start": 3, "end": 6, "text": "¡Diablo mano, jajaja, qué vaina tan brutal!"},
        {"start": 6, "end": 9, "text": "Te cuento lo que pasó: resulta que llegó tarde."},
    ]
    f = segment_features(segs, "HUMOR")
    assert f[1].humor > 0 and f[1].emotion > f[0].emotion
    assert f[2].story > 0
    assert f[1].score > f[0].score


def test_llm_verdict_schema_rejects_garbage():
    with pytest.raises(Exception):
        LLMVerdict.model_validate({"score": 500, "title": "x", "reason": "y", "category": "otro", "standalone": 3})
    ok = LLMVerdict.model_validate({"score": 80, "title": "Buen título", "reason": "Porque sí", "category": "humor", "standalone": 0.8})
    assert ok.score == 80


def test_make_title_truncates():
    t = make_title("esto es una frase muy larga " * 10, max_len=40)
    assert len(t) <= 41 and t[0].isupper() and t.endswith("…")


def _signals(n: int, peak_at: int, with_speech: bool = True) -> scoring.Signals:
    z = np.zeros(n, dtype=np.float32)
    loud = z.copy()
    loud[peak_at - 4:peak_at + 4] = 1.0
    asig = audio_signals.AudioSignals(0.5, loud, z.copy(), loud * 0.8, z.copy(), z.copy(), z - 20)
    segs = []
    if with_speech:
        for i in range(0, int(n * 0.5), 5):
            segs.append({"start": float(i), "end": float(i + 4.5), "text": "¡Increíble!" if abs(i - peak_at * 0.5) < 5 else "Texto normal.", "words": []})
    feats = segment_features(segs, "AUTO")
    from clipmaster_worker.semantic import semantic_grid

    sgrid = semantic_grid(feats, n, 0.5, 0.0) if segs else None
    return scoring.Signals(step=0.5, origin=0.0, audio=asig, semantic=sgrid, feats=feats, segments=segs)


def test_scoring_finds_peak_with_context_and_bounds():
    sig = _signals(240, peak_at=120)  # 120 s, pico en 60 s
    cfg = scoring.ScoringConfig(weights={"semantic": 0.3, "emotion": 0.3, "audio": 0.2, "visual": 0.1, "narrative": 0.05, "standalone": 0.05},
                                min_duration=15, max_duration=30, max_candidates=5)
    cands = scoring.generate_candidates(sig, cfg)
    assert cands
    top = cands[0]
    assert top.start < 60 < top.end
    assert 15 <= top.end - top.start <= 30
    assert top.start < 58  # incluye preparación antes del pico
    assert top.starts_clean  # empieza en inicio de frase
    assert 0 <= top.score <= 100


def test_scoring_without_speech_renormalizes():
    sig = _signals(120, peak_at=60, with_speech=False)
    cfg = scoring.ScoringConfig(weights={"semantic": 0.9, "emotion": 0.05, "audio": 0.05}, min_duration=10, max_duration=20, max_candidates=3)
    cands = scoring.generate_candidates(sig, cfg)
    assert cands and cands[0].score > 20, "sin habla la semántica no debe hundir la puntuación"
    assert "semantic" not in cands[0].components


def test_focus_filters_candidates():
    sig = _signals(240, peak_at=40)
    cfg = scoring.ScoringConfig(weights={"emotion": 0.5, "audio": 0.5}, min_duration=10, max_duration=20, max_candidates=3)
    assert not [c for c in scoring.generate_candidates(sig, cfg, focus=(60, 120)) if c.peak < 60]


def test_dedupe_removes_overlaps():
    mk = lambda s, e, sc: scoring.Candidate(s, e, (s + e) / 2, sc, {}, "t", "r", "", [])  # noqa: E731
    kept = scoring.dedupe([mk(0, 20, 90), mk(2, 21, 85), mk(40, 60, 70)])
    assert [(c.start, c.end) for c in kept] == [(0, 20), (40, 60)]


# ---------------------------------------------------------------- subtítulos


def test_srt_format():
    srt = build_srt([{"start": 1.5, "end": 3.25, "text": "Hola"}])
    assert "00:00:01,500 --> 00:00:03,250" in srt


def test_ass_highlight_and_escape():
    words = [Word(start=10 + i * 0.4, end=10 + i * 0.4 + 0.35, word=w) for i, w in enumerate(["hola", "{mundo}", "esto", "es", "prueba."])]
    ass = build_ass(words, SubtitleStyle(), 1080, 1920, "DejaVu Sans", clip_start=10, clip_end=13)
    assert "PlayResX: 1080" in ass and "Dialogue:" in ass
    assert "{mundo}" not in ass  # llaves escapadas para no inyectar etiquetas ASS
    assert "HOLA" in ass  # mayúsculas por defecto
    assert "\\c&H0000D4FF" in ass  # color de resaltado #FFD400 en formato ASS (BGR)


def test_chunking_respects_limits():
    words = [Word(start=i * 0.3, end=i * 0.3 + 0.25, word=f"w{i}") for i in range(10)]
    chunks = chunk_words(words, max_words=3)
    assert all(len(c.words) <= 3 for c in chunks)


# ---------------------------------------------------------------- reencuadre


def test_crop_plan_vertical_from_landscape_limits_upscale():
    plan = plan_crop(1280, 720, 1080, 1920, mode="center", track=[], manual_x=None, manual_y=None, max_upscale=1.5)
    assert plan.crop_h == 720 and abs(plan.crop_w / plan.crop_h - 9 / 16) < 0.01
    assert plan.out_h == 1080  # no promete 1920 desde 720p
    assert plan.out_w % 2 == 0 and plan.out_h % 2 == 0


def test_crop_plan_auto_tracks_subject():
    track = [(t, 0.2 if t < 5 else 0.8, 0.5) for t in np.arange(0, 10, 0.5)]
    plan = plan_crop(1920, 1080, 1080, 1920, mode="auto", track=track, manual_x=None, manual_y=None, max_upscale=1.5)
    assert plan.mode == "auto" and "if(lt(t" in plan.x_expr


def test_piecewise_expression_and_simplify():
    pts = [(float(t), float(t * 10)) for t in range(100)]
    simple = simplify(pts, tol=1.0)
    assert len(simple) <= 24 and simple[0] == pts[0] and simple[-1] == pts[-1]
    expr = piecewise_expr([(0.0, 0.0), (1.0, 100.0)])
    assert expr.startswith("if(lt(t\\,1.000)")


def test_resegment_splits_long_whisper_segments():
    from clipmaster_worker.transcribe import resegment

    words = [{"start": i * 0.4, "end": i * 0.4 + 0.3, "word": w} for i, w in enumerate("Hola a todos. Hoy probamos esto. Y luego seguimos hablando".split())]
    words[-1]["word"] += "."
    out = resegment([{"start": 0, "end": 30, "text": "x", "words": words}])
    assert [s["text"] for s in out] == ["Hola a todos.", "Hoy probamos esto.", "Y luego seguimos hablando."]
    assert out[1]["start"] == words[3]["start"]


@pytest.mark.parametrize("raw, expected", [
    ("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies", "verificación anti-bot"),
    ("ERROR: [youtube] abc: Sign in to confirm you're not a bot", "verificación anti-bot"),
    ("ERROR: HTTP Error 429: Too Many Requests", "verificación anti-bot"),
    ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", "privado"),
    ("ERROR: [youtube] abc: Sign in to confirm your age", "privado"),
    ("ERROR: [youtube] abc: Video unavailable", "no está disponible"),
    ("ERROR: Unable to download webpage: page not found", "No se pudo acceder"),
])
def test_friendly_platform_errors(raw, expected):
    from clipmaster_worker.providers.platforms import _friendly

    assert expected in _friendly(Exception(raw))


@pytest.mark.parametrize("preset,marker", [("neon", r"\blur"), ("podcast", ",3,"), ("minimal", "Default"), ("karaoke", r"\k")])
def test_ass_templates(preset, marker):
    words = [Word(start=0.1, end=0.5, word="hola"), Word(start=0.6, end=1.0, word="mundo")]
    ass = build_ass(words, SubtitleStyle(preset=preset, font="Lato"), 1080, 1920, "DejaVu Sans", clip_start=0, clip_end=2)
    assert marker in ass
    assert "Style: Default,Lato," in ass  # la fuente del estilo tiene prioridad sobre la de la configuración


def test_ass_hook_title_is_escaped_and_timed():
    ass = build_ass([], SubtitleStyle(), 1080, 1920, "DejaVu Sans", 0, 20, hook="Mira {esto}", hook_duration=3)
    line = next(x for x in ass.splitlines() if ",Hook," in x)
    assert line.startswith("Dialogue: 1,0:00:00.00,0:00:03.00,Hook")
    assert "{esto}" not in line and "(esto)" in line


def test_map_to_timeline_concatenates_segments():
    words = [Word(start=2.2, end=2.6, word="a"), Word(start=9.0, end=9.5, word="fuera"), Word(start=20.4, end=20.9, word="b")]
    mapped = map_to_timeline(words, [(2.0, 5.0), (20.0, 22.0)])
    assert [w.word for w in mapped] == ["a", "b"]
    assert mapped[0].start == pytest.approx(0.2) and mapped[1].start == pytest.approx(3.4)
