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
const laragonStack = require('./laragon-stack');

const FILE = process.env.PANEL_CONFIG
  ? path.resolve(process.env.PANEL_CONFIG)
  : path.join(__dirname, 'panel.config.json');
const DATA_DIR = process.env.PANEL_DATA
  ? path.resolve(process.env.PANEL_DATA)
  : __dirname;

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

const root = laragonRoot(process.env.LARAGON_ROOT || file.laragonRoot);
const fileRoot = laragonRoot(file.laragonRoot || root);
const legacyWww = file.wwwRoot
  ? (path.isAbsolute(String(file.wwwRoot)) ? normalize(file.wwwRoot) : normalize(path.join(fileRoot, String(file.wwwRoot))))
  : '';
const inheritWww = file.wwwRootMode === 'auto'
  || (!file.wwwRootMode && (!legacyWww || legacyWww.toLowerCase() === normalize(path.join(fileRoot, 'www')).toLowerCase()));
const inheritMysqlPort = file.mysqlPortMode === 'auto' || (!file.mysqlPortMode && file.mysqlPort === undefined);
const inheritApachePort = file.apachePortMode === 'auto' || (!file.apachePortMode && file.apachePort === undefined);
const bundledDefaultNssm = String(file.nssmPath || '').replace(/\\/g, '/').toLowerCase();
const defaultNssm = path.join(root, 'nssm-2.24', 'win64', 'nssm.exe');
const nssmPath = bundledDefaultNssm === 'c:/laragon/nssm-2.24/win64/nssm.exe' && root.toLowerCase() !== 'c:/laragon'
  ? defaultNssm
  : (process.env.NSSM_PATH || file.nssmPath || defaultNssm);

function getWwwRoot() {
  const www = process.env.LARAGON_WWW
    || (inheritWww ? '' : file.wwwRoot)
    || laragonStack.readIniValue(root, 'apache', 'DocumentRoot')
    || laragonStack.readIniValue(root, 'preferences', 'DocumentRoot')
    || path.join(root, 'www');
  return path.isAbsolute(String(www)) ? normalize(www) : normalize(path.join(root, String(www)));
}

function getMysqlPort() {
  const override = process.env.MYSQL_PORT || (inheritMysqlPort ? '' : file.mysqlPort);
  const iniPort = Number(laragonStack.readIniValue(root, 'mysql', 'Port')) || 0;
  return number(override, iniPort || 3308);
}

function getApachePort() {
  const override = process.env.APACHE_PORT || (inheritApachePort ? '' : file.apachePort);
  const iniPort = Number(laragonStack.readIniValue(root, 'apache', 'Port')) || 0;
  return number(override, iniPort || 80);
}

function getRedisPort() {
  return number(process.env.REDIS_PORT, laragonStack.redisPort(root, process.env.REDIS_PATH || file.redisPath || ''));
}

module.exports = {
  laragonRoot: root,
  wwwRoot: getWwwRoot(),
  mysqlPort: getMysqlPort(),
  apachePort: getApachePort(),
  redisPort: getRedisPort(),
  panelPort: number(process.env.PANEL_PORT || file.panelPort, 9090),
  lanPort: number(process.env.PANEL_LAN_PORT || file.lanPort, 9091),
  codePath: String(process.env.VSCODE_PATH || file.codePath || '').trim(),
  wtPath: String(process.env.WT_PATH || file.wtPath || '').trim(),
  nssmPath: String(nssmPath).trim(),
  redisPath: String(process.env.REDIS_PATH || file.redisPath || '').trim(),
  phpPath: String(process.env.PHP_PATH || file.phpPath || '').trim(),
  legacyDumps: String(process.env.LEGACY_BACKUP || file.legacyDumps || '').trim(),
  getWwwRoot,
  getMysqlPort,
  getApachePort,
  getRedisPort,
  configFile: FILE,
  dataDir: DATA_DIR,
};
