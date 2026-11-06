# Pipeline de IA

Todo se ejecuta en el propio servidor. Las excepciones son opcionales: el paso LLM (Ollama local o la API de NVIDIA, externa), el análisis con fotogramas y las funciones de IA de NVIDIA en el render. Todas vienen desactivadas: el administrador tiene que configurar la clave y cada usuario activarlas en *Ajustes*.

Código: `services/worker/clipmaster_worker/` (`analysis.py` orquesta los pasos).

## 1. Entrada

El análisis recibe una lista de `MediaSource {key, offsetSec, durationSec}`:

- **VOD:** el MP4 normalizado.
- **Directo:** el segmento nuevo más el anterior como contexto.

En los dos casos recibe además:

- una **ventana**, el tramo que se analiza;
- un **foco**, el tramo donde pueden empezar los clips nuevos.

Si hay varias fuentes, se concatenan con FFmpeg (`concat_sources`).

## 2. Pasos

| # | Paso | Implementación | Si falla |
|---|------|----------------|----------|
| 1 | Audio | FFmpeg → PCM 16 kHz mono | el job falla |
| 2 | Transcripción | faster-whisper con timestamps por palabra y VAD | el job falla |
| 3 | Re-segmentación | frases por puntuación, pausas de 0,7 s o 12 palabras como máximo | — |
| 4 | Señales de audio | rejilla de 0,5 s: volumen, onsets, ráfagas (risas/aplausos), gritos, silencio | módulo `failed`, peso redistribuido |
| 5 | Señales visuales | OpenCV sobre un pipe rawvideo de FFmpeg (2 fps, 480 px): movimiento, cambios de escena, rostros Haar | módulo `skipped`/`failed`, peso redistribuido |
| 6 | Semántica léxica | léxicos ES/EN, expresiones dominicanas y léxico de dominó | — |
| 7 | Puntuación y límites | curva de interés → picos → búsqueda de límites → componentes → NMS | — |
| 8 | LLM (opcional) | `LLM_PROVIDER=ollama`: `/api/chat` con `format` = JSON Schema · `LLM_PROVIDER=nvidia`: `/chat/completions` (formato OpenAI) con el esquema en el prompt. En los dos casos se valida con Pydantic | se ignora y se registra (`semantic_llm: failed`) |

El resultado incluye `modules` (con el valor `ok`, `skipped` o `failed` para cada paso), `timings`, `device` y `model`. La API guarda todo esto en el evento `analysis.completed`, así que en la UI se ve qué módulos funcionaron de verdad.

### Transcripción

- **Español prioritario:** el idioma por defecto es `es` y se usa un `initial_prompt` con vocabulario coloquial caribeño y dominicano para orientar la ortografía.
- `condition_on_previous_text=False` evita bucles de alucinación.
- **Por lotes:** con `WHISPER_BATCH_SIZE>0` (8 por defecto) se usa `BatchedInferencePipeline`: el VAD corta el audio en tramos de voz y se transcriben varios a la vez. En CPU (i5-12500, `small`, int8) fue ~25 % más rápido que el modo secuencial con la misma salida; en GPU la mejora es mayor. `WHISPER_BATCH_SIZE=0` vuelve al modo secuencial.
- `WHISPER_CPU_THREADS=0` (por defecto) usa todos los núcleos. El log del ai-worker registra la velocidad real (`Transcripción: N s de audio en M s (Xx tiempo real…)`) y la interfaz muestra el tiempo restante estimado a partir de esa velocidad.
- Se descartan segmentos vacíos y los que tienen a la vez `no_speech_prob > 0,8` y `avg_logprob < −1` (habla improbable). El VAD de faster-whisper elimina además los tramos sin voz.
- **Dispositivo:**
  - Con `DEVICE=auto`, se intenta CUDA. Si la carga o la ejecución fallan (cuBLAS/cuDNN ausentes o GPU no compatible), se vuelve a CPU y se registra un aviso.
  - Con `DEVICE=cpu`, nunca se intenta CUDA.
- `WHISPER_COMPUTE_TYPE=auto` elige `int8` en CPU y `float16` en CUDA. En Pascal (GTX 1080 Ti) conviene probar `int8_float32` o `float32` si `float16` es lento o falla.

### Señales de audio (`audio_signals.py`)

