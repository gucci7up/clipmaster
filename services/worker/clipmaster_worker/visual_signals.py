"""
Señales visuales con OpenCV sobre fotogramas decodificados por FFmpeg a baja resolución y fps.

  motion – diferencia media entre fotogramas consecutivos (actividad en pantalla).
  scene  – cambio de escena (diferencia de histogramas HSV).
  faces  – rostros detectados (Haar cascade incluido en OpenCV) y su posición, usados para
           presencia de personas y reencuadre. No se identifica a nadie.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass, field
from typing import Iterator, Optional

import numpy as np

from .media import CancelCheck, JobCancelled, ffmpeg_bin

log = logging.getLogger(__name__)


@dataclass
class FaceBox:
    cx: float  # centro normalizado 0..1
    cy: float
    w: float
    h: float


@dataclass
class VisualSample:
    t: float
    motion: float
    scene: float
    faces: list[FaceBox] = field(default_factory=list)
    motion_cx: Optional[float] = None
    motion_cy: Optional[float] = None


def iter_frames(src: str, *, start: float, duration: float, fps: float, width: int,
                cancel: CancelCheck | None = None) -> Iterator[tuple[float, np.ndarray]]:
    """Decodifica con FFmpeg a BGR24 escalado; evita seeks costosos de OpenCV y soporta URLs HTTP."""
    import cv2  # noqa: F401  (asegura que OpenCV esté disponible antes de lanzar FFmpeg)

    probe_h = None
    cmd = [ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", src, "-t", f"{duration:.3f}", "-an", "-sn",
            "-vf", f"fps={fps},scale={width}:-2", "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"]
    # La altura se obtiene del primer fotograma vía ffprobe del flujo escalado.
    from .media import probe as _probe

    info = _probe(src)
    if not info.width or not info.height:
        return
    probe_h = int(round(info.height * width / info.width / 2) * 2)
    frame_bytes = width * probe_h * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert proc.stdout is not None
        i = 0
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            if cancel and i % 50 == 0 and cancel():
                raise JobCancelled()
            yield i / fps, np.frombuffer(buf, dtype=np.uint8).reshape(probe_h, width, 3)
            i += 1
    finally:
        proc.kill()
        proc.wait()


_cascade = None


def _face_detector():
    global _cascade
    if _cascade is None:
        import cv2

        _cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    return _cascade


def detect_faces(frame: np.ndarray) -> list[FaceBox]:
    import cv2

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    h, w = gray.shape
    rects = _face_detector().detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(max(20, w // 25), max(20, w // 25)))
    return [FaceBox(cx=(x + fw / 2) / w, cy=(y + fh / 2) / h, w=fw / w, h=fh / h) for (x, y, fw, fh) in rects]


def analyze_visual(src: str, *, start: float, duration: float, fps: float, width: int, faces: bool = True,
                   cancel: CancelCheck | None = None) -> list[VisualSample]:
    import cv2

    samples: list[VisualSample] = []
    prev_gray = None
    prev_hist = None
    for t, frame in iter_frames(src, start=start, duration=duration, fps=fps, width=width, cancel=cancel):
        small = cv2.resize(frame, (160, int(160 * frame.shape[0] / frame.shape[1])))
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        motion, scene, mcx, mcy = 0.0, 0.0, None, None
        if prev_gray is not None:
            diff = cv2.absdiff(gray, prev_gray)
            motion = float(diff.mean() / 255.0)
            mask = diff > 25
            if mask.any():
                ys, xs = np.nonzero(mask)
                mcx, mcy = float(xs.mean() / gray.shape[1]), float(ys.mean() / gray.shape[0])
            scene = float(1.0 - cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
        boxes = detect_faces(frame) if faces else []
        samples.append(VisualSample(t=start + t, motion=motion, scene=max(0.0, scene), faces=boxes, motion_cx=mcx, motion_cy=mcy))
        prev_gray, prev_hist = gray, hist
    return samples


def visual_grid(samples: list[VisualSample], n_cells: int, step: float, origin: float) -> dict[str, np.ndarray]:
    """Proyecta las muestras sobre la rejilla temporal común del análisis."""
    motion = np.zeros(n_cells, dtype=np.float32)
    scene = np.zeros(n_cells, dtype=np.float32)
    faces = np.zeros(n_cells, dtype=np.float32)
    counts = np.zeros(n_cells, dtype=np.float32)
    for s in samples:
        c = int((s.t - origin) / step)
        if 0 <= c < n_cells:
            motion[c] += s.motion
            scene[c] = max(scene[c], s.scene)
            faces[c] += min(1.0, len(s.faces))
            counts[c] += 1
    nz = counts > 0
    motion[nz] /= counts[nz]
    faces[nz] /= counts[nz]
    # Normalización relativa al propio video: la actividad "alta" depende del contenido.
    if motion.max() > 0:
        ref = np.percentile(motion[nz], 90) if nz.any() else motion.max()
        motion = np.clip(motion / (ref + 1e-6), 0, 1.5) / 1.5
    scene_cut = (scene > 0.5).astype(np.float32)
    return {"motion": motion, "scene": scene_cut, "faces": faces}
