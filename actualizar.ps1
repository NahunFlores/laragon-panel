# Actualiza Laragon Panel desde la última release pública.
# Conserva panel.config.json y data.
#
# Modos:
#   actualizar.bat                 Modo seguro: conserva resources\panel y deja .new
#   actualizar.bat -Full           Reemplaza también resources\panel (con backup)
#   actualizar.bat -KeepPanel      Igual que el modo seguro (compatibilidad)
#   actualizar.bat -BackupOnly     Solo crea un backup, no actualiza
#   actualizar.bat -Yes            No pide confirmación

param(
  [switch]$BackupOnly,
  [switch]$KeepPanel,
  [switch]$Full,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$repo = 'NahunFlores/laragon-panel'
$appDir = $PSScriptRoot
$exe = Join-Path $appDir 'LaragonPanel.exe'
$name = Split-Path $appDir -Leaf

if (-not (Test-Path $exe)) {
  throw "No se encontró LaragonPanel.exe en $appDir"
}

function New-AppBackup {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path (Split-Path $appDir -Parent) "$name.bak-$stamp"
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  Copy-Item $exe $backup -Force
  $res = Join-Path $appDir 'resources'
  if (Test-Path $res) {
    Copy-Item $res (Join-Path $backup 'resources') -Recurse -Force
  }
  foreach ($file in @('panel.config.json', 'actualizar.ps1', 'actualizar.bat', 'VERSION', 'LEEME.txt', 'README.md', 'INSTALACION_LARAGON_PANEL.xlsx')) {
    $src = Join-Path $appDir $file
    if (Test-Path $src) { Copy-Item $src (Join-Path $backup $file) -Force }
  }
  Write-Host "Backup creado: $backup"
  return $backup
}

function Restore-AppBackup($backup) {
  if (-not $backup -or -not (Test-Path $backup)) { return }
  Write-Host 'Restaurando la versión anterior desde el backup...'
  $oldExe = Join-Path $backup 'LaragonPanel.exe'
  if (Test-Path $oldExe) { Copy-Item $oldExe $appDir -Force }
  $oldResources = Join-Path $backup 'resources'
  if (Test-Path $oldResources) {
    $currentResources = Join-Path $appDir 'resources'
    if (Test-Path $currentResources) { Remove-Item $currentResources -Recurse -Force }
    Copy-Item $oldResources $currentResources -Recurse -Force
  }
  foreach ($file in @('panel.config.json', 'actualizar.ps1', 'actualizar.bat', 'VERSION', 'LEEME.txt', 'README.md', 'INSTALACION_LARAGON_PANEL.xlsx')) {
    $oldFile = Join-Path $backup $file
    if (Test-Path $oldFile) { Copy-Item $oldFile (Join-Path $appDir $file) -Force }
  }
}

if ($BackupOnly) {
  New-AppBackup | Out-Null
  exit 0
}

Write-Host 'Buscando la última versión...'
$headers = @{ 'User-Agent' = 'LaragonPanel-Updater' }
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
$asset = $release.assets | Where-Object { $_.name -eq 'LaragonPanel-portable.zip' } | Select-Object -First 1
if (-not $asset) {
  throw "La release $($release.tag_name) no tiene LaragonPanel-portable.zip"
}

$mode = if ($Full) { 'completa (reemplaza resources\panel)' } else { 'segura (conserva resources\panel y deja .new)' }
Write-Host "Versión disponible: $($release.tag_name)"
Write-Host "Modo: $mode"
if (-not $Yes) {
  $answer = Read-Host "Se creará un backup. Modo: $mode. ¿Continuar? (s/N)"
  if ($answer -notmatch '^[sSyY]') {
    Write-Host 'Actualización cancelada.'
    exit 0
  }
}

$tmp = Join-Path $env:TEMP ('LaragonPanelUpdate_' + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $tmp 'update.zip'
$newDir = Join-Path $tmp 'new'
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$backup = $null
$updateStarted = $false

try {
  Write-Host "Descargando $($release.tag_name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $newDir -Force

  if (-not (Test-Path (Join-Path $newDir 'LaragonPanel.exe'))) {
    throw 'El ZIP no contiene LaragonPanel.exe'
  }

  $backup = New-AppBackup

  # Conservar la configuración local.
  $oldConfig = Join-Path $appDir 'panel.config.json'
  if (Test-Path $oldConfig) {
    Copy-Item $oldConfig (Join-Path $newDir 'panel.config.json') -Force
  }

  Write-Host 'Cerrando Laragon Panel...'
  Get-Process LaragonPanel -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$appDir*" } |
    Stop-Process -Force
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$appDir*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  Write-Host 'Reemplazando archivos...'
  $updateStarted = $true
  Copy-Item (Join-Path $newDir 'LaragonPanel.exe') $appDir -Force

  if ($Full) {
    $oldResources = Join-Path $appDir 'resources'
    if (Test-Path $oldResources) { Remove-Item $oldResources -Recurse -Force }
    Copy-Item (Join-Path $newDir 'resources') $appDir -Recurse -Force
    Write-Host 'resources\panel reemplazado completamente.'
  } else {
    $oldApp = Join-Path $appDir 'resources\app'
    $oldNode = Join-Path $appDir 'resources\node'
    if (Test-Path $oldApp) { Remove-Item $oldApp -Recurse -Force }
    Copy-Item (Join-Path $newDir 'resources\app') $oldApp -Recurse -Force
    if (Test-Path (Join-Path $newDir 'resources\node')) {
      if (Test-Path $oldNode) { Remove-Item $oldNode -Recurse -Force }
      Copy-Item (Join-Path $newDir 'resources\node') $oldNode -Recurse -Force
    }

    $oldPanel = Join-Path $appDir 'resources\panel'
    $newPanel = Join-Path $newDir 'resources\panel'
    if (-not (Test-Path $oldPanel)) {
      Copy-Item $newPanel $oldPanel -Recurse -Force
      Write-Host 'resources\panel creado desde la release.'
    } else {
      $added = 0
      $conflicts = @()
      Get-ChildItem $newPanel -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($newPanel.Length).TrimStart('\')
        $dst = Join-Path $oldPanel $rel
        $parent = Split-Path $dst -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (-not (Test-Path $dst)) {
          Copy-Item $_.FullName $dst -Force
          $added++
        } else {
          $h1 = (Get-FileHash $dst -Algorithm SHA256).Hash
          $h2 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
          if ($h1 -ne $h2) {
            Copy-Item $_.FullName "$dst.new" -Force
            $conflicts += $rel
          }
        }
      }
      Write-Host "resources\panel conservado. Archivos nuevos: $added."
      if ($conflicts.Count -gt 0) {
        Write-Host "Cambios nuevos para fusionar ($($conflicts.Count)):"
        $conflicts | ForEach-Object { Write-Host "  .new: $_" }
      } else {
        Write-Host 'No hay cambios pendientes en resources\panel.'
      }
    }
  }

  foreach ($file in @('LEEME.txt', 'README.md', 'INSTALACION_LARAGON_PANEL.xlsx', 'actualizar.ps1', 'actualizar.bat', 'VERSION')) {
    $src = Join-Path $newDir $file
    if (Test-Path $src) { Copy-Item $src (Join-Path $appDir $file) -Force }
  }

  Start-Process -FilePath $exe -ArgumentList '--hidden' -WorkingDirectory $appDir
  Write-Host "Actualizado a $($release.tag_name)."
  Write-Host "Backup: $backup"
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  Write-Host "Backup (si se creó): $backup"
  if ($updateStarted -and $backup) {
    try { Restore-AppBackup $backup }
    catch { Write-Host "WARN: automatic restore failed: $($_.Exception.Message)" }
  }
  if (Test-Path $exe) {
    try { Start-Process -FilePath $exe -ArgumentList '--hidden' -WorkingDirectory $appDir } catch {}
  }
  throw
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
