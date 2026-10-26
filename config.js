'use strict';

/*
 * Configuración del panel.
 *
 * Prioridad:
 *   1. Variables de entorno (LARAGON_ROOT, MYSQL_PORT, PANEL_PORT, PANEL_LAN_PORT).
 *   2. panel.config.json (junto a este archivo).
 *   3. Valores por defecto.
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

module.exports = {
  laragonRoot: laragonRoot(process.env.LARAGON_ROOT || file.laragonRoot),
  mysqlPort: number(process.env.MYSQL_PORT || file.mysqlPort, 3308),
  panelPort: number(process.env.PANEL_PORT || file.panelPort, 9090),
  lanPort: number(process.env.PANEL_LAN_PORT || file.lanPort, 9091),
  codePath: String(process.env.VSCODE_PATH || file.codePath || '').trim(),
  wtPath: String(process.env.WT_PATH || file.wtPath || '').trim(),
  legacyDumps: String(process.env.LEGACY_BACKUP || file.legacyDumps || '').trim(),
  configFile: FILE,
};
