'use strict';

/*
 * Configuración del panel.
 *
 * Prioridad:
 *   1. Variables de entorno (LARAGON_ROOT, LARAGON_WWW, MYSQL_PORT, PANEL_PORT, PANEL_LAN_PORT).
 *   2. panel.config.json (junto a este archivo).
 *   3. usr\laragon.ini (DocumentRoot) para la carpeta de proyectos.
 *   4. Valores por defecto.
 *
 * Copia panel.config.example.json a panel.config.json y ajusta tu entorno.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'panel.config.json');

let file = {};
try {
  file = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {}

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

function laragonRoot(value) {
  const raw = String(value || '').trim() || 'C:/laragon';
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(__dirname, raw);
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '');
}

function normalize(value) {
  const resolved = path.resolve(String(value));
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '');
}

// DocumentRoot de usr\laragon.ini: permite que los proyectos vivan fuera de <laragon>\www.
function iniDocumentRoot(root) {
  try {
    const ini = fs.readFileSync(path.join(root, 'usr', 'laragon.ini'), 'utf8');
    const m = ini.match(/^\s*DocumentRoot\s*=\s*(.+)$/im);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const root = laragonRoot(process.env.LARAGON_ROOT || file.laragonRoot);
const www = process.env.LARAGON_WWW || file.wwwRoot || iniDocumentRoot(root) || path.join(root, 'www');

module.exports = {
  laragonRoot: root,
  wwwRoot: normalize(www),
  mysqlPort: number(process.env.MYSQL_PORT || file.mysqlPort, 3308),
  panelPort: number(process.env.PANEL_PORT || file.panelPort, 9090),
  lanPort: number(process.env.PANEL_LAN_PORT || file.lanPort, 9091),
  codePath: String(process.env.VSCODE_PATH || file.codePath || '').trim(),
  wtPath: String(process.env.WT_PATH || file.wtPath || '').trim(),
  nssmPath: String(process.env.NSSM_PATH || file.nssmPath || 'C:/laragon/nssm-2.24/win64/nssm.exe').trim(),
  redisPath: String(process.env.REDIS_PATH || file.redisPath || '').trim(),
  phpPath: String(process.env.PHP_PATH || file.phpPath || '').trim(),
  legacyDumps: String(process.env.LEGACY_BACKUP || file.legacyDumps || '').trim(),
  configFile: FILE,
};
