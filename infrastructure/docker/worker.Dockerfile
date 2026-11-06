# Worker Python (capture / ai / render según WORKER_ROLE). Contexto de build: raíz del repositorio.
#
#   GPU=0 (por defecto): imagen sólo CPU.
#   GPU=1: añade las bibliotecas CUDA 12 / cuDNN 9 que necesita CTranslate2 (faster-whisper).
#          El driver NVIDIA y libnvidia-encode (NVENC) los inyecta NVIDIA Container Toolkit en runtime.
FROM python:3.12-slim-trixie

ARG GPU=0
ARG INSTALL_TEST_TOOLS=0
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    WORK_DIR=/data/work WHISPER_MODELS_DIR=/models HF_HOME=/models/hf

# ffmpeg de Debian trixie (7.1) incluye libass (subtítulos), libx264 y soporte NVENC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-montserrat fonts-roboto-unhinted fonts-open-sans fonts-lato fonts-bebas-neue ca-certificates tini \
 && if [ "$INSTALL_TEST_TOOLS" = "1" ]; then apt-get install -y --no-install-recommends espeak-ng; fi \
 && rm -rf /var/lib/apt/lists/*

# Deno: runtime JavaScript que yt-dlp necesita para resolver los retos de YouTube (yt-dlp EJS).
COPY --from=denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno

WORKDIR /app
COPY services/worker/requirements.txt services/worker/requirements-dev.txt ./
RUN pip install -r requirements.txt \
 && if [ "$GPU" = "1" ]; then pip install "nvidia-cublas-cu12==12.*" "nvidia-cudnn-cu12==9.*"; fi \
 && if [ "$INSTALL_TEST_TOOLS" = "1" ]; then pip install -r requirements-dev.txt; fi

# Modelo de recorte de personas para miniaturas y portadas (U²-Net human seg, Apache 2.0, 176 MB). Se descarga
# antes de copiar el código para que la capa quede en caché; el hash debe coincidir con MODEL_SHA256 de segment.py.
ARG SEG_MODEL_URL=https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx
ARG SEG_MODEL_SHA256=01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c
ENV SEGMENTATION_MODEL_PATH=/opt/models/u2net_human_seg.onnx
RUN python -c "import hashlib,os,sys,urllib.request as u; p=os.environ['SEGMENTATION_MODEL_PATH']; os.makedirs(os.path.dirname(p),exist_ok=True); u.urlretrieve(sys.argv[1],p); h=hashlib.sha256(open(p,'rb').read()).hexdigest(); sys.exit(0 if h==sys.argv[2] else 'hash del modelo de recorte no coincide: '+h)" "$SEG_MODEL_URL" "$SEG_MODEL_SHA256"

# Rutas de las bibliotecas CUDA instaladas por pip (inexistentes y sin efecto en la imagen CPU).
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib

COPY services/worker/clipmaster_worker ./clipmaster_worker
COPY services/worker/tests ./tests
COPY services/worker/pyproject.toml ./
COPY packages/shared/config ./shared-config

RUN useradd --create-home --uid 10001 worker \
 && mkdir -p /data/work /models \
 && chown -R worker:worker /data /models /app
USER worker

EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status==200 else 1)"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "clipmaster_worker.main"]
