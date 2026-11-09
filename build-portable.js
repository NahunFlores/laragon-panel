'use strict';

/*
 * Crea una carpeta portable con LaragonPanel.exe.
 *
 * Resultado:
 *   dist/LaragonPanel/
 *     LaragonPanel.exe
 *     panel.config.json
 *     data/                  (se crea al primer arranque)
 *     resources/
 *       app/                 main.js, preload.js, iconos
 *       panel/               server.js, public, backup, winservices
 *       node/node.exe        Node incluido (no requiere instalación)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ELECTRON = path.join(ROOT, 'electron-app', 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'dist', 'LaragonPanel');
const DIST = path.dirname(OUT);
const BUILD = path.join(DIST, `.LaragonPanel-build-${process.pid}-${Date.now()}`);
const ZIP = path.join(DIST, 'LaragonPanel-portable.zip');
const ZIP_BUILD = path.join(DIST, `.LaragonPanel-portable-${process.pid}-${Date.now()}.zip`);
const APP = path.join(BUILD, 'resources', 'app');
const PANEL = path.join(BUILD, 'resources', 'panel');
const NODE_DIR = path.join(BUILD, 'resources', 'node');

function fail(msg) {
  try { fs.rmSync(BUILD, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ZIP_BUILD, { force: true }); } catch {}
  console.error('ERROR:', msg);
  process.exit(1);
}

if (!fs.existsSync(path.join(ELECTRON, 'electron.exe'))) {
  fail('No se encontró Electron. Ejecuta primero: cd electron-app && npm install');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertNotRunning() {
  if (process.platform !== 'win32' || !fs.existsSync(OUT)) return;
  const { execFileSync } = require('child_process');
  const target = path.join(OUT, 'LaragonPanel.exe');
  const script = `$target=${psQuote(target)}; Get-CimInstance Win32_Process -Filter "Name='LaragonPanel.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath($target)) } | Select-Object -First 1 -ExpandProperty ProcessId`;
  let pid = '';
  try { pid = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim(); }
  catch (error) { fail(`No pude comprobar si el portable está ejecutándose; por seguridad no lo reemplazo. ${error.message}`); }
  if (pid) fail(`LaragonPanel.exe sigue ejecutándose (PID ${pid}). Ciérralo y vuelve a compilar; no se tocó la instalación.`);
}

fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });
assertNotRunning();

console.log('Copiando Electron...');
fs.cpSync(ELECTRON, BUILD, { recursive: true });
fs.renameSync(path.join(BUILD, 'electron.exe'), path.join(BUILD, 'LaragonPanel.exe'));

console.log('Copiando app...');
fs.mkdirSync(APP, { recursive: true });
for (const file of ['main.js', 'preload.js', 'icon.png', 'icon.ico', 'package.json']) {
  fs.copyFileSync(path.join(ROOT, 'electron-app', file), path.join(APP, file));
}

console.log('Copiando panel...');
fs.mkdirSync(PANEL, { recursive: true });
for (const file of ['server.js', 'config.js', 'laragon-stack.js', 'stack-policy.json', 'backup.js', 'backup-runner.js', 'winservices.js']) {
  fs.copyFileSync(path.join(ROOT, file), path.join(PANEL, file));
}
fs.cpSync(path.join(ROOT, 'public'), path.join(PANEL, 'public'), { recursive: true });

console.log('Copiando Node...');
fs.mkdirSync(NODE_DIR, { recursive: true });
if (!/node\.exe$/i.test(process.execPath)) fail('Compila con node.exe, no con Electron.');
fs.copyFileSync(process.execPath, path.join(NODE_DIR, 'node.exe'));

console.log('Creando configuración y datos...');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel.config.example.json'), 'utf8'));
// Los puertos y las versiones se heredan de Laragon salvo que el usuario los fije explícitamente.
delete config.mysqlPort;
fs.writeFileSync(path.join(BUILD, 'panel.config.json'), JSON.stringify(config, null, 2), 'utf8');
fs.mkdirSync(path.join(BUILD, 'data'), { recursive: true });

for (const file of ['LEEME.txt', 'README.md', 'INSTALACION_LARAGON_PANEL.xlsx', 'actualizar.ps1', 'actualizar.bat', 'VERSION']) {
  if (fs.existsSync(path.join(ROOT, file))) {
    fs.copyFileSync(path.join(ROOT, file), path.join(BUILD, file));
  }
}

const seven = 'C:/Program Files/7-Zip/7z.exe';
let zipBuilt = false;
if (fs.existsSync(seven)) {
  const { execFileSync } = require('child_process');
  execFileSync(seven, ['a', '-tzip', '-mx=7', ZIP_BUILD, path.join(BUILD, '*'), '-xr!data'], { stdio: 'ignore' });
  zipBuilt = true;
} else {
  console.log('7-Zip no encontrado; comprime manualmente la carpeta si lo necesitas.');
}

// Heredar datos locales/configuración primero; nunca compilar directamente sobre una instalación.
if (fs.existsSync(OUT)) {
  for (const name of ['data', 'panel.config.json']) {
    const source = path.join(OUT, name);
    const destination = path.join(BUILD, name);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
  }
}

const previous = path.join(DIST, `.LaragonPanel-previous-${process.pid}-${Date.now()}`);
let movedOld = false;
try {
  if (fs.existsSync(OUT)) {
    fs.renameSync(OUT, previous);
    movedOld = true;
  }
  fs.renameSync(BUILD, OUT);
} catch (error) {
  if (movedOld && !fs.existsSync(OUT)) {
    try { fs.renameSync(previous, OUT); } catch {}
  }
  fail(`No se pudo publicar el build. La instalación anterior se conserva. ${error.message}`);
}
if (movedOld) {
  try { fs.rmSync(previous, { recursive: true, force: true }); }
  catch (error) { console.warn(`El build quedó publicado; conserva el respaldo temporal ${previous}: ${error.message}`); }
}

if (zipBuilt) {
  const zipPrevious = `${ZIP}.previous-${process.pid}`;
  let movedZip = false;
  try {
    if (fs.existsSync(ZIP)) { fs.renameSync(ZIP, zipPrevious); movedZip = true; }
    fs.renameSync(ZIP_BUILD, ZIP);
    if (movedZip) fs.rmSync(zipPrevious, { force: true });
    console.log('ZIP:', ZIP);
  } catch (error) {
    if (movedZip && !fs.existsSync(ZIP)) {
      try { fs.renameSync(zipPrevious, ZIP); } catch {}
    }
    console.warn(`El portable quedó publicado, pero el ZIP no se reemplazó: ${error.message}`);
  }
}

console.log('Portable creado en:', OUT);
console.log('Configuración y data locales heredadas si ya existían.');
console.log('Ejecutable:', path.join(OUT, 'LaragonPanel.exe'));
console.log('Tamaño:', (fs.statSync(path.join(OUT, 'LaragonPanel.exe')).size / 1024 / 1024).toFixed(1), 'MB (exe)');
