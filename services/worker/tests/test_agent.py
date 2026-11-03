"""
Capturador remoto contra un servidor simulado (httpx.MockTransport): protocolo de trabajo, subida
por partes, errores del usuario frente a transitorios y cancelación. La importación real
(`run_import`) se prueba en test_e2e_pipeline; aquí se sustituye para aislar el protocolo.
"""

from __future__ import annotations

import json

import httpx
import pytest

from clipmaster_worker import agent as agent_mod
from clipmaster_worker.agent import Agent, AgentApi, AgentError
from clipmaster_worker.media import JobCancelled
from clipmaster_worker.providers import ProviderError

JOB = {
    "kind": "import", "jobId": "11111111-1111-1111-1111-111111111111", "projectId": "p1", "userId": "u1",
    "source": {"type": "url", "url": "https://www.youtube.com/watch?v=abc", "provider": "YOUTUBE"},
    "outputPrefix": "originals/u1/p1", "maxDurationSec": 3600,
}
KEY = f"originals/u1/p1/{JOB['jobId']}.mp4"


class FakeServer:
    def __init__(self, cancelled: bool = False):
        self.calls: list[tuple[str, str, object]] = []
        self.parts: dict[int, bytes] = {}
        self.cancelled = cancelled

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path.removeprefix("/api/capture-agent")
        body: object = req.content if path.startswith(f"/jobs/{JOB['jobId']}/upload/parts/") else (json.loads(req.content) if req.content else None)
        self.calls.append((req.method, path, body))
        assert req.headers["authorization"] == "Bearer cma_test"
        if path.endswith("/start"):
            return httpx.Response(200, json={"proceed": True})
        if path.endswith("/progress"):
            return httpx.Response(200, json={"cancelled": self.cancelled})
        if "/upload/parts/" in path:
            self.parts[int(path.rsplit("/", 1)[1])] = req.content
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/upload/finish"):
            return httpx.Response(200, json={"sizeBytes": sum(len(p) for p in self.parts.values())})
        if path.endswith("/fail"):
            return httpx.Response(204)
        return httpx.Response(200, json={"ok": True})

    def paths(self) -> list[str]:
        return [p.replace(f"/jobs/{JOB['jobId']}", "") for _, p, _ in self.calls]


def make_agent(server, part_bytes: int = 4) -> Agent:
    api = AgentApi("https://clips.example.com", "cma_test", client=httpx.Client(transport=httpx.MockTransport(server)))
    a = Agent(api)
    a.part_bytes = part_bytes
    return a


def test_requires_https():
    with pytest.raises(AgentError):
        AgentApi("http://clips.example.com", "cma_x")


def test_job_uploads_in_parts_and_completes(monkeypatch, tmp_path):
    server = FakeServer()

    def fake_import(ctx, job):
        out = ctx.workdir / "original.mp4"
        out.write_bytes(b"0123456789")
        size = ctx.storage.upload(out, KEY, "video/mp4")
        return {"asset": {"key": KEY, "sizeBytes": size}, "title": "Mi video"}

    monkeypatch.setattr("clipmaster_worker.capture.run_import", fake_import)
    make_agent(server).run_job(JOB)

    assert server.parts == {1: b"0123", 2: b"4567", 3: b"89"}
    paths = server.paths()
    assert paths[0] == "/start"
    assert paths.index("/upload/init") < paths.index("/upload/finish") < paths.index("/complete")
    complete = next(b for m, p, b in server.calls if p.endswith("/complete"))
    assert complete["result"]["asset"] == {"key": KEY, "sizeBytes": 10}
    assert complete["result"]["title"] == "Mi video"
    assert not any(p.endswith("/fail") for p in paths)


@pytest.mark.parametrize("exc,user_error", [(ProviderError("El video no está disponible."), True), (RuntimeError("disco lleno"), False)])
def test_failures_report_whether_retry_makes_sense(monkeypatch, exc, user_error):
    server = FakeServer()

    def boom(ctx, job):
        raise exc

    monkeypatch.setattr("clipmaster_worker.capture.run_import", boom)
    make_agent(server).run_job(JOB)
    fail = next(b for m, p, b in server.calls if p.endswith("/fail"))
    assert fail == {"error": str(exc), "userError": user_error}


def test_cancelled_job_is_not_reported_as_failure(monkeypatch):
    server = FakeServer(cancelled=True)

    def cancellable(ctx, job):
        ctx.progress("download", 0.1, "Descargando", force=True)
        if ctx.is_cancelled():
            raise JobCancelled()
        raise AssertionError("debería haberse cancelado")

    monkeypatch.setattr("clipmaster_worker.capture.run_import", cancellable)
    make_agent(server).run_job(JOB)
    assert not any(p.endswith(("/fail", "/complete")) for p in server.paths())


def test_skips_job_the_server_says_not_to_run(monkeypatch):
    def handler(req):
        return httpx.Response(200, json={"proceed": False, "reason": "project_cancelled"})

    monkeypatch.setattr("clipmaster_worker.capture.run_import", lambda c, j: pytest.fail("no debe ejecutarse"))
    make_agent(handler).run_job(JOB)


def test_retries_transient_errors_and_stops_on_revoked_token(monkeypatch):
    monkeypatch.setattr(agent_mod.time, "sleep", lambda s: None)
    answers = iter([httpx.Response(503), httpx.Response(200, json={"name": "PC"})])
    api = AgentApi("https://clips.example.com", "cma_test", client=httpx.Client(transport=httpx.MockTransport(lambda r: next(answers))))
    assert api.hello() == {"name": "PC"}

    revoked = AgentApi("https://clips.example.com", "cma_test", client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(401))))
    with pytest.raises(AgentError, match="revocado"):
        revoked.hello()


def test_work_dir_is_configurable_and_stale_jobs_are_removed(monkeypatch, tmp_path):
    stale = tmp_path / "cm-agent-old"
    stale.mkdir()
    (stale / "source.mp4").write_bytes(b"x")
    server = FakeServer()
    seen = {}

    def fake_import(ctx, job):
        seen["workdir"] = ctx.workdir
        raise ProviderError("El video no está disponible.")

    monkeypatch.setattr("clipmaster_worker.capture.run_import", fake_import)
    a = make_agent(server)
    a.work_dir = tmp_path
    a.prepare_work_dir()
    assert not stale.exists()
    a.run_job(JOB)
    assert seen["workdir"].parent == tmp_path
    assert not seen["workdir"].exists()  # se borra al terminar
