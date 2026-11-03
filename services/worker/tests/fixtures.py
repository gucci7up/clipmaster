"""
Generador determinista de un video de prueba real (no simulado):
  0–15 s  fondo estático + habla tranquila
  15–22 s cambio de escena con mucho movimiento + ráfaga sonora modulada a 5 Hz (patrón tipo risa/vítores)
          + habla exclamativa
  22–40 s fondo estático + habla de cierre
La voz se sintetiza con espeak-ng (Linux/Docker) o SAPI (Windows). Si no hay sintetizador, el video
se genera sin voz y las pruebas que requieren transcripción se marcan como omitidas.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 16000
DURATION = 40.0
CALM = "Hola a todos, hoy vamos a probar el sistema de clips con una explicación tranquila del proyecto."
EXCITED = "No puede ser! Increíble! Qué es eso! Wow, esto es brutal!"
OUTRO = "Al final todo salió bien y por eso lo recomiendo. Gracias por ver el video."


def _tts(text: str, out: Path) -> bool:
    if shutil.which("espeak-ng"):
        r = subprocess.run(["espeak-ng", "-v", "es", "-s", "150", "-w", str(out), text], capture_output=True)
        return r.returncode == 0 and out.exists()
    if sys.platform == "win32":
        ps = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, 16, 1); "
            f"$s.SetOutputToWaveFile('{out}', $f); $s.Rate = 0; $s.Speak($env:CM_TTS_TEXT); $s.Dispose()"
        )
        env = {**__import__("os").environ, "CM_TTS_TEXT": text}
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, env=env)
        return r.returncode == 0 and out.exists() and out.stat().st_size > 1000
    return False


def _load_resampled(path: Path) -> np.ndarray:
    tmp = path.with_suffix(".16k.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(tmp)], check=True)
    with wave.open(str(tmp), "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return data


def make_audio(dest: Path, workdir: Path) -> bool:
    rng = np.random.default_rng(42)
    n = int(DURATION * SR)
    audio = (rng.standard_normal(n) * 0.003).astype(np.float32)  # ruido de fondo suave
    has_speech = True
    for text, at, gain in ((CALM, 1.0, 0.5), (EXCITED, 15.5, 0.9), (OUTRO, 24.0, 0.5)):
        wav = workdir / f"tts_{int(at)}.wav"
        if not _tts(text, wav):
            has_speech = False
            continue
        speech = _load_resampled(wav)
        speech = speech / (np.abs(speech).max() + 1e-6) * gain
        a = int(at * SR)
        b = min(n, a + len(speech))
        audio[a:b] += speech[: b - a]
    # Ráfaga tipo risa/vítores: ruido de banda ancha modulado a 5 Hz entre 16 y 21 s.
    a, b = int(16 * SR), int(21 * SR)
    t = np.arange(b - a) / SR
    burst = rng.standard_normal(b - a) * (0.5 + 0.5 * np.sin(2 * np.pi * 5 * t)) * 0.35
    audio[a:b] += burst.astype(np.float32)
    audio = np.clip(audio, -1, 1)
    with wave.open(str(dest), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((audio * 32767).astype(np.int16).tobytes())
    return has_speech


def make_video(dest: Path, workdir: Path) -> bool:
    """Crea el MP4 de prueba (1280x720, H.264/AAC). Devuelve si contiene voz sintetizada."""
    workdir.mkdir(parents=True, exist_ok=True)
    wav = workdir / "audio.wav"
    has_speech = make_audio(wav, workdir)
    filt = (
        "color=c=0x1d3557:s=1280x720:r=25:d=15[a];"
        "testsrc2=s=1280x720:r=25:d=7[b];"
        "color=c=0x2a9d8f:s=1280x720:r=25:d=18[c];"
        "[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[v]"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-filter_complex", filt, "-i", str(wav),
         "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
         "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(dest)],
        check=True,
    )
    return has_speech
