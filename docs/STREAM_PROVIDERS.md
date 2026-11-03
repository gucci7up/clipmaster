# Proveedores de video

**Principio:** se procesa contenido propio o para el que el usuario tiene autorización. Al pegar una URL hay que confirmarlo con una casilla obligatoria, que la API valida (`authorized: true`).

ClipMaster **no** usa cookies, credenciales ni técnicas para evadir DRM, inicios de sesión, muros de pago, geobloqueos o controles anti-bot. Si una plataforma lo exige, la validación falla con un mensaje claro y se sugiere subir el archivo.

Código: `services/worker/clipmaster_worker/providers/`.

## Estado real

| Proveedor | VOD / grabado | Directo | Mecanismo | Estado |
|-----------|---------------|---------|-----------|--------|
| **Subida MP4/MOV/WEBM/MKV** | ✅ | — | Multer → almacenamiento S3 → ffprobe → normalización | **Verificado** con prueba e2e (video generado → clips MP4 validados con ffprobe) |
| **URL directa .mp4/.webm/.mov** | ✅ | — | `httpx` con guardia SSRF en cada redirección | Probado con pruebas unitarias (guardia, detección); descarga real sin probar en CI |
| **HLS `.m3u8`** | ✅ | ✅ | FFmpeg; se rechazan listas con `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` de tipo `SAMPLE-AES` o con `KEYFORMAT` distinto de `identity` (DRM) | Implementado; sin prueba contra un stream público en CI |
| **YouTube** | ⚠️ | ⚠️ | yt-dlp (`allowed_extractors` de YouTube) / Streamlink | *Best-effort*. YouTube bloquea a menudo IPs de servidores («confirm you're not a bot»). Si pasa, se informa y se pide subir el archivo. No se usan cookies |
| **Twitch** | ⚠️ | ⚠️ | yt-dlp VOD / Streamlink directos | *Best-effort*. VODs de suscriptores no soportados |
| **Kick** | ⚠️ | ⚠️ | yt-dlp / Streamlink | *Best-effort*. Kick usa Cloudflare y puede bloquear |
| **TikTok** | ⚠️ | ❌ | yt-dlp (solo videos publicados) | **Directos de TikTok no soportados.** La UI lo indica (`supportsLive=false`) |

✅ implementado · ⚠️ depende de la plataforma, puede dejar de funcionar sin cambios en ClipMaster · ❌ no soportado.

Los adaptadores de plataforma dependen de que yt-dlp y Streamlink sigan al día con los cambios de cada sitio. Actualiza las versiones fijadas en `services/worker/requirements.txt` cuando una plataforma cambie.

## Validación previa (`POST /api/projects/validate-url`)

1. **Detección por host** (`packages/shared/src/providers.ts`), compartida por la UI y la API.
2. La API llama al endpoint interno `/validate` del capture-worker, que:
   - aplica la guardia anti-SSRF (ver `SECURITY.md`);
   - consulta metadatos sin descargar: título, duración, si está en directo, disponibilidad;
   - devuelve un motivo comprensible si falla: privado, DRM, no está en vivo, bloqueado, no disponible.

La UI solo permite enviar si la validación es correcta.

## Importación (VOD)

1. Descarga al directorio de trabajo con un límite de tamaño (`MAX_DOWNLOAD_MB`) y una duración máxima.
2. ffprobe.
3. Normalización a MP4 H.264/AAC con `+faststart`:
   - *remux* si los códecs ya son compatibles;
   - transcodificación en otro caso, con altura máxima `IMPORT_MAX_HEIGHT`.
4. Subida a `originals/`.

## Directos

1. **Captura.** Streamlink (o FFmpeg en HLS) envía la señal a FFmpeg con el muxer `segment` (`-f segment -segment_time LIVE_SEGMENT_SECONDS`), y FFmpeg escribe la lista CSV de segmentos cerrados.
2. **Por cada segmento cerrado:**
   - se sube a `segments/`;
   - se notifica a `/api/internal/captures/:id/segments`;
   - la API crea el `VideoSegment` y encola un análisis con el segmento anterior como contexto (`LIVE_CONTEXT_SECONDS`) y el foco en el nuevo, para no cortar momentos que cruzan el límite.
3. **Reconexión.** Si el stream cae, se reintenta con backoff exponencial hasta `LIVE_MAX_RECONNECTS` veces. Si el job se reinicia, `onStart` devuelve el índice y el offset desde los que continuar.
4. **Fin.** La captura termina por:
   - *Detener captura* en la UI (clave Redis `clipmaster:stop:<id>`);
   - fin de la transmisión;
   - `MAX_LIVE_DURATION_SEC`;
   - error.

   Los segmentos pendientes se analizan y el proyecto se completa cuando no quedan trabajos.

## Añadir un proveedor

1. Implementa el protocolo `Provider` (`validate`, `download`, opcionalmente `open_live`) en `providers/`.
2. Regístralo en `REGISTRY` y añade su detección y metadatos en `packages/shared/src/providers.ts`.
3. Añade pruebas en `tests/test_units.py`.
4. Documéntalo aquí con su estado **real**.
