# Capturador remoto (enlaces de YouTube)

YouTube bloquea las descargas que vienen de IPs de centros de datos («Sign in to confirm you're not a bot»).
No se evade ese control: los enlaces de YouTube los descarga un **capturador** que se ejecuta en tu PC, con tu
conexión normal, y entrega el video a tu servidor. Después el análisis y el render siguen en el servidor como
siempre.

- Sólo hace conexiones **salientes HTTPS** a tu dominio. No abre puertos, no necesita VPN ni Tailscale.
- No usa cookies ni tu cuenta de Google.
- Procesa únicamente contenido propio o para el que tengas autorización.

## Puesta en marcha (Windows)

Requisitos en el PC: Python 3.11+, FFmpeg y Node.js 22+ (o Deno) en el `PATH`.

```bash
winget install Gyan.FFmpeg
```

```bash
winget install OpenJS.NodeJS.LTS
```

1. En ClipMaster, entra en **Administración → Capturadores**, escribe un nombre (p. ej. «PC de casa») y pulsa
   **Crear token**. Copia el token (`cma_…`): sólo se muestra una vez.
2. En tu PC, desde la carpeta del repositorio:

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\iniciar-capturador.ps1
   ```

   La primera vez pide la dirección (`https://tu-dominio`) y el token, crea un entorno de Python en
   `services/worker/.venv-capturador` con las dependencias mínimas (`requirements-agent.txt`) y guarda la
   configuración cifrada con DPAPI en `%APPDATA%\ClipMaster\capturador.json`.
3. Deja la ventana abierta. En **Administración** el capturador aparece como **Conectado**.

Opciones del script:

- `-Reconfigurar`: cambia la dirección o el token.
- `-InicioAutomatico`: crea un acceso directo en la carpeta de Inicio de Windows.

Sin el script (cualquier sistema):

```bash
CLIPMASTER_SERVER=https://tu-dominio CLIPMASTER_AGENT_TOKEN=cma_... python -m clipmaster_worker.agent
```

## Cómo funciona

1. Al crear un proyecto con un enlace de YouTube, la validación se aplaza al capturador y el trabajo queda
   «Esperando al capturador de tu PC». Si no hay ningún capturador conectado, el proyecto espera sin caducar.
2. El capturador pregunta cada 5 s si hay trabajo (`POST /api/capture-agent/claim`). Un trabajo sólo lo toma un
   capturador.
3. Valida el enlace, lo descarga con yt-dlp, lo normaliza con FFmpeg (como el servidor) y sube el MP4 en partes de
   8 MiB. El progreso se ve en el proyecto en tiempo real.
4. Al terminar, el servidor continúa con la transcripción, el análisis y el render.

Si el PC se apaga a mitad, el trabajo vuelve a la cola a los ~2 minutos y se reanuda cuando el capturador vuelva
(hasta `JOB_ATTEMPTS` intentos). Errores del contenido (privado, no disponible, demasiado largo) no se reintentan.
Cancelar el proyecto detiene la descarga en el PC.

## Configuración del servidor

`AGENT_PROVIDERS` (por defecto `YOUTUBE`) indica qué proveedores van al capturador. Con `AGENT_PROVIDERS=` todos
los enlaces vuelven a descargarse en el capture-worker del servidor.

Para revocar un PC, pulsa **Revocar** en Administración; deja de poder conectarse de inmediato.