- `loud`: RMS en dB normalizado con percentiles del propio video, así que es robusto ante diferencias de ganancia.
- `onset`: flujo espectral positivo.
- `burst`: modulación de energía entre 2 y 8 Hz (el ritmo de una carcajada o un aplauso) multiplicada por la planitud espectral. Así la voz normal, que es tonal, no dispara la señal.
- `shout`: energía alta con centroide espectral elevado.
- `silence`: celdas por debajo del umbral relativo.

### Señales visuales (`visual_signals.py`)

- Movimiento: diferencia absoluta media entre frames en escala de grises.
- Escena: distancia entre histogramas HSV con umbral adaptativo.
- Rostros: Haar `frontalface_default`. Su trayectoria también alimenta el reencuadre.
- Se omiten si el modo tiene `visual:false`, si el usuario las desactivó o si el video supera `VISUAL_MAX_MINUTES`.

### Puntuación (`scoring.py`)

1. **Curva de interés.** Es la suma ponderada de los canales disponibles, suavizada con un filtro gaussiano.
2. **Picos.** Se buscan máximos locales con una separación mínima.
3. **Límites.** Para cada pico se prueban inicios en arranques de frase, silencios y cortes de escena, y finales en finales de frase. La duración se mantiene dentro de `[min, max]`.
   - Gracias a las sumas acumuladas, cada ventana se evalúa en O(1).
   - Se penaliza cortar a mitad de frase (−0,2 por extremo) y alejarse de la duración objetivo.
   - Se premia que el pico caiga entre el 25 % y el 85 % del clip.
4. **Componentes, de 0 a 1.**
   - `semantic`: léxico más densidad de habla.
   - `emotion`: risas, gritos y exclamaciones.
   - `audio`: energía.
   - `visual`: movimiento y escena.
   - `narrative`: arco pregunta→respuesta, posición del pico.
   - `standalone`: empieza y termina en frase completa.
   - `chat`: **sin datos todavía.** La ingesta del chat de directos no está implementada, así que su peso se redistribuye.
5. **Puntuación final.** `score = 100 × Σ wᵢ·cᵢ / Σ wᵢ` sobre los componentes disponibles. Después se aplica `silencePenalty` según la fracción de silencio.
6. **Deduplicación.** Se descartan candidatos que se solapen más de un 40 % o cuyo texto tenga una similitud de Jaccard mayor que 0,6.

Los pesos de cada modo están en `packages/shared/config/modes.json`, el único archivo que leen tanto la API como los workers. El usuario puede sobrescribirlos en *Ajustes → Motor de IA*.

### Selección (API, `selection.ts`)

- El umbral es `minScore` del modo: +10 con la preferencia «calidad» y −10 con «cantidad».
- El solapamiento máximo con clips ya existentes es del 50 %.
- En VOD, si ningún candidato supera el umbral, se crea uno solo marcado como **«[Confianza baja]»**. En directos no se hace.

### Títulos y motivos

- **Título:** la frase más informativa del tramo, recortada. Si no hay habla, se usa una plantilla según las etiquetas (por ejemplo «Reacción con risas en 12:30»).
- **Motivo:** las etiquetas detectadas y los componentes principales en lenguaje natural.
- Con el LLM activado, este puede proponer el título y el motivo, siempre validados contra el esquema.

### LLM: qué se envía y cuándo se detiene

