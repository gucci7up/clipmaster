# Pruebas

## Resumen (última ejecución: 2026-11-03, Windows 11, sin Docker)

| Suite | Comando | Resultado |
|-------|---------|-----------|
| Worker (unitarias + e2e real + proveedores LLM simulados) | `cd services/worker && .venv/Scripts/python -m pytest -q` | **103 passed**, 2 omitidas (NVIDIA real) |
| API (unitarias) | `pnpm --filter @clipmaster/api test` | **23 passed** (la integración se omite sin BD) |
| API (integración con PostgreSQL 17 real) | `TEST_DATABASE_URL=postgresql://… pnpm --filter @clipmaster/api test` | **43 passed** |
| Compartido | `pnpm --filter @clipmaster/shared test` | **13 passed** |
| Web (utilidades) | `pnpm --filter @clipmaster/web test` | **3 passed** |
| Tipos | `pnpm -r typecheck` | sin errores |
| Build web | `pnpm --filter @clipmaster/web build` | 13 rutas compiladas |
| Migración | `prisma migrate deploy` sobre PostgreSQL 17 | aplicada; `migrate status` al día |

## Prueba de extremo a extremo del pipeline (`services/worker/tests/test_e2e_pipeline.py`)

Usa un **video real generado localmente** (`tests/fixtures.py`, sin descargas):

- 40 s a 1280×720;
- voz sintética en español: SAPI en Windows, `espeak-ng` en Linux;
- una ráfaga de ruido modulado a 5 Hz entre los segundos 16 y 21, que imita risas;
- una escena `testsrc2` con mucho movimiento entre los segundos 15 y 22.

Sobre ese video se ejecuta el código de producción, con almacenamiento local en lugar de S3:

1. **Importación:** normalización y ffprobe (duración de 40 s ± 0,5 s, H.264/AAC).
2. **Transcripción:** faster-whisper `tiny` en CPU. Se exigen texto y palabras con tiempos.
3. **Análisis:** el mejor candidato debe cubrir el evento sintético (risas y cambio de escena) y cumplir los límites de duración.
4. **Render** en 9:16, 16:9 y 1:1. ffprobe comprueba H.264 + AAC, la relación de aspecto, la duración y que existan miniatura y subtítulos ASS.
5. **Progreso:** se comprueba que los eventos de progreso sean reales (monótonos y procedentes de FFmpeg y Whisper).

La primera ejecución descarga el modelo `tiny` de Hugging Face (unos 75 MB) a `WHISPER_MODELS_DIR`.

Para ejecutarla dentro del contenedor del worker, construye la imagen con las herramientas de prueba:

```bash
docker build -f infrastructure/docker/worker.Dockerfile --build-arg INSTALL_TEST_TOOLS=1 -t clipmaster-worker:test .
docker run --rm -e STORAGE_BACKEND=local clipmaster-worker:test python -m pytest -q
```

## Integración de la API con PostgreSQL (`apps/api/test/pipeline.int.spec.ts`)

Ejecuta el `PipelineService` real contra PostgreSQL con las migraciones aplicadas. Simula los mensajes de los workers (`onStart`, `onProgress`, `onComplete`, `onFail`) y comprueba:

- el flujo completo: subida → importación → análisis → selección (descarta solapados y de baja puntuación) → render → `COMPLETED`;
- la idempotencia: un `startImport` repetido no crea otro job, un `onComplete` duplicado devuelve `{duplicate:true}` y `onStart` de un job terminado no se procesa;
- la transición de estados por etapa: `DOWNLOADING` → `TRANSCRIBING` → `GENERATING` → `COMPLETED`;
- las palabras de la transcripción que se pasan al render para los subtítulos;
- la contabilidad de cuota, las pistas de subtítulos y los eventos persistidos;
- un fallo con reintento frente a un fallo definitivo, con el historial de errores;
- que un render regenerado que falla conserve el render anterior;
- la cancelación: se señala a los workers y los jobs pendientes ya no se procesan.

La cola BullMQ se sustituye por un registro en memoria, así que esta prueba **no** cubre Redis.

Para tener una base de datos de pruebas desechable sin Docker:

```bash
# cualquier PostgreSQL vacío; por ejemplo, el de compose:
docker compose up -d postgres
TEST_DATABASE_URL=postgresql://clipmaster:<pass>@<host>:5432/clipmaster_test pnpm --filter @clipmaster/api exec prisma migrate deploy
TEST_DATABASE_URL=... pnpm --filter @clipmaster/api test
```

## Qué NO está verificado todavía

- **El stack completo en Docker / Dokploy.** No había Docker en la máquina de desarrollo. `compose.yaml` y `compose.gpu.yaml` se validaron sintácticamente, pero no se han construido ni ejecutado.
- **La interoperabilidad BullMQ Node ↔ Python con Redis real.** El protocolo se basa en la lectura del código fuente de ambas bibliotecas (mismo prefijo, nombres de cola, `jobId` y formato de datos), sin una prueba de ejecución conjunta.
- **CUDA y NVENC en la T400 o la GTX 1080 Ti.** La detección y el retorno a CPU están implementados y probados en modo CPU; el camino GPU no se ha ejecutado en ese hardware.
- **Descargas reales de YouTube, Twitch, Kick y TikTok, y capturas de directos.** Dependen de la red y de las plataformas, así que no forman parte de la batería automática.
- **Las funciones de NVIDIA, con la API real, sólo en local:** `NVIDIA_LIVE_TESTS=1 NVIDIA_API_KEY=… NVIDIA_LIVE_VIDEO=<mp4 con una cara> pytest tests/test_nvidia_live.py` renderiza un clip con mirada, iluminación, voz y portada, y analiza con fotogramas (2 passed el 2026-11-03). No se ejecuta en CI porque consume créditos.
- **Llamadas reales a Ollama.** `tests/test_llm_providers.py` cubre la petición, la autenticación, el parseo, el rechazo de JSON inválido y la parada ante 401/402/403/429, pero con `httpx.MockTransport`.
- **El frontend en navegador.** Compila, pasa el typecheck y genera las 13 rutas, pero no se ha ejecutado contra una API en marcha.

## Verificación tras desplegar

1. `https://<dominio>/api/health` devuelve `ok:true` con db, redis y storage, y lista los tres workers.
2. Inicia sesión como administrador. En *Administración* deben aparecer los workers capture, ai y render con su dispositivo.
3. Sube un MP4 corto con voz. El proyecto debe pasar por Importando → Transcribiendo → Analizando → Generando clips → Completado, con progreso real en la tarjeta *Procesamiento*.
4. Descarga un clip y compruébalo: `ffprobe -v error -show_streams clip.mp4`.
5. Con GPU: en *Administración* el ai-worker debe mostrar `cuda`. Si muestra `cpu`, revisa sus logs en busca de un aviso de retorno a CPU.
