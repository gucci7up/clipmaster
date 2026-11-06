"""Funciones de NVIDIA para el render (voz y portada) con HTTP simulado, y contrato del job."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from clipmaster_worker import nvidia_media as nv
from clipmaster_worker.config import Settings
from clipmaster_worker.contracts import RenderAI, parse_job

KEY = Settings(nvidia_api_key="nvapi-test", nvidia_media_timeout_sec=5)
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 2000
WAV = b"RIFF" + b"\0" * 4000


def client(handler, calls: list):
    return httpx.Client(transport=httpx.MockTransport(lambda req: (calls.append(req), handler(req))[1]))


def test_sin_clave_no_se_llama_a_nvidia(tmp_path):
    assert Settings().ai_media is False and KEY.ai_media is True
    with pytest.raises(nv.NvidiaMediaError, match="NVIDIA_API_KEY"):
        nv.synthesize(Settings(), "hola", "Magpie-Multilingual.ES-US.Diego", tmp_path / "v.wav")
    with pytest.raises(nv.NvidiaMediaError, match="NVIDIA_API_KEY"):
        nv.cover_image(Settings(), "cancha", "VERTICAL", tmp_path / "c.jpg")


def test_voz_envia_texto_y_voz_en_espanol(tmp_path):
    calls: list[httpx.Request] = []
    out = nv.synthesize(KEY, "  ¡Esta es   la posición! ", "Magpie-Multilingual.ES-US.Diego.Happy", tmp_path / "v.wav",
                        client=client(lambda r: httpx.Response(200, content=WAV), calls))
    assert out.read_bytes() == WAV
    req = calls[0]
    assert req.headers["authorization"] == "Bearer nvapi-test"
    body = req.content.decode()
    assert "¡Esta es la posición!" in body and "es-US" in body and "Magpie-Multilingual.ES-US.Diego.Happy" in body


def test_voz_rechaza_voces_de_otro_idioma_y_respuestas_no_wav(tmp_path):
    with pytest.raises(nv.NvidiaMediaError, match="voz no admitida"):
        nv.synthesize(KEY, "hola", "Magpie-Multilingual.EN-US.Aria", tmp_path / "v.wav")
    calls: list = []
    with pytest.raises(nv.NvidiaMediaError, match="WAV"):
        nv.synthesize(KEY, "hola", "Magpie-Multilingual.ES-US.Diego", tmp_path / "v.wav",
                      client=client(lambda r: httpx.Response(200, content=b"<html>" * 400), calls))


@pytest.mark.parametrize("status,msg", [(401, "rechazó la clave"), (429, "límite"), (500, "respondió 500")])
def test_voz_errores_de_nvidia(tmp_path, status, msg):
    with pytest.raises(nv.NvidiaMediaError, match=msg):
        nv.synthesize(KEY, "hola", "Magpie-Multilingual.ES-US.Diego", tmp_path / "v.wav",
                      client=client(lambda r: httpx.Response(status, text="x"), []))


def test_portada_espera_la_cola_nvcf_y_guarda_la_imagen(tmp_path):
    calls: list[httpx.Request] = []
    replies = iter([
        httpx.Response(202, headers={"NVCF-REQID": "req-1"}),
        httpx.Response(202, headers={"NVCF-REQID": "req-1"}),
        httpx.Response(200, json={"artifacts": [{"base64": base64.b64encode(JPEG).decode(), "finishReason": "SUCCESS"}]}),
    ])
    out = nv.cover_image(KEY, "cancha de voleibol de noche", "VERTICAL", tmp_path / "c.jpg", poll_interval=0,
                         client=client(lambda r: next(replies), calls))
    assert out.read_bytes() == JPEG
    assert calls[0].method == "POST" and calls[0].url.path.endswith("/pexec/functions/f67e96d8-1c4e-422e-a913-90f00e19aa9a")
    body = json.loads(calls[0].content)
    assert body["width"] == 768 and body["height"] == 1344 and body["steps"] == 4 and "mode" not in body
    assert [c.url.path for c in calls[1:]] == ["/v2/nvcf/pexec/status/req-1"] * 2


def test_portada_con_flux1_dev_usa_su_funcion_y_parametros(tmp_path):
    calls: list[httpx.Request] = []
    ok = httpx.Response(200, json={"artifacts": [{"base64": base64.b64encode(JPEG).decode(), "finishReason": "SUCCESS"}]})
    dev = Settings(nvidia_api_key="nvapi-test", nvidia_image_model="flux1-dev")
    nv.cover_image(dev, "mesa de dominó", "HORIZONTAL", tmp_path / "c.jpg", client=client(lambda r: ok, calls))
    assert calls[0].url.path.endswith("/pexec/functions/0c474133-6fd2-42f6-be29-8ebbbaeaaeb2")
    body = json.loads(calls[0].content)
    assert body == {"prompt": "mesa de dominó", "mode": "base", "cfg_scale": 3.5, "steps": 30,
                    "width": 1344, "height": 768, "seed": 0}
    # Un ID explícito sustituye al conocido; un modelo desconocido no se acepta.
    override = Settings(nvidia_api_key="nvapi-test", nvidia_image_model="flux1-dev", nvidia_image_function="otro-id")
    assert nv.image_function(override) == "otro-id"
    with pytest.raises(Exception):
        Settings(nvidia_image_model="sdxl")


def test_si_flux1_dev_no_responde_se_genera_con_klein(tmp_path):
    calls: list[httpx.Request] = []
    ok = httpx.Response(200, json={"artifacts": [{"base64": base64.b64encode(JPEG).decode(), "finishReason": "SUCCESS"}]})
    dev = Settings(nvidia_api_key="nvapi-test", nvidia_image_model="flux1-dev")
    out = nv.cover_image(dev, "mesa de dominó", "SQUARE", tmp_path / "c.jpg",
                         client=client(lambda r: httpx.Response(504) if "0c474133" in r.url.path else ok, calls))
    assert out.read_bytes() == JPEG
    assert [c.url.path.rsplit("/", 1)[1][:8] for c in calls] == ["0c474133", "f67e96d8"]
    assert json.loads(calls[1].content)["steps"] == 4 and calls[0].headers["nvcf-poll-seconds"] == "20"
    # Con klein no hay a qué recurrir; un 4xx (clave, créditos) tampoco provoca el cambio.
    with pytest.raises(nv.NvidiaMediaError, match="no está disponible"):
        nv.cover_image(KEY, "algo", "SQUARE", tmp_path / "c.jpg", client=client(lambda r: httpx.Response(504), []))
    calls.clear()
    with pytest.raises(nv.NvidiaMediaError, match="límite"):
        nv.cover_image(dev, "algo", "SQUARE", tmp_path / "c.jpg", client=client(lambda r: httpx.Response(429), calls))
    assert len(calls) == 1


def test_portada_rechaza_filtro_de_contenido_y_basura(tmp_path):
    blocked = httpx.Response(200, json={"artifacts": [{"base64": "", "finishReason": "CONTENT_FILTERED"}]})
    with pytest.raises(nv.NvidiaMediaError, match="CONTENT_FILTERED"):
        nv.cover_image(KEY, "algo", "SQUARE", tmp_path / "c.jpg", client=client(lambda r: blocked, []))
    junk = httpx.Response(200, json={"artifacts": [{"base64": base64.b64encode(b"no es imagen").decode()}]})
    with pytest.raises(nv.NvidiaMediaError, match="imagen"):
        nv.cover_image(KEY, "algo", "SQUARE", tmp_path / "c.jpg", client=client(lambda r: junk, []))


def test_iluminacion_solo_presets_validos(tmp_path):
    with pytest.raises(nv.NvidiaMediaError, match="desconocida"):
        nv.relight(KEY, tmp_path / "x.mp4", tmp_path / "y.mp4", 9)
    with pytest.raises(Exception):
        RenderAI(relight=5)


def test_job_de_render_acepta_ai_opcional():
    base = {"kind": "render", "jobId": "j", "projectId": "p", "userId": "u", "clipId": "c", "renderId": "r",
            "sources": [{"key": "k", "offsetSec": 0, "durationSec": 10}], "start": 0, "end": 5, "aspect": "VERTICAL",
            "subtitles": {"enabled": False, "style": {}, "words": []}, "reframe": {"mode": "center"}, "outputPrefix": "clips/u/p"}
    assert parse_job(base).ai is None
    job = parse_job({**base, "ai": {"eyeContact": True, "relight": 2, "hookVoice": "Magpie-Multilingual.ES-US.Isabela",
                                    "coverPrompt": "portada"}})
    assert job.ai.eyeContact and job.ai.relight == 2 and job.ai.coverPrompt == "portada"
