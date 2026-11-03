"""Proveedores LLM (Ollama / NVIDIA) con respuestas HTTP simuladas: sin red ni claves reales."""

from __future__ import annotations

import json

import httpx
import pytest

from clipmaster_worker import semantic
from clipmaster_worker.config import Settings

VALID = {"score": 82, "title": "La jugada del siglo", "reason": "Reacción intensa", "category": "reaccion", "standalone": 0.7}


@pytest.fixture
def capture(monkeypatch):
    """Sustituye httpx.post por un MockTransport y registra las peticiones."""
    calls: list[httpx.Request] = []

    def install(handler):
        def post(url, **kwargs):
            transport = httpx.MockTransport(lambda req: (calls.append(req), handler(req))[1])
            with httpx.Client(transport=transport) as client:
                kwargs.pop("timeout", None)
                return client.post(url, **kwargs)
        monkeypatch.setattr(semantic.httpx, "post", post)
        return calls

    return install


def nvidia(**kw) -> Settings:
    return Settings(llm_provider="nvidia", nvidia_api_key="nvapi-test", **kw)


def chat_completion(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": content}}]})


def test_nvidia_disabled_without_key():
    assert semantic.llm_available(Settings(llm_provider="nvidia")) is False
    assert semantic.llm_available(nvidia()) is True
    assert Settings(llm_provider="nvidia").llm_label is None
    assert nvidia().llm_label == "nvidia:meta/llama-3.3-70b-instruct"
    assert Settings().llm_provider == "ollama" and Settings().llm_label is None


def test_nvidia_request_and_valid_verdict(capture):
    calls = capture(lambda req: chat_completion(json.dumps(VALID)))
    v = semantic.llm_judge(nvidia(), "qué jugada mano, eso fue increíble", "GAMING")
    assert v is not None and v.score == 82 and v.category == "reaccion"
    req = calls[0]
    assert str(req.url) == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer nvapi-test"
    body = json.loads(req.content)
    assert body["model"] == "meta/llama-3.3-70b-instruct"
    assert body["messages"][0]["role"] == "system" and "Esquema JSON" in body["messages"][0]["content"]
    assert "qué jugada" in body["messages"][1]["content"]


def test_nvidia_accepts_fenced_json(capture):
    capture(lambda req: chat_completion("Claro:\n```json\n" + json.dumps(VALID) + "\n```"))
    assert semantic.llm_judge(nvidia(), "texto", "AUTO") is not None


@pytest.mark.parametrize("content", ["no es json", json.dumps({**VALID, "score": 900}), "{}", ""])
def test_nvidia_invalid_output_is_discarded(capture, content):
    capture(lambda req: chat_completion(content))
    assert semantic.llm_judge(nvidia(), "texto", "AUTO") is None


@pytest.mark.parametrize("status", [401, 402, 403, 429])
def test_nvidia_quota_or_auth_stops_provider(capture, status):
    capture(lambda req: httpx.Response(status, json={"detail": "x"}))
    with pytest.raises(semantic.LLMUnavailable):
        semantic.llm_judge(nvidia(), "texto", "AUTO")


def test_nvidia_server_error_returns_none(capture):
    capture(lambda req: httpx.Response(500, text="boom"))
    assert semantic.llm_judge(nvidia(), "texto", "AUTO") is None


def test_custom_base_url_and_model(capture):
    calls = capture(lambda req: chat_completion(json.dumps(VALID)))
    semantic.llm_judge(nvidia(nvidia_base_url="http://nim.local:8000/v1/", nvidia_model="otro/modelo"), "t", "AUTO")
    assert str(calls[0].url) == "http://nim.local:8000/v1/chat/completions"
    assert json.loads(calls[0].content)["model"] == "otro/modelo"


def test_ollama_path_unchanged(capture):
    calls = capture(lambda req: httpx.Response(200, json={"message": {"content": json.dumps(VALID)}}))
    v = semantic.llm_judge(Settings(ollama_url="http://ollama:11434"), "texto", "AUTO")
    assert v is not None
    assert str(calls[0].url) == "http://ollama:11434/api/chat"
    assert json.loads(calls[0].content)["format"] == semantic.LLM_SCHEMA


def test_apply_llm_stops_after_unavailable(monkeypatch):
    """Tras un 429 no se hacen más llamadas y el resto conserva su puntuación local."""
    from clipmaster_worker import analysis, scoring

    calls = []

    def judge(settings, text, mode):
        calls.append(text)
        raise semantic.LLMUnavailable("429")

    monkeypatch.setattr(semantic, "llm_judge", judge)
    monkeypatch.setattr(scoring, "channels", lambda sig: {})
    monkeypatch.setattr(scoring, "dedupe", lambda c: c)

    class Ctx:
        settings = nvidia()
        def progress(self, *a, **k):
            pass

    cands = [scoring.Candidate.__new__(scoring.Candidate) for _ in range(3)]
    for i, c in enumerate(cands):
        c.text, c.score = f"t{i}", 50 - i
    out, status = analysis.apply_llm(Ctx(), None, None, cands, "AUTO")
    assert calls == ["t0"]
    assert status == "failed"
    assert [c.score for c in out] == [50, 49, 48]
