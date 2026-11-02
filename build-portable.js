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
const APP = path.join(OUT, 'resources', 'app');
const PANEL = path.join(OUT, 'resources', 'panel');
const NODE_DIR = path.join(OUT, 'resources', 'node');

function fail(msg) {
  console.error('ERROR:', msg);
  process.exit(1);
}

if (!fs.existsSync(path.join(ELECTRON, 'electron.exe'))) {
  fail('No se encontró Electron. Ejecuta primero: cd electron-app && npm install');
}

console.log('Limpiando salida...');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('Copiando Electron...');
fs.cpSync(ELECTRON, OUT, { recursive: true });
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'LaragonPanel.exe'));

console.log('Copiando app...');
fs.mkdirSync(APP, { recursive: true });
for (const file of ['main.js', 'preload.js', 'icon.png', 'icon.ico', 'package.json']) {
  fs.copyFileSync(path.join(ROOT, 'electron-app', file), path.join(APP, file));
}

console.log('Copiando panel...');
fs.mkdirSync(PANEL, { recursive: true });
for (const file of ['server.js', 'config.js', 'backup.js', 'backup-runner.js', 'winservices.js']) {
  fs.copyFileSync(path.join(ROOT, file), path.join(PANEL, file));
}
fs.cpSync(path.join(ROOT, 'public'), path.join(PANEL, 'public'), { recursive: true });

console.log('Copiando Node...');
fs.mkdirSync(NODE_DIR, { recursive: true });
if (!/node\.exe$/i.test(process.execPath)) fail('Compila con node.exe, no con Electron.');
fs.copyFileSync(process.execPath, path.join(NODE_DIR, 'node.exe'));

console.log('Creando configuración y datos...');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel.config.example.json'), 'utf8'));
// Sin mysqlPort: se detecta desde usr\laragon.ini (3308 aquí, 3306 en Laragon estándar).
delete config.mysqlPort;
fs.writeFileSync(path.join(OUT, 'panel.config.json'), JSON.stringify(config, null, 2), 'utf8');
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

for (const file of ['LEEME.txt', 'README.md', 'INSTALACION_LARAGON_PANEL.xlsx', 'actualizar.ps1', 'actualizar.bat', 'VERSION']) {
  if (fs.existsSync(path.join(ROOT, file))) {
    fs.copyFileSync(path.join(ROOT, file), path.join(OUT, file));
  }
}

console.log('Portable creado en:', OUT);
console.log('Ejecutable:', path.join(OUT, 'LaragonPanel.exe'));
console.log('Tamaño:', (fs.statSync(path.join(OUT, 'LaragonPanel.exe')).size / 1024 / 1024).toFixed(1), 'MB (exe)');

const seven = 'C:/Program Files/7-Zip/7z.exe';
const zip = path.join(ROOT, 'dist', 'LaragonPanel-portable.zip');
if (fs.existsSync(seven)) {
  try { fs.unlinkSync(zip); } catch {}
  const { execFileSync } = require('child_process');
  execFileSync(seven, ['a', '-tzip', '-mx=7', zip, path.join(OUT, '*'), '-xr!data'], { stdio: 'ignore' });
  console.log('ZIP:', zip);
} else {
  console.log('7-Zip no encontrado; comprime manualmente la carpeta si lo necesitas.');
}
