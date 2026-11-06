"""
Funciones de IA de NVIDIA (build.nvidia.com) para el render. Todas son opcionales y sólo se usan si el
worker tiene NVIDIA_API_KEY y el usuario las activó: envían el tramo de video, el texto del gancho o el
prompt de la portada a los servidores de NVIDIA.

- Mirada a cámara (Maxine Eye Contact) y reiluminación (Maxine Relighting): gRPC con streaming.
- Voz del título gancho: Magpie TTS multilingüe (HTTP).
- Portada: FLUX.2 klein 4B o FLUX.1-dev según NVIDIA_IMAGE_MODEL (HTTP con cola NVCF).

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

# Tamaños que aceptan los modelos FLUX de NVIDIA por formato del clip.
COVER_SIZES = {"VERTICAL": (768, 1344), "SQUARE": (1024, 1024), "HORIZONTAL": (1344, 768)}

# Modelos de imagen: función NVCF pública y parámetros propios de cada uno.
IMAGE_MODELS: dict[str, tuple[str, dict]] = {
    # FLUX.2 klein 4B (Apache 2.0): destilado, 4 pasos.
    "flux2-klein": ("f67e96d8-1c4e-422e-a913-90f00e19aa9a", {"steps": 4}),
    # FLUX.1-dev (licencia no comercial para el modelo): más realista, ~6 s con 30 pasos.
    "flux1-dev": ("0c474133-6fd2-42f6-be29-8ebbbaeaaeb2", {"mode": "base", "cfg_scale": 3.5, "steps": 30}),
}


def image_function(settings: Settings) -> str:
    return settings.nvidia_image_function or IMAGE_MODELS[settings.nvidia_image_model][0]


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


# ------------------------------------------------------------------ portada (FLUX)


class NvidiaUnavailable(NvidiaMediaError):
    """El modelo no respondió (5xx, tiempo agotado o red): puede probarse otro."""


def cover_image(settings: Settings, prompt: str, aspect: str, out: Path, *, seed: int = 0,
                client: httpx.Client | None = None, poll_interval: float = 1.0) -> Path:
    """Genera la imagen con el modelo FLUX configurado (NVIDIA_IMAGE_MODEL). Si FLUX.1-dev no responde (las
    funciones gratuitas de NVIDIA a veces devuelven 504), se genera con FLUX.2 klein y se deja constancia en el log."""
    _check(settings)
    prompt = " ".join(prompt.split())[:600]
    if len(prompt) < 3:
        raise NvidiaMediaError("Portada IA: el prompt está vacío")
    model = settings.nvidia_image_model
    try:
        return _flux(settings, image_function(settings), model, prompt, aspect, out, seed, client, poll_interval)
    except NvidiaUnavailable as exc:
        if model == "flux2-klein":
            raise
        log.warning("%s no respondió (%s); se genera con flux2-klein", model, exc)
        return _flux(settings, IMAGE_MODELS["flux2-klein"][0], "flux2-klein", prompt, aspect, out, seed, client,
                     poll_interval)


def _flux(settings: Settings, function_id: str, model: str, prompt: str, aspect: str, out: Path, seed: int,
          client: httpx.Client | None, poll_interval: float) -> Path:
    """Una invocación NVCF; puede quedar en cola (202 + NVCF-REQID) y se sondea hasta el límite configurado."""
    width, height = COVER_SIZES.get(aspect, COVER_SIZES["VERTICAL"])
    # NVCF retiene la petición hasta NVCF-POLL-SECONDS antes de responder 202; se mantiene por debajo del
    # timeout de lectura para que un arranque en frío no corte la conexión y se siga con el sondeo.
    headers = {"Authorization": f"Bearer {settings.nvidia_api_key}", "Accept": "application/json",
               "NVCF-POLL-SECONDS": "20"}
    http = client or httpx.Client(timeout=60)
    try:
        r = http.post(f"{NVCF}/pexec/functions/{function_id}", headers=headers,
                      json={"prompt": prompt, **IMAGE_MODELS[model][1], "width": width, "height": height, "seed": seed})
        deadline = time.monotonic() + settings.nvidia_media_timeout_sec
        while r.status_code == 202:
            if time.monotonic() > deadline:
                raise NvidiaUnavailable("Portada IA: NVIDIA no respondió a tiempo")
            time.sleep(poll_interval)
            r = http.get(f"{NVCF}/pexec/status/{r.headers['NVCF-REQID']}", headers=headers)
    except httpx.HTTPError as exc:
        raise NvidiaUnavailable(f"Portada IA: error de red: {exc}") from exc
    finally:
        if client is None:
            http.close()
    if r.status_code >= 500:
        raise NvidiaUnavailable(f"Portada IA: el modelo de imagen de NVIDIA no está disponible ahora ({r.status_code})")
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
