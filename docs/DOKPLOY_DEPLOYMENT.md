# Despliegue en Dokploy

Servidor objetivo: Ubuntu 24.04, i5 de 14.ª generación y 32 GB de RAM. GPU opcional: NVIDIA T400 4 GB y/o GTX 1080 Ti 11 GB.

> ⚠️ `compose.yaml` y los Dockerfiles se validaron sintácticamente, pero **no se han construido en una máquina con Docker**. Haz el primer despliegue en un entorno de pruebas y sigue la verificación de `TESTING.md`.

## 1. Requisitos del host

- Dokploy instalado (incluye Docker y Traefik con HTTPS).
- Un registro DNS `A` del dominio (por ejemplo `clips.example.com`) apuntando al servidor.
- Disco: los originales, los segmentos y los clips viven en el volumen `storagedata` (RustFS). Reserva espacio según tu uso; como referencia, una hora de 1080p normalizado ocupa unos 1–3 GB.
- **Solo con GPU:**

  ```bash
  # Driver NVIDIA (≥ 535 para CUDA 12) y NVIDIA Container Toolkit
  sudo ubuntu-drivers install
  # sigue https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  nvidia-smi                       # anota el índice de cada GPU
  ```

## 2. Crear la aplicación

1. Dokploy → *Create Service* → **Docker Compose**.
2. Proveedor: tu repositorio Git (rama `main`). *Compose Path*: `./compose.yaml`.
3. **Environment:** copia `.env.example` y rellena todos los secretos. Genera cada uno con `openssl rand -base64 48`:
   - `SESSION_SECRET`, `MEDIA_SIGNING_SECRET`, `INTERNAL_API_TOKEN`;
   - `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MINIO_ROOT_PASSWORD` (credenciales del almacenamiento S3; el nombre se conserva por compatibilidad);
   - `PUBLIC_URL=https://clips.example.com`;
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD` (12 caracteres o más) para el primer administrador.

   Las variables marcadas `:?` en compose son obligatorias: el despliegue falla con un mensaje claro si faltan.
4. **Domains:** añade **dos** entradas para el mismo host, con HTTPS y Let's Encrypt:

   | Host | Path | Servicio | Puerto | Strip path |
   |------|------|----------|--------|------------|
   | clips.example.com | `/api` | `api` | 4000 | **no** |
   | clips.example.com | `/` | `web` | 3000 | no |

   La API ya sirve bajo `/api`. No debe quitarse el prefijo.
5. *Deploy*. La primera construcción tarda varios minutos (dependencias de Node y Python con OpenCV y CTranslate2).

Al arrancar, la API:

- ejecuta `prisma migrate deploy`, que aplica solo migraciones pendientes y nunca hace reset;
- crea el bucket con una política privada;
- crea el administrador si no existe.

## 3. Red y exposición

- Ningún servicio publica puertos en el host. Traefik llega a `web` y `api` por `dokploy-network`.
- PostgreSQL, Redis, el almacenamiento (`storage`) y los workers solo están en la red `backend`.
- Para inspeccionar algo interno, usa la terminal del contenedor en Dokploy. No abras puertos.

## 4. GPU

`compose.gpu.yaml` es un overlay. No toques `compose.yaml`: el despliegue CPU sigue funcionando sin él. En Dokploy:

- *Advanced → Command*:

  ```
  compose -p <app> -f ./compose.yaml -f ./compose.gpu.yaml up -d --build --remove-orphans
  ```

- Variables:

  | Variable | Valor | Para qué |
  |----------|-------|----------|
  | `AI_DEVICE` | `auto` | intenta CUDA y cae a CPU si falla |
  | `AI_GPU_ID` | `1` (por ejemplo) | índice de la GTX 1080 Ti para la transcripción |
  | `RENDER_GPU_ID` | `0` (por ejemplo) | índice de la T400 para NVENC |
  | `WHISPER_MODEL` | `medium` | con 11 GB de VRAM; `small` con 4 GB |
  | `WHISPER_COMPUTE_TYPE` | `auto` | si falla o va lento en Pascal, prueba `int8_float32` o `float32` |
  | `RENDER_ENCODER` | `auto` | NVENC solo si la codificación de prueba funciona |

**Compatibilidad, sin garantías:**

- CTranslate2 4.5+ se compila contra CUDA 12 y cuDNN 9 ([instalación](https://opennmt.net/CTranslate2/installation.html)). Su compatibilidad con Pascal (GTX 1080 Ti, compute 6.1) no está asegurada en todas las versiones ([issue 1806](https://github.com/OpenNMT/CTranslate2/issues/1806)).
- La T400 (Turing TU117) dispone de NVENC H.264 ([NVENC](https://en.wikipedia.org/wiki/NVENC)), pero sus 4 GB limitan Whisper a modelos pequeños.

Por eso el código **detecta en tiempo de ejecución** y vuelve a CPU o libx264 si algo falla. *Administración* muestra el dispositivo real de cada worker.

## 5. LLM local (opcional)

1. Añade `--profile llm` al comando de compose.
2. Pon `OLLAMA_URL=http://ollama:11434`.
3. Descarga el modelo una vez desde la terminal del contenedor `ollama`: `ollama pull qwen2.5:3b-instruct`.
4. Activa «LLM semántico local» en *Ajustes*.

