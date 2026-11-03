"""
Señales de audio a partir de PCM 16 kHz mono, en una rejilla temporal de STEP segundos.

Señales (todas normalizadas 0..1):
  loud      – energía relativa a la línea base local (picos de volumen, gritos, aplausos).
  onset     – subida brusca de energía (inicio de una reacción).
  burst     – modulación rítmica de la envolvente en 2–8 Hz, con energía alta y espectro "ruidoso"
              (planitud espectral): patrón típico de risas, vítores o aplausos. Es una heurística
              acústica, no un clasificador de risa entrenado.
  shout     – energía alta con centroide espectral alto (voz elevada/grito).
  silence   – 1 si el tramo está en silencio relativo.
La intensidad por sí sola no decide: el scoring combina estas señales con semántica y visual.
"""

from __future__ import annotations

import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

STEP = 0.5  # segundos por celda de la rejilla
SR = 16000
FRAME = 800  # 50 ms
ENV_RATE = SR / FRAME  # 20 Hz


@dataclass
class AudioSignals:
    step: float
    loud: np.ndarray
    onset: np.ndarray
    burst: np.ndarray
    shout: np.ndarray
    silence: np.ndarray
    rms_db: np.ndarray

    @property
    def length(self) -> int:
        return len(self.loud)

    def to_dict(self) -> dict:
        return {k: np.round(getattr(self, k), 3).tolist() for k in ("loud", "onset", "burst", "shout", "silence", "rms_db")}


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("Se espera WAV PCM 16-bit mono")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def _rolling_median(x: np.ndarray, win: int) -> np.ndarray:
    """Mediana móvil aproximada por bloques (O(n)) para la línea base local."""
    if len(x) == 0:
        return x
    block = max(1, win // 4)
    n_blocks = int(np.ceil(len(x) / block))
    meds = np.array([np.median(x[i * block:(i + 1) * block]) for i in range(n_blocks)])
    k = max(1, win // block)
    pad = np.pad(meds, (k // 2, k - k // 2 - 1), mode="edge")
    smoothed = np.array([np.median(pad[i:i + k]) for i in range(n_blocks)])
    return np.repeat(smoothed, block)[: len(x)]


def _squash(x: np.ndarray, center: float, scale: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-(x - center) / scale))


def analyze_audio(samples: np.ndarray) -> AudioSignals:
    n_frames = len(samples) // FRAME
    if n_frames < 4:
        empty = np.zeros(max(1, int(len(samples) / SR / STEP)), dtype=np.float32)
        return AudioSignals(STEP, empty, empty, empty, empty, np.ones_like(empty), empty - 90)
    frames = samples[: n_frames * FRAME].reshape(n_frames, FRAME)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)  # dBFS por trama de 50 ms

    # Centroide espectral por trama (en bloques para limitar memoria).
    centroid = np.zeros(n_frames, dtype=np.float32)
    flatness = np.zeros(n_frames, dtype=np.float32)
    window = np.hanning(FRAME).astype(np.float32)
    freqs = np.fft.rfftfreq(FRAME, 1 / SR).astype(np.float32)
    for i in range(0, n_frames, 4096):
        spec = np.abs(np.fft.rfft(frames[i:i + 4096] * window, axis=1))
        centroid[i:i + 4096] = (spec * freqs).sum(axis=1) / (spec.sum(axis=1) + 1e-9)
        # Planitud espectral (media geométrica / aritmética): alta en ruido de banda ancha
        # (vítores, aplausos, risas aspiradas), baja en voz sonora normal.
        power = spec ** 2 + 1e-12
        flatness[i:i + 4096] = np.exp(np.log(power).mean(axis=1)) / power.mean(axis=1)

    per_cell = int(STEP * ENV_RATE)  # 10 tramas por celda
    n_cells = n_frames // per_cell
    db_cells = db[: n_cells * per_cell].reshape(n_cells, per_cell)
    cell_db = np.percentile(db_cells, 80, axis=1)
    cell_centroid = centroid[: n_cells * per_cell].reshape(n_cells, per_cell).mean(axis=1)
    cell_flat = flatness[: n_cells * per_cell].reshape(n_cells, per_cell).mean(axis=1)

    # Línea base local (~60 s) y suelo de ruido global.
    baseline = _rolling_median(cell_db, int(60 / STEP))
    noise_floor = np.percentile(cell_db, 10)
    rel = cell_db - baseline
    loud = _squash(rel, 6.0, 2.0) * (cell_db > noise_floor + 6)

    onset_raw = np.diff(cell_db, prepend=cell_db[0])
    onset = _squash(onset_raw, 8.0, 2.0)

    silence = ((cell_db < max(noise_floor + 4, -55)) | (cell_db < -50)).astype(np.float32)

    # Modulación de la envolvente en ventanas de 2 s: energía 2–8 Hz / energía total.
    env = rms / (rms.max() + 1e-9)
    win = int(2 * ENV_RATE)
    burst = np.zeros(n_cells, dtype=np.float32)
    mod_freqs = np.fft.rfftfreq(win, 1 / ENV_RATE)
    band = (mod_freqs >= 2) & (mod_freqs <= 8)
    hann = np.hanning(win)
    for c in range(n_cells):
        center = c * per_cell + per_cell // 2
        a, b = center - win // 2, center + win // 2
        if a < 0 or b > len(env):
            continue
        seg = env[a:b] - env[a:b].mean()
        spec = np.abs(np.fft.rfft(seg * hann)) ** 2
        total = spec[1:].sum() + 1e-12
        burst[c] = spec[band].sum() / total
    noisy = 0.3 + 0.7 * _squash(cell_flat, 0.15, 0.04)
    burst = _squash(burst, 0.55, 0.08) * loud.clip(0.2, 1.0) * noisy * (1 - silence)

    shout = _squash(cell_centroid, 2200.0, 300.0) * _squash(rel, 8.0, 2.0) * (1 - silence)

    return AudioSignals(
        step=STEP,
        loud=loud.astype(np.float32),
        onset=onset.astype(np.float32),
        burst=burst.astype(np.float32),
        shout=shout.astype(np.float32),
        silence=silence,
        rms_db=cell_db.astype(np.float32),
    )
