"""
Recorte de personas para miniaturas y portadas con U²-Net human segmentation (Apache 2.0), ejecutado en local con
onnxruntime (ya lo instala faster-whisper): el fotograma no sale del servidor.

El modelo (176 MB) se descarga en la imagen Docker al construirla; en desarrollo se descarga la primera vez que se
usa. En ambos casos se comprueba su SHA-256.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import urllib.request
from pathlib import Path

import numpy as np

from .config import Settings
from .media import MediaError

log = logging.getLogger(__name__)

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"
MODEL_SHA256 = "01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c"
INPUT = 320
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)

_lock = threading.Lock()
_sessions: dict[str, object] = {}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(path: Path, url: str = MODEL_URL, sha256: str = MODEL_SHA256) -> Path:
    """Descarga el modelo a `path` de forma atómica y verifica su hash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    log.info("Descargando el modelo de recorte de personas (%s)", url)
    try:
        with urllib.request.urlopen(url, timeout=60) as r, tmp.open("wb") as f:  # noqa: S310 - URL fija del admin
            while chunk := r.read(1 << 20):
                f.write(chunk)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise MediaError(f"No se pudo descargar el modelo de recorte: {exc}") from exc
    if _sha256(tmp) != sha256:
        tmp.unlink(missing_ok=True)
        raise MediaError("El modelo de recorte descargado no coincide con el hash esperado")
    os.replace(tmp, path)
    return path


def model_path(settings: Settings) -> Path:
    path = Path(settings.segmentation_model_path)
    if not path.is_file():
        download(path)
    return path


def _session(settings: Settings):
    import onnxruntime as ort

    path = str(model_path(settings))
    with _lock:
        if path not in _sessions:
            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            _sessions[path] = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        return _sessions[path]


def person_mask(settings: Settings, image_bgr: np.ndarray) -> np.ndarray:
    """Máscara float32 0–1 del tamaño de la imagen: 1 donde hay una persona."""
    import cv2

    sess = _session(settings)
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    x = cv2.resize(rgb, (INPUT, INPUT), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    x = ((x - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
    pred = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / max(1e-6, hi - lo)
    h, w = image_bgr.shape[:2]
    return cv2.resize(pred, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)


def main_subject(mask: np.ndarray, threshold: float = 0.5) -> np.ndarray:
    """Quita manchas sueltas: conserva las regiones con al menos el 15 % del área de la mayor."""
    import cv2

    hard = (mask > threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(hard, connectivity=8)
    if count <= 1:
        return np.zeros_like(mask)
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [i + 1 for i, a in enumerate(areas) if a >= 0.15 * areas.max()]
    return mask * np.isin(labels, keep).astype(np.float32)


if __name__ == "__main__":  # python -m clipmaster_worker.segment  → descarga el modelo (build de Docker)
    logging.basicConfig(level=logging.INFO)
    print(model_path(Settings()))