Sin GPU dedicada, Ollama compite por la CPU con Whisper; úsalo solo si tienes margen.

### 5b. LLM de NVIDIA (alternativa sin GPU local)

1. Crea una clave en [build.nvidia.com](https://build.nvidia.com) (empieza por `nvapi-`).
2. En *Environment*, pon `LLM_PROVIDER=nvidia` y `NVIDIA_API_KEY=nvapi-…`. Opcionalmente, `NVIDIA_MODEL`; por defecto es `nvidia/nemotron-3.5-lightning-30b-a3b`.
3. Redespliega el ai-worker. *Administración* mostrará `nvidia:<modelo>` en la columna LLM.
4. Cada usuario activa «LLM semántico» en *Ajustes*, donde se le avisa de que los fragmentos de transcripción se envían a NVIDIA.

Ten en cuenta:

- el nivel gratuito tiene créditos limitados y un tope de peticiones por minuto (unas 40, según el foro de NVIDIA). Con 12 candidatos por análisis, cada video consume unos 12 créditos;
- cuando se agotan, el análisis sigue con la puntuación local;
- revisa los términos de NVIDIA antes de usarlo en producción.

## 6. Modelos de Whisper

El ai-worker descarga el modelo de Hugging Face la primera vez y lo guarda en el volumen `models`. Para servidores sin salida a Internet, copia los modelos a ese volumen antes de procesar.

## 7. Copias de seguridad

- **PostgreSQL:**

  ```bash
  docker exec <postgres> pg_dump -U clipmaster -Fc clipmaster > clipmaster-$(date +%F).dump
  ```

  También puedes usar las copias programadas de Dokploy.
- **Almacenamiento (RustFS):** copia el volumen `storagedata` con el servicio `storage` parado, o sincroniza el bucket con cualquier cliente S3 (`aws s3 sync`, `rclone`) desde un contenedor en la red `backend`.
- `models` y los volúmenes `*-work` no necesitan copia.

## 8. Mantenimiento y disco

- La API ejecuta la limpieza cada 15 minutos: temporales caducados (`TEMP_RETENTION_HOURS`), proyectos borrados después de 24 horas, sesiones expiradas y recálculo de cuotas.
- Los workers borran su directorio de trabajo al terminar cada job.
- Los logs de Docker rotan (20 MB × 5 por servicio).

## 9. Actualizar

Haz `git push` y *Redeploy* en Dokploy. Las migraciones nuevas se aplican solas.

Los workers terminan el job en curso antes de salir (`stop_grace_period: 60s`). Los trabajos interrumpidos se reintentan y el reconciliador recupera los que quedaron colgados.

## 10. Sin Dokploy (pruebas locales)

```bash
docker network create dokploy-network   # una sola vez; compose la espera como red externa
cp .env.example .env                    # rellena los secretos; COOKIE_SECURE=false sin HTTPS
docker compose up -d --build
```

Sin Traefik no hay entrada pública. Para probar en local, añade temporalmente un `ports: ["3000:3000"]` a `web` en un `compose.override.yaml`; Next reenvía `/api` a la API.
