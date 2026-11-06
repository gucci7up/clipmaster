# Plan de implementación y estado

Última actualización: 2026-11-03.

Leyenda:

- ✅ hecho y probado;
- 🟡 implementado, pero sin verificar en el entorno real;
- ⬜ pendiente.

## Etapa 1: Fundaciones

| Elemento | Estado | Notas |
|----------|--------|-------|
| Monorepo pnpm (web, api, shared, worker) | ✅ | `packages/shared` es la fuente única de contratos, modos y proveedores |
| Esquema Prisma (19 entidades) + migración inicial | ✅ | aplicada sobre PostgreSQL 17 real |
| Auth (argon2id, sesiones, roles, recuperación por SMTP) | ✅ | unitarias; flujo HTTP sin probar en contenedor |
| Colas BullMQ + protocolo de workers | 🟡 | orquestación probada con PostgreSQL; Redis real sin probar (ver `TESTING.md`) |
| Almacenamiento S3 privado (RustFS) + URLs firmadas | 🟡 | firma y claves con unitarias; RustFS sin probar en ejecución |
| SSE de progreso | 🟡 | eventos persistidos probados; transporte SSE sin probar en navegador |
| UI en español (oscuro/claro, responsive) | 🟡 | compila y pasa typecheck; sin prueba en navegador contra la API |
| Docker Compose para Dokploy + overlay GPU | 🟡 | sintaxis validada; sin construir |
| Swagger (`/api/docs`) | 🟡 | |

## Etapa 2: Pipeline real con archivos (prioridad)

| Elemento | Estado |
|----------|--------|
| Subida → importación/normalización → ffprobe | ✅ e2e |
| Transcripción faster-whisper (CPU; CUDA con retorno a CPU) | ✅ CPU / 🟡 CUDA |
| Señales de audio, visuales y léxicas | ✅ e2e |
| Puntuación, límites por contexto, deduplicación, selección | ✅ e2e + integración |
| Render 9:16 / 16:9 / 1:1, reencuadre, subtítulos ASS, verificación | ✅ e2e |
| NVENC con prueba y retorno a libx264 | 🟡 (sin GPU en las pruebas) |
| Editor: rango, formato, encuadre, subtítulos, regenerar | 🟡 API probada en integración; UI sin prueba en navegador |

## Etapa 3: Importación por URL

| Elemento | Estado |
|----------|--------|
| Detección de plataforma + validación previa | ✅ unitarias |
| Guardia SSRF (todas las IPs, redirecciones, puertos) | ✅ unitarias |
| URL directa / HLS (rechazo de DRM) | 🟡 |
| YouTube, Twitch, Kick, TikTok vía yt-dlp (sin cookies) | 🟡 *best-effort* (ver `STREAM_PROVIDERS.md`) |
| Capturador remoto para YouTube (PC del usuario, HTTPS saliente, cola en PostgreSQL con lease) | 🟡 protocolo probado (API + PostgreSQL real, agente con servidor simulado); descarga real desde un PC pendiente de verificar |

## Editor (mejoras inspiradas en otros clipeadores; código propio)

| Elemento | Estado |
|----------|--------|
| Corrección de palabras del subtítulo sin cambiar tiempos | ✅ integración (PostgreSQL real) |
| Título gancho en los primeros segundos | ✅ unitarias + e2e de render |
| Estilos guardados y aplicar estilo a todo el proyecto | ✅ integración |
| Plantillas neon / minimal / podcast y fuentes propias TTF/OTF | ✅ unitarias + e2e de render con fuente subida |
| Desglose de la puntuación (componentes reales del análisis) | ✅ |
| Combinar clips en uno nuevo | ✅ integración + e2e de render (dos tramos concatenados) |
| Encontrar momentos: buscar en la transcripción y crear un clip desde el resultado | ✅ unitarias + integración; búsqueda por texto, no por significado ni por imagen |

## Etapa 4: Directos

| Elemento | Estado |
|----------|--------|
| Captura segmentada (Streamlink/FFmpeg) + subida por segmento | 🟡 |
| Análisis incremental con ventana de contexto | 🟡 (la lógica de foco está cubierta en unitarias) |
| Reconexión con backoff, reanudación tras reinicio, detener | 🟡 |
| Directos de TikTok | ⬜ no soportado (indicado en la UI) |

## Etapa 5: Multimodal

| Elemento | Estado |
|----------|--------|
| Fusión audio + visual + texto con pesos por modo | ✅ |
| LLM opcional: Ollama local o API de NVIDIA (JSON validado) | 🟡 ambos proveedores probados con respuestas HTTP simuladas; sin llamada real (no hay clave ni Ollama en desarrollo) |
| Análisis con fotogramas (Nemotron Omni de NVIDIA, opcional) | ✅ probado con la API real |
| Render con IA de NVIDIA: mirada a cámara, iluminación, voz del gancho, portada (opcional) | ✅ probado con la API real en local; pendiente de verificar en producción |
| Señal de chat de directos | ⬜ no implementada; su peso se redistribuye |
| Diarización de hablantes | ⬜ |

## Etapa 6: Producción

| Elemento | Estado |
|----------|--------|
| Límites de peticiones, cuotas, auditoría, limpieza programada | 🟡 |
| Reconciliador de trabajos perdidos | 🟡 |
| Health checks (liveness, readiness, sistema) | 🟡 |
| Métricas Prometheus | ⬜ |
| Pruebas E2E de navegador (Playwright) | ⬜ |

## Bloqueos y riesgos

1. **No había Docker en la máquina de desarrollo.** El primer despliegue es también la primera ejecución de los contenedores.
2. **Plataformas de video:** YouTube, Kick y otras bloquean a menudo IPs de centros de datos. No se implementará ninguna evasión.
3. **GPU Pascal y CTranslate2:** puede requerir `float32` / `int8_float32` o quedarse en CPU.
4. **MinIO** retiró sus imágenes de Docker Hub (`pull access denied` en el primer despliegue). Se sustituyó por **RustFS** (`rustfs/rustfs:1.0.4`), compatible con S3. Se puede cambiar con `STORAGE_IMAGE` o apuntar `S3_ENDPOINT` a cualquier S3 compatible.

## Decisiones registradas

- **Worker Python único con roles** (`WORKER_ROLE`) en lugar de tres bases de código: un solo contrato y una sola imagen.
- **Los workers informan por HTTP interno** en vez de escribir en la base de datos: la API es la única dueña de PostgreSQL.
- **El progreso viene solo de FFmpeg (`-progress`), Whisper (segmentos procesados/duración) y los pasos reales.** Si no es medible, la barra es indeterminada.
- **Prisma 6** en lugar de 7, y **OpenCV 4.x** en lugar de 5 (que eliminó `CascadeClassifier`).
- **PyAV fijado a 18.1** por una incompatibilidad de faster-whisper 1.2.1 con PyAV 19. De todos modos, el audio se pasa a Whisper como array numpy.
- **Mismo dominio para web y API**: sin CORS y con cookies `SameSite=Lax`.
