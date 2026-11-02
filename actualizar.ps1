# Actualiza Laragon Panel desde la última release pública.
# Conserva panel.config.json y la carpeta data.

$ErrorActionPreference = 'Stop'
$repo = 'NahunFlores/laragon-panel'
$appDir = $PSScriptRoot
$exe = Join-Path $appDir 'LaragonPanel.exe'

if (-not (Test-Path $exe)) {
  throw "No se encontró LaragonPanel.exe en $appDir"
}

Write-Host 'Buscando la última versión...'
$headers = @{ 'User-Agent' = 'LaragonPanel-Updater' }
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
$asset = $release.assets | Where-Object { $_.name -eq 'LaragonPanel-portable.zip' } | Select-Object -First 1
if (-not $asset) {
  throw "La release $($release.tag_name) no tiene LaragonPanel-portable.zip"
}

$tmp = Join-Path $env:TEMP ('LaragonPanelUpdate_' + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $tmp 'update.zip'
$newDir = Join-Path $tmp 'new'
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  Write-Host "Descargando $($release.tag_name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $newDir -Force

  if (-not (Test-Path (Join-Path $newDir 'LaragonPanel.exe'))) {
    throw 'El ZIP no contiene LaragonPanel.exe'
  }

  Write-Host 'Cerrando Laragon Panel...'
  Get-Process LaragonPanel -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "$appDir*" } |
    Stop-Process -Force
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$appDir*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  # Conservar la configuración local si existe.
  $oldConfig = Join-Path $appDir 'panel.config.json'
  if (Test-Path $oldConfig) {
    Copy-Item $oldConfig (Join-Path $newDir 'panel.config.json') -Force
  }

  Write-Host 'Reemplazando archivos...'
  Copy-Item (Join-Path $newDir 'LaragonPanel.exe') $appDir -Force
  $oldResources = Join-Path $appDir 'resources'
  if (Test-Path $oldResources) {
    Remove-Item $oldResources -Recurse -Force
  }
  Copy-Item (Join-Path $newDir 'resources') $appDir -Recurse -Force

  foreach ($file in @('LEEME.txt', 'README.md', 'INSTALACION_LARAGON_PANEL.xlsx', 'actualizar.ps1', 'actualizar.bat', 'VERSION')) {
    $src = Join-Path $newDir $file
    if (Test-Path $src) {
      Copy-Item $src (Join-Path $appDir $file) -Force
    }
  }

  Start-Process -FilePath $exe -ArgumentList '--hidden' -WorkingDirectory $appDir
  Write-Host "Actualizado a $($release.tag_name). Laragon Panel se está iniciando."
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
