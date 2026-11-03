"""Contexto de ejecución de un job: progreso, cancelación, directorio temporal y almacenamiento."""

from __future__ import annotations

import logging
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .config import Settings
from .storage import Storage

log = logging.getLogger(__name__)

ReportFn = Callable[[str, Optional[float], Optional[str], Optional[dict]], None]


@dataclass
class JobContext:
    job_id: str
    project_id: str
    settings: Settings
    storage: Storage
    report: ReportFn = lambda *a: None
    is_cancelled: Callable[[], bool] = lambda: False
    workdir: Path = field(default_factory=lambda: Path(tempfile.mkdtemp(prefix="cm-")))
    timings: dict[str, float] = field(default_factory=dict)
    _last_report: float = 0.0
    _last_stage: str = ""

    def progress(self, stage: str, value: Optional[float] = None, message: Optional[str] = None,
                 metrics: Optional[dict] = None, force: bool = False) -> None:
        """Reporta progreso real; se limita a ~1 mensaje/1.5 s salvo cambio de etapa."""
        now = time.monotonic()
        if not force and stage == self._last_stage and now - self._last_report < 1.5:
            return
        self._last_report, self._last_stage = now, stage
        try:
            self.report(stage, value, message, metrics)
        except Exception as exc:  # noqa: BLE001 - el progreso nunca debe romper el job
            log.warning("No se pudo reportar progreso: %s", exc)

    def stage_progress(self, stage: str, lo: float = 0.0, hi: float = 1.0) -> Callable[[float], None]:
        return lambda p: self.progress(stage, lo + (hi - lo) * p)

    def timed(self, name: str):
        ctx = self

        class _T:
            def __enter__(self):
                self.t = time.monotonic()

            def __exit__(self, *exc):
                ctx.timings[name] = round(time.monotonic() - self.t, 3)

        return _T()

    def cleanup(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)
