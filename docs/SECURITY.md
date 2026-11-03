# Seguridad

## Exposición de red

- **Ningún contenedor publica puertos.** Traefik (de Dokploy) es la única entrada: `/` va a `web:3000` y `/api` va a `api:4000`.
- Solo `web` y `api` están en `dokploy-network`. PostgreSQL, Redis, MinIO, los workers y Ollama viven en la red privada `backend`.
- **MinIO es privado:**
  - el bucket tiene una política que deniega el acceso anónimo y la consola está desactivada (`MINIO_BROWSER=off`);
  - los medios se sirven a través de la API con **URLs firmadas HMAC** (`/api/media/:kind/:id?exp&sig`) que caducan (`MEDIA_URL_TTL_SEC`) y admiten `Range`;
  - el original solo se firma para su propietario.
- **Endpoints internos** (`/api/internal/*`, que usan los workers):
  - exigen `Authorization: Bearer INTERNAL_API_TOKEN`, comparado en tiempo constante;
  - **rechazan cualquier petición con `X-Forwarded-For`, `X-Forwarded-Host` o `X-Real-IP`**, que son las cabeceras que añade Traefik. Por eso no se pueden usar desde Internet aunque alguien conozca el token.

## Autenticación y autorización

- Contraseñas con **argon2id** (parámetros OWASP). Se usa un hash ficticio para que el tiempo de respuesta no revele si una cuenta existe.
- Sesiones opacas aleatorias en la cookie `cm_session`:
  - cookie `httpOnly`, `SameSite=Lax` y `Secure` en producción;
  - en la base de datos solo se guarda su SHA-256;
  - cambiar la contraseña o desactivar el usuario revoca todas las sesiones.
- Roles `USER` y `ADMIN`. Todo recurso se consulta filtrando por `userId`. Las claves de almacenamiento incluyen `userId/projectId` y se comprueban con `keyBelongsTo`.
- El registro público está desactivado por defecto en compose (`ALLOW_REGISTRATION=false`). El administrador inicial se crea desde `ADMIN_EMAIL` y `ADMIN_PASSWORD`.
- La recuperación de contraseña solo existe si hay `SMTP_URL`. Los tokens son de un solo uso, caducan y se guardan como hash.

## Entradas

- `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted`, más DTOs con class-validator.
- **Subidas:**
  - límite `MAX_UPLOAD_MB`;
  - lista blanca de extensiones;
  - comprobación de **firma de archivo** (`ftyp` / EBML), además de ffprobe en el worker;
  - nombres aleatorios generados por el servidor.
- **Claves de almacenamiento:** siempre las genera el servidor (`prefijo/userId/projectId/uuid.ext`). El almacenamiento local del worker rechaza `..`, rutas absolutas y escapes del directorio raíz.
- **Estilos de subtítulos** saneados: rangos numéricos, colores `#RRGGBB` y presets en lista blanca. En el ASS se escapan `{` y `}`.
- **Sin shell:** todos los procesos (FFmpeg, ffprobe, Streamlink) se lanzan con listas de argumentos (`subprocess` sin `shell=True`). Los parámetros del usuario nunca se concatenan en un comando.

## SSRF (`url_guard.py`)

Se aplica en la validación, antes de descargar y **en cada redirección**:

- solo `http` y `https`, sin credenciales en la URL, y 2048 caracteres como máximo;
- puertos permitidos: 80, 443, 8080 y 8443;
- hosts bloqueados: `localhost`, `metadata`, `metadata.google.internal`, `instance-data`, los sufijos `.local`, `.internal`, `.localhost` y `.lan`, y los nombres de una sola etiqueta (por ejemplo `minio` o `redis`);
- se resuelven **todas** las IPs del host y se rechazan las privadas, de loopback, link-local (incluida 169.254.169.254), CGNAT, multicast, reservadas, sin especificar y las IPv6 equivalentes, como las mapeadas `::ffff:`;
- yt-dlp se ejecuta con `allowed_extractors` limitado a la plataforma detectada, así que el extractor genérico no puede convertirlo en un cliente HTTP arbitrario.

`ALLOW_PRIVATE_NETWORKS=false` en compose. Actívalo solo en un laboratorio aislado.

**Limitación conocida:** entre la resolución DNS y la conexión hay una ventana de *DNS rebinding*. Se mitiga revalidando en cada redirección y descargando con un cliente que no sigue redirecciones automáticamente. No es una garantía absoluta.

## Abuso y recursos

- Límite de peticiones global (`RATE_LIMIT_PER_MINUTE`) y límites más estrictos en login, registro y recuperación.
- Cuota de almacenamiento por usuario, proyectos activos simultáneos (`MAX_ACTIVE_PROJECTS_PER_USER`) y duraciones máximas de video y directo.
- Limpieza periódica (cada 15 minutos):
  - temporales caducados;
  - proyectos borrados después de 24 horas;
  - sesiones expiradas;
  - recálculo del uso de almacenamiento.

## Servicios externos (opcionales)

- **LLM de NVIDIA** (`LLM_PROVIDER=nvidia` + `NVIDIA_API_KEY`):
  - es el único punto en que datos del usuario salen del servidor, y solo como fragmentos de transcripción de los candidatos;
  - hacen falta dos cosas: que el administrador ponga la clave y que el usuario active «LLM semántico»;
  - *Ajustes* muestra al usuario si el proveedor es NVIDIA antes de que lo active;
  - la clave solo vive en el entorno del ai-worker, y nunca llega a la API, al navegador ni a los logs.
- **Descargas de modelos de Whisper** (Hugging Face): solo la primera vez.
- **Plataformas de video:** solo cuando el usuario importa una URL.

## Secretos y logs

- Todos los secretos llegan por variables de entorno. `.env*` está en `.gitignore` y `.dockerignore`.
- La API se niega a arrancar si `SESSION_SECRET`, `MEDIA_SIGNING_SECRET` o `INTERNAL_API_TOKEN` tienen menos de 32 caracteres.
- Logs JSON (pino y el formateador del worker) con redacción de `authorization`, `cookie` y contraseñas.
- `AuditLog` registra inicios de sesión, cambios de contraseña, borrados, regeneraciones y acciones de administración.

## Operaciones destructivas

Nada en el código ni en los scripts borra bases de datos o volúmenes existentes. Las migraciones se aplican con `prisma migrate deploy`, que solo aplica migraciones nuevas y nunca hace reset.
