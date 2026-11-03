<#
.SYNOPSIS
  Inicia el capturador de ClipMaster en este PC: descarga los enlaces de YouTube con tu conexión
  y entrega el video a tu servidor. Sólo hace conexiones salientes HTTPS; no abre puertos.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\iniciar-capturador.ps1
  powershell -ExecutionPolicy Bypass -File scripts\iniciar-capturador.ps1 -Reconfigurar
  powershell -ExecutionPolicy Bypass -File scripts\iniciar-capturador.ps1 -InicioAutomatico
#>
param(
  [switch]$Reconfigurar,
  [switch]$InicioAutomatico
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $repo 'services\worker'
$configDir = Join-Path $env:APPDATA 'ClipMaster'
$configFile = Join-Path $configDir 'capturador.json'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- requisitos
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { Fail 'No se encontró Python 3.11+. Instálalo desde https://www.python.org/downloads/ (marca "Add to PATH").' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Fail 'No se encontró FFmpeg en el PATH. Instálalo con: winget install Gyan.FFmpeg' }
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Get-Command deno -ErrorAction SilentlyContinue)) {
  Fail 'YouTube necesita Node.js 22+ o Deno. Instálalo con: winget install OpenJS.NodeJS.LTS'
}

# ---------------------------------------------------------------- configuración (por usuario, fuera del repositorio)
if ($Reconfigurar -or -not (Test-Path $configFile)) {
  Write-Host 'Configuración del capturador (sólo la primera vez).' -ForegroundColor Cyan
  $server = (Read-Host 'Dirección de tu ClipMaster (ej. https://clips.midominio.com)').Trim().TrimEnd('/')
  if (-not $server.StartsWith('https://')) { Fail 'La dirección debe empezar por https://' }
  $secure = Read-Host 'Token del capturador (Administración > Capturadores)' -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
  if (-not $token.StartsWith('cma_')) { Fail 'El token debe empezar por cma_' }
  New-Item -ItemType Directory -Force $configDir | Out-Null
  # El token se guarda cifrado con DPAPI: sólo tu usuario de Windows en este PC puede leerlo.
  $enc = ConvertFrom-SecureString (ConvertTo-SecureString $token -AsPlainText -Force)
  @{ server = $server; token = $enc } | ConvertTo-Json | Set-Content -Encoding utf8 $configFile
  Write-Host "Guardado en $configFile" -ForegroundColor Green
}
$cfg = Get-Content -Raw $configFile | ConvertFrom-Json
$tokenPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $cfg.token)))

# ---------------------------------------------------------------- entorno de Python
$venv = Join-Path $worker '.venv-capturador'
$venvPy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  Write-Host 'Creando entorno de Python (sólo la primera vez)…' -ForegroundColor Cyan
  & $python.Source -m venv $venv
  if ($LASTEXITCODE -ne 0) { Fail 'No se pudo crear el entorno de Python' }
}
$req = Join-Path $worker 'requirements-agent.txt'
$stamp = Join-Path $venv '.requirements.sha256'
$hash = (Get-FileHash $req -Algorithm SHA256).Hash
if (-not (Test-Path $stamp) -or (Get-Content $stamp) -ne $hash) {
  Write-Host 'Instalando dependencias…' -ForegroundColor Cyan
  & $venvPy -m pip install --disable-pip-version-check -q -r $req
  if ($LASTEXITCODE -ne 0) { Fail 'No se pudieron instalar las dependencias' }
  Set-Content $stamp $hash
}

# ---------------------------------------------------------------- inicio automático (opcional)
if ($InicioAutomatico) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startup 'ClipMaster capturador.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = 'powershell.exe'
  $sc.Arguments = "-ExecutionPolicy Bypass -WindowStyle Minimized -File `"$PSCommandPath`""
  $sc.WorkingDirectory = $repo
  $sc.Save()
  Write-Host "El capturador se iniciará al entrar en Windows ($lnk)." -ForegroundColor Green
}

# ---------------------------------------------------------------- ejecución
Write-Host "Capturador conectado a $($cfg.server). Deja esta ventana abierta; Ctrl+C para detenerlo." -ForegroundColor Green
$env:CLIPMASTER_SERVER = $cfg.server
$env:CLIPMASTER_AGENT_TOKEN = $tokenPlain
$env:PYTHONPATH = $worker
$env:PYTHONUTF8 = '1'
# Archivos temporales junto al repositorio (no en C:\, que suele ir justo de espacio).
if (-not $env:CLIPMASTER_WORK_DIR) { $env:CLIPMASTER_WORK_DIR = Join-Path $worker '.capturador-trabajo' }
while ($true) {
  & $venvPy -m clipmaster_worker.agent
  $code = $LASTEXITCODE
  if ($code -eq 0 -or $code -eq 2) { break }
  if ($code -eq 1) {
    Write-Host 'El servidor rechazó el token o no responde. Reintentando en 60 s (usa -Reconfigurar para cambiar el token).' -ForegroundColor Yellow
  }
  Start-Sleep -Seconds 60
}
