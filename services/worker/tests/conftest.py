import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
ARTIFACTS = ROOT / "tests" / ".artifacts"

# Configuración de pruebas: almacenamiento local, CPU y modelo pequeño.
os.environ.setdefault("STORAGE_BACKEND", "local")
os.environ.setdefault("DEVICE", "cpu")
os.environ.setdefault("WHISPER_MODEL", os.environ.get("TEST_WHISPER_MODEL", "tiny"))
os.environ.setdefault("WHISPER_MODELS_DIR", str(ARTIFACTS / "models"))
os.environ.setdefault("LOCAL_STORAGE_DIR", str(ARTIFACTS / "storage"))
os.environ.setdefault("RENDER_ENCODER", "libx264")


@pytest.fixture(scope="session")
def artifacts() -> Path:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    return ARTIFACTS


@pytest.fixture(scope="session")
def sample_video(artifacts):
    from tests.fixtures import make_video

    dest = artifacts / "sample.mp4"
    marker = artifacts / "sample.speech"
    if not dest.exists():
        has_speech = make_video(dest, artifacts / "fixture_work")
        marker.write_text("1" if has_speech else "0")
    return dest, marker.read_text().strip() == "1"
