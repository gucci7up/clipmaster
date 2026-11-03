"""Cliente de la API interna (worker → API). Reintenta ante errores transitorios."""

from __future__ import annotations

import logging
import time
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)


class ApiClient:
    def __init__(self, base_url: str, token: str, timeout: float = 30):
        self.base = base_url.rstrip("/")
        self.client = httpx.Client(timeout=timeout, headers={"Authorization": f"Bearer {token}"})

    def _post(self, path: str, body: dict, retries: int = 5) -> Optional[Any]:
        delay = 1.0
        for attempt in range(retries):
            try:
                r = self.client.post(f"{self.base}{path}", json=body)
                if r.status_code < 300:
                    return r.json() if r.content else None
                if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                    raise RuntimeError(f"API {path} → {r.status_code}: {r.text[:300]}")
            except httpx.HTTPError as exc:
                log.warning("API %s falló (%s), intento %d", path, exc.__class__.__name__, attempt + 1)
            time.sleep(delay)
            delay = min(delay * 2, 20)
        raise RuntimeError(f"No se pudo contactar la API interna ({path})")

    def start(self, job_id: str) -> dict:
        return self._post(f"/internal/jobs/{job_id}/start", {}) or {}

    def progress(self, job_id: str, stage: str, progress: Optional[float], message: Optional[str], metrics: Optional[dict]) -> None:
        self._post(f"/internal/jobs/{job_id}/progress", {"stage": stage, "progress": progress, "message": message, "metrics": metrics}, retries=2)

    def complete(self, job_id: str, result: dict) -> None:
        self._post(f"/internal/jobs/{job_id}/complete", {"result": result})

    def fail(self, job_id: str, error: str, will_retry: bool, attempt: int) -> None:
        self._post(f"/internal/jobs/{job_id}/fail", {"error": error, "willRetry": will_retry, "attempt": attempt}, retries=3)

    def segment(self, capture_session_id: str, body: dict) -> None:
        self._post(f"/internal/captures/{capture_session_id}/segments", body, retries=8)
