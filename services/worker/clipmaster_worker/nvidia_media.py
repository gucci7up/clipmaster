"""
Funciones de IA de NVIDIA (build.nvidia.com) para el render. Todas son opcionales y sólo se usan si el
worker tiene NVIDIA_API_KEY y el usuario las activó: envían el tramo de video, el texto del gancho o el
prompt de la portada a los servidores de NVIDIA.

- Mirada a cámara (Maxine Eye Contact) y reiluminación (Maxine Relighting): gRPC con streaming.
- Voz del título gancho: Magpie TTS multilingüe (HTTP).
- Portada: FLUX.2 klein 4B (HTTP con cola NVCF).

Cada función devuelve un archivo local o lanza NvidiaMediaError; el render decide si continúa sin el efecto.
"""

from __future__ import annotations

import base64
import logging
import time
from pathlib import Path
from typing import Callable, Iterator

import httpx

from .config import Settings
from .media import MediaError, probe, run_ffmpeg

log = logging.getLogger(__name__)

CHUNK = 64 * 1024
NVCF = "https://api.nvcf.nvidia.com/v2/nvcf"

# Presets de iluminación incluidos en el servicio (hdri_preset_id).
RELIGHT_PRESETS = {0: "Salón", 1: "Calle de noche", 2: "Invernadero", 3: "París", 4: "Estudio de madera"}

# Tamaños que acepta FLUX.2 klein por formato del clip.
COVER_SIZES = {"VERTICAL": (768, 1344), "SQUARE": (1024, 1024), "HORIZONTAL": (1344, 768)}


class NvidiaMediaError(Exception):
    """El servicio de NVIDIA no devolvió un resultado utilizable."""


def _check(settings: Settings) -> None:
    if not settings.nvidia_api_key:
        raise NvidiaMediaError("Falta NVIDIA_API_KEY en el worker")


def _status_error(service: str, code: int, body: str) -> NvidiaMediaError:
    if code in (401, 403):
        return NvidiaMediaError(f"{service}: NVIDIA rechazó la clave ({code})")
    if code in (402, 429):
        return NvidiaMediaError(f"{service}: sin créditos o límite de peticiones de NVIDIA ({code})")
    return NvidiaMediaError(f"{service}: NVIDIA respondió {code}: {body[:200]}")


# ------------------------------------------------------------------ video (gRPC)


def prepare_segment(src: str, start: float, duration: float, out: Path, *, max_height: int = 1080,
                    fps: float | None = None, cancel: Callable[[], bool] | None = None) -> Path:
    """Corta el tramo a un MP4 H.264/AAC «streamable» (moov al principio) y con fotogramas a ritmo constante:
    los servicios Maxine rechazan el VFR (y Eye Contact devuelve VFR, así que se normaliza entre efectos)."""
    rate = fps or probe(src).fps or 30.0
    rate = min(60.0, max(10.0, rate))
    run_ffmpeg(["-ss", f"{start:.3f}", "-i", src, "-t", f"{duration:.3f}", "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", f"scale=-2:'min({max_height},ih)',fps={rate:.3f}", "-fps_mode", "cfr",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)],
               duration=duration, cancel=cancel)
    return out


def _file_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            yield chunk


def _grpc_video(settings: Settings, service: str, function_id: str, call: Callable, requests: Iterator,
                field: str, out: Path) -> Path:
    import grpc  # dependencia sólo de esta función: el resto del worker no la necesita

    meta = (("authorization", f"Bearer {settings.nvidia_api_key}"), ("function-id", function_id))
    data = bytearray()
    try:
        with grpc.secure_channel(settings.nvidia_grpc_target, grpc.ssl_channel_credentials()) as channel:
            for resp in call(channel)(requests, metadata=meta, timeout=settings.nvidia_media_timeout_sec):
                if resp.HasField(field):
                    data += getattr(resp, field)
    except grpc.RpcError as exc:
        code = exc.code()
        detail = (exc.details() or "")[:200]
        if code in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED):
            raise NvidiaMediaError(f"{service}: NVIDIA rechazó la clave") from exc
        if code == grpc.StatusCode.RESOURCE_EXHAUSTED:
            raise NvidiaMediaError(f"{service}: sin créditos o límite de peticiones de NVIDIA") from exc
        raise NvidiaMediaError(f"{service}: {code.name} {detail}") from exc
    if len(data) < 1024:
        raise NvidiaMediaError(f"{service}: NVIDIA no devolvió video")
    out.write_bytes(bytes(data))
    return out


def eye_contact(settings: Settings, src: Path, out: Path) -> Path:
    """Redirige la mirada hacia la cámara (Maxine Eye Contact)."""
    _check(settings)
    from .nvidia_grpc.nvidia.maxine.eyecontact.v1 import eyecontact_pb2 as pb
    from .nvidia_grpc.nvidia.maxine.eyecontact.v1 import eyecontact_pb2_grpc as pbg

    def requests():
        yield pb.RedirectGazeRequest(config=pb.RedirectGazeConfig())
        for chunk in _file_chunks(src):
            yield pb.RedirectGazeRequest(video_file_data=chunk)

    return _grpc_video(settings, "Mirada a cámara", settings.nvidia_eyecontact_function,
                       lambda ch: pbg.MaxineEyeContactServiceStub(ch).RedirectGaze, requests(), "video_file_data", out)