- Se evalúan como máximo `LLM_MAX_CANDIDATES` candidatos (12 por defecto), con una llamada por candidato y solo su texto (3.500 caracteres como máximo). Nunca se envían audio ni video.
- La salida se fusiona con la puntuación local: `semantic` = 0,4 × local + 0,6 × LLM, y `standalone` = media de ambos.
- **NVIDIA:**
  - si responde 401, 402, 403 o 429 (clave inválida, sin créditos o límite de peticiones), se dejan de hacer llamadas en ese análisis y el resto de candidatos conserva la puntuación local;
  - las respuestas que no son JSON válido o no cumplen el esquema se descartan; se toleran los bloques ```json;
  - `NVIDIA_BASE_URL` permite apuntar a un NIM autoalojado compatible con OpenAI.
- **Análisis visual con IA** (`visionLLM`, opcional): si el usuario lo activa y el proveedor es NVIDIA, cada llamada incluye además 3 fotogramas JPEG de 448 px del candidato y usa `NVIDIA_VISION_MODEL` (Nemotron 3 Nano Omni). Probado con la API real.

### Funciones de IA de NVIDIA en el render (opcionales)

Las aplica el render-worker sólo si el administrador configuró `NVIDIA_API_KEY` en él y el usuario activó «Funciones de IA de NVIDIA» en *Ajustes*. Cada clip las elige en su editor:

| Función | Servicio de NVIDIA | Qué se envía |
|---|---|---|
| Mirada a cámara | Maxine Eye Contact (gRPC, `grpc.nvcf.nvidia.com`) | el tramo del clip (H.264, ≤1080p) |
| Iluminación (5 presets) | Maxine Relighting (gRPC) | el tramo del clip |
| Voz del título gancho | Magpie TTS multilingüe, voces es-US | el texto del gancho |
| Portada y fondo de miniatura | FLUX.2 klein 4B (Apache 2.0, predeterminado) o FLUX.1-dev con `NVIDIA_IMAGE_MODEL=flux1-dev` | la descripción escrita por el usuario |

- Los efectos de video se aplican antes de recortar y subtitular; entre uno y otro se normaliza a fotogramas constantes porque Relighting rechaza video de fotogramas variables. Desfase medido de audio y video: 0–1 fotograma.
- La voz se mezcla sobre el audio original (bajado al 30 % mientras habla).
- Si una función falla (sin créditos, límite, error del servicio), el clip se entrega sin ella y `ClipRender.aiStatus` guarda el motivo, que el editor muestra.
- **Modelo de imagen:** `NVIDIA_IMAGE_MODEL` en el render-worker. `flux2-klein` (predeterminado) tiene licencia Apache 2.0. `flux1-dev` es más fiel (en la prueba dibujó fichas de dominó reales donde klein dibujó dados), pero la licencia FLUX.1 [dev] sólo permite usar el modelo sin fines comerciales; las imágenes generadas sí pueden usarse comercialmente. Si se cobra por el servicio hace falta una licencia comercial de Black Forest Labs. La función gratuita de FLUX.1-dev es intermitente (el 2026-11-06 respondió en 6 s y horas después devolvía 504): si no responde, el worker lo registra en el log y genera la imagen con FLUX.2 klein, así que la miniatura o portada no falla, pero tarda unos 20 s más. FLUX.1 Kontext (editar el fotograma) no se integra: NVIDIA devuelve «Inference error» con cualquier imagen enviada.
- **No integrado:** detección de hablante activo (necesita diarización y el Parakeet alojado no la devuelve), Chatterbox (redundante con Magpie), FLUX.1 schnell (no responde), Stable Diffusion 3.5 (sólo descargable y no comercial), Cosmos y Wan (no disponibles con esta clave). Generar video con IA no está disponible.

### Miniaturas (`services/worker/clipmaster_worker/thumbs.py`)

Desde el editor del clip se genera una miniatura con texto grande, en un job `thumbnail` de la cola de render:
- **Fondo de fotograma:** el usuario elige el instante en el clip; se toma del video original (sin subtítulos), se recorta al formato de salida centrando el rostro o el movimiento de ese instante (o el encuadre manual del clip) y se le sube un poco el contraste y la saturación.
- **Fondo con IA:** FLUX de NVIDIA a partir de una descripción (requiere «Funciones de IA de NVIDIA»). Con FLUX.2 klein, unos 4–30 s; con FLUX.1-dev, unos 6 s y resultados más realistas. Como todos los modelos de imagen, puede dibujar mal detalles finos como los puntos de las fichas o letras.
- **Texto:** se compone con libass, con las mismas fuentes que los subtítulos (incluidas las propias). Borde grueso o caja de color, arriba, centro o abajo, en tres tamaños.
- **Tamaños:** 1080×1920 (TikTok, Reels, Shorts), 1280×720 (YouTube) y 1080×1080.
- Cada miniatura nueva reemplaza a la anterior, que queda marcada para limpieza.

### Texto para publicar (`services/worker/clipmaster_worker/social.py`)

Desde el editor del clip, «Generar con IA» crea un job `copy` en la cola de IA. El ai-worker pide al LLM configurado (Ollama o NVIDIA) un título, una descripción y de 4 a 8 hashtags a partir del texto del clip, con las correcciones del usuario.
- Requiere «LLM semántico» activado en *Ajustes*, porque el texto del clip sale hacia el proveedor.
- La respuesta se valida (longitudes, hashtags sin espacios ni duplicados); si no es válida se reintenta una vez y, si vuelve a fallar, se informa del error sin inventar texto.
- Comparte la cola con los análisis (concurrencia 1): si hay un video analizándose, espera su turno.
- Probado con Nemotron de NVIDIA: unos 3 s por clip.

### Encontrar momentos (`apps/api/src/clips/moments.ts`)

Buscador del proyecto sobre la transcripción guardada. No usa IA ni envía nada fuera del servidor.
- Ignora mayúsculas, tildes y puntuación, y acepta variaciones por raíz (`jugada` encuentra `jugando`).
- Con varias palabras descarta las vacías («el», «de»…) y exige al menos el 60 % de los términos; la frase exacta puntúa más.
- Mira cada segmento junto al siguiente, porque una frase puede quedar partida, y usa los tiempos por palabra para dar el instante exacto.
- Desde un resultado se crea un clip (`POST /projects/:id/clips`) con el estilo por defecto del usuario, empezando 3 s antes.
- Limitación: sólo encuentra lo que se dice. Buscar por lo que se ve («gol», «persona riendo») necesitaría un modelo de visión sobre todo el video.

### Modo Dominó

Usa el léxico `domino` en `lexicon.py`: capicúa, tranque, pollona, chuchazo, doble seis, «se trancó», «pasé», etc. También tiene pesos con más emoción y audio, y desactiva el análisis visual.

Para ampliarlo:

- añade términos al léxico;
- o crea un modo nuevo en `modes.json` con su propia clave `lexicon`.

No hay que tocar código de puntuación.

## 3. Render (`render.py`)

1. **Corte.** FFmpeg con *input seeking* sobre la URL prefirmada del almacenamiento S3 (no descarga el original entero). Los directos usan concat de segmentos.
2. **Reencuadre.**
   - **auto:** sigue la trayectoria suavizada de rostros, o el centro de movimiento si no hay rostros. Se simplifica con Douglas-Peucker (24 puntos como máximo) y se aplica como expresión lineal a trozos en `t` dentro del filtro `crop`.
   - **center:** recorte centrado.
   - **manual:** posición X/Y elegida por el usuario.
   - El escalado está limitado por `RENDER_MAX_UPSCALE` (1,5 por defecto). Si el origen es pequeño, la salida mantiene la relación de aspecto pedida con menos resolución que 1080×1920 / 1920×1080 / 1080×1080, en vez de inventar calidad.
3. **Subtítulos ASS.**
   - Plantillas: `tiktok` (palabra activa resaltada), `karaoke` (`\k`), `clean`, `neon` (brillo con `\blur` del color de resaltado), `minimal` (sin borde, sombra suave) y `podcast` (caja opaca, `BorderStyle 3`).
   - Fuentes incluidas en la imagen: Montserrat (predeterminada), DejaVu Sans, Roboto, Open Sans, Lato y Bebas Neue. Las fuentes TTF/OTF que sube el usuario se descargan al directorio de trabajo y se pasan a libass con `fontsdir`; la API lee su nombre de familia de la tabla `name` del archivo.
   - Usan los tiempos por palabra de Whisper. El usuario puede corregir el texto de cada palabra (`Clip.wordOverride`) sin cambiar los tiempos; una palabra vacía se elimina. Las llaves se escapan, así que el texto del usuario no puede inyectar etiquetas ASS.
   - **Título gancho:** estilo `Hook` (caja blanca arriba) durante los primeros 1–10 s con el título del clip o un texto propio. Se activa por defecto en los clips nuevos (`UserSettings.hookTitles`).
   - **Clips combinados:** `segments` lista los tramos en orden. Cada tramo se renderiza por separado (con su propio reencuadre y su parte de los subtítulos; el gancho sólo en el primero) y se unen con el demuxer concat sin recodificar. Las palabras se pasan a la línea de tiempo del clip resultante.
4. **Codificación.**
   - libx264 (CRF 20, `veryfast`) + AAC, con `+faststart`.
   - `h264_nvenc` solo si `RENDER_ENCODER` lo permite **y** una codificación de prueba funciona; si falla en el render real, se repite con libx264.
5. **Verificación.** ffprobe del resultado: debe tener vídeo y una duración que no se desvíe más de max(1 s, 5 %) de la esperada. Después se genera la miniatura. Si la verificación falla, el job falla; nunca se marca como listo un archivo inválido. Las pruebas e2e comprueban además el códec H.264, la relación de aspecto y el audio.

## 4. Rendimiento orientativo

**Sin medir en el servidor objetivo.** Las referencias públicas de faster-whisper indican que `small` en `int8` sobre CPU moderna va bastante por encima de tiempo real con `beam_size=1`. Mide con tus videos: el tiempo de cada paso queda en `timings` de cada análisis.