def relight(settings: Settings, src: Path, out: Path, preset: int) -> Path:
    """Reilumina a la persona con uno de los entornos HDR incluidos en el servicio (Maxine Relighting)."""
    _check(settings)
    if preset not in RELIGHT_PRESETS:
        raise NvidiaMediaError(f"Iluminación desconocida: {preset}")
    from .nvidia_grpc.nvidia.ai4m.relighting.v1 import relighting_pb2 as pb
    from .nvidia_grpc.nvidia.ai4m.relighting.v1 import relighting_pb2_grpc as pbg

    def requests():
        yield pb.RelightRequest(config=pb.RelightConfig(hdri_preset_id=preset))
        for chunk in _file_chunks(src):
            yield pb.RelightRequest(video_data=chunk)

    return _grpc_video(settings, "Iluminación IA", settings.nvidia_relight_function,
                       lambda ch: pbg.VideoRelightingServiceStub(ch).Relight, requests(), "video_data", out)


# ------------------------------------------------------------------ voz (Magpie TTS)


def synthesize(settings: Settings, text: str, voice: str, out: Path, *, client: httpx.Client | None = None) -> Path:
    """Locución del texto con una voz Magpie en español (WAV PCM 44,1 kHz)."""
    _check(settings)
    text = " ".join(text.split())[:400]
    if not text:
        raise NvidiaMediaError("Voz IA: no hay texto")
    if ".ES-US." not in voice:
        raise NvidiaMediaError(f"Voz IA: voz no admitida: {voice}")
    http = client or httpx.Client(timeout=120)
    try:
        r = http.post(settings.nvidia_tts_url, headers={"Authorization": f"Bearer {settings.nvidia_api_key}"}, files={
            "text": (None, text), "language": (None, "es-US"), "voice": (None, voice),
            "encoding": (None, "LINEAR_PCM"), "sample_rate_hz": (None, "44100"),
        })
    except httpx.HTTPError as exc:
        raise NvidiaMediaError(f"Voz IA: error de red: {exc}") from exc
    finally:
        if client is None:
            http.close()
    if r.status_code != 200:
        raise _status_error("Voz IA", r.status_code, r.text)
    if len(r.content) < 1000 or r.content[:4] != b"RIFF":
        raise NvidiaMediaError("Voz IA: NVIDIA no devolvió audio WAV")
    out.write_bytes(r.content)
    return out


# ------------------------------------------------------------------ portada (FLUX.2 klein)


def cover_image(settings: Settings, prompt: str, aspect: str, out: Path, *, seed: int = 0,
                client: httpx.Client | None = None, poll_interval: float = 1.0) -> Path:
    """Genera la portada con FLUX.2 klein 4B. La invocación NVCF puede quedar en cola (202 + NVCF-REQID)."""
    _check(settings)
    prompt = " ".join(prompt.split())[:600]
    if len(prompt) < 3:
        raise NvidiaMediaError("Portada IA: el prompt está vacío")
    width, height = COVER_SIZES.get(aspect, COVER_SIZES["VERTICAL"])
    headers = {"Authorization": f"Bearer {settings.nvidia_api_key}", "Accept": "application/json"}
    http = client or httpx.Client(timeout=60)
    try:
        r = http.post(f"{NVCF}/pexec/functions/{settings.nvidia_image_function}", headers=headers,
                      json={"prompt": prompt, "width": width, "height": height, "steps": 4, "seed": seed})
        deadline = time.monotonic() + settings.nvidia_media_timeout_sec
        while r.status_code == 202:
            if time.monotonic() > deadline:
                raise NvidiaMediaError("Portada IA: NVIDIA no respondió a tiempo")
            time.sleep(poll_interval)
            r = http.get(f"{NVCF}/pexec/status/{r.headers['NVCF-REQID']}", headers=headers)
    except httpx.HTTPError as exc:
        raise NvidiaMediaError(f"Portada IA: error de red: {exc}") from exc
    finally:
        if client is None:
            http.close()
    if r.status_code != 200:
        raise _status_error("Portada IA", r.status_code, r.text)
    try:
        art = r.json()["artifacts"][0]
        if art.get("finishReason") not in (None, "SUCCESS"):
            raise NvidiaMediaError(f"Portada IA: NVIDIA no generó la imagen ({art.get('finishReason')})")
        image = base64.b64decode(art["base64"])
    except (KeyError, IndexError, ValueError, TypeError) as exc:
        raise NvidiaMediaError("Portada IA: respuesta inesperada de NVIDIA") from exc
    if image[:3] != b"\xff\xd8\xff" and image[:8] != b"\x89PNG\r\n\x1a\n":
        raise NvidiaMediaError("Portada IA: NVIDIA no devolvió una imagen")
    out.write_bytes(image)
    return out


def wrap_media_error(exc: Exception) -> str:
    """Mensaje corto para el estado del efecto en el resultado del render."""
    if isinstance(exc, (NvidiaMediaError, MediaError)):
        return str(exc)[:300]
    return f"{exc.__class__.__name__}: {str(exc)[:200]}"
