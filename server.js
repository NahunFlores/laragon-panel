'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');
const backup = require('./backup');
const winservices = require('./winservices');
const config = require('./config');
const laragonStack = require('./laragon-stack');

const LARAGON = config.laragonRoot;
let MYSQL_PORT = config.getMysqlPort();
let APACHE_PORT = config.getApachePort();
const PANEL_PORT = config.panelPort;
const PANEL_LAN_PORT = config.lanPort;
const LEGACY_DUMPS = config.legacyDumps ? path.join(config.legacyDumps, 'dumps') : null;
const LAN_KEY_FILE = path.join(config.dataDir, 'lan-key.txt');
const PANEL_PID_FILE = path.join(config.dataDir, 'panel.pid');

function getLanKey() {
  try {
    const k = fs.readFileSync(LAN_KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch {}
  const k = crypto.randomBytes(24).toString('hex');
  try { atomicReplace(LAN_KEY_FILE, k); } catch {}
  return k;
}

const LAN_KEY = getLanKey();

const LAN_SESSIONS = new Map();
const LAN_FAILS = new Map();
const LAN_SESSION_TTL = 12 * 60 * 60 * 1000;
const LAN_MAX_FAILS = 5;
const LAN_FAIL_WINDOW = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of LAN_SESSIONS) if (exp <= now) LAN_SESSIONS.delete(token);
  for (const [ip, r] of LAN_FAILS) if (r.until <= now) LAN_FAILS.delete(ip);
}, 5 * 60 * 1000).unref();

function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function newLanSession() {
  const token = crypto.randomBytes(24).toString('hex');
  LAN_SESSIONS.set(token, Date.now() + LAN_SESSION_TTL);
  return token;
}

function lanSessionValid(token) {
  if (!token) return false;
  const exp = LAN_SESSIONS.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) { LAN_SESSIONS.delete(token); return false; }
  return true;
}

function lanFails(ip) {
  const r = LAN_FAILS.get(ip);
  if (!r || r.until <= Date.now()) return 0;
  return r.count;
}

function lanRegisterFail(ip) {
  const r = LAN_FAILS.get(ip) && LAN_FAILS.get(ip).until > Date.now() ? LAN_FAILS.get(ip) : { count: 0, until: 0 };
  r.count += 1;
  r.until = Date.now() + LAN_FAIL_WINDOW;
  LAN_FAILS.set(ip, r);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
let WWW = config.getWwwRoot();
const PUBLIC = path.join(__dirname, 'public');

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

function iniSectionValue(section, key) {
  return laragonStack.readIniValue(LARAGON, section, key);
}

function pickVersionDir(baseDir, prefix, iniVersion) {
  const executable = prefix === 'httpd-' ? path.join('bin', 'httpd.exe') : path.join('bin', 'mysqld.exe');
  return laragonStack.selectVersionDir(baseDir, prefix, iniVersion, executable);
}

function pickApache() {
  const name = pickVersionDir(path.join(LARAGON, 'bin', 'apache'), 'httpd-', iniSectionValue('apache', 'version'));
  if (!name) return null;
  const base = path.join(LARAGON, 'bin', 'apache', name);
  return { name, base, exe: path.join(base, 'bin', 'httpd.exe'), conf: path.join(base, 'conf', 'httpd.conf'), logs: path.join(base, 'logs') };
}

function pickMysql() {
  const name = pickVersionDir(path.join(LARAGON, 'bin', 'mysql'), 'mysql-', iniSectionValue('mysql', 'version'));
  if (!name) return null;
  const base = path.join(LARAGON, 'bin', 'mysql', name);
  return {
    name, base,
    exe: path.join(base, 'bin', 'mysqld.exe'),
    client: path.join(base, 'bin', 'mysql.exe'),
    admin: path.join(base, 'bin', 'mysqladmin.exe'),
    dump: path.join(base, 'bin', 'mysqldump.exe'),
    ini: path.join(base, 'my.ini'),
  };
}

let apache = pickApache();
let mysql = pickMysql();
let selectionWarnings = [];
let pendingLaragonSelections = false;
let laragonIniMtime = (() => {
  try { return fs.statSync(path.join(LARAGON, 'usr', 'laragon.ini')).mtimeMs; } catch { return 0; }
})();

function syncActiveRuntimeEnv() {
  if (mysql) process.env.PANEL_ACTIVE_MYSQL_VERSION = mysql.name;
  else delete process.env.PANEL_ACTIVE_MYSQL_VERSION;
  process.env.PANEL_ACTIVE_MYSQL_PORT = String(MYSQL_PORT);
  process.env.PANEL_ACTIVE_WWW_ROOT = WWW;
}
syncActiveRuntimeEnv();

async function refreshLaragonSelections() {
  let mtime = 0;
  try { mtime = fs.statSync(path.join(LARAGON, 'usr', 'laragon.ini')).mtimeMs; } catch {}
  if (!mtime) return;
  if (mtime !== laragonIniMtime) {
    laragonIniMtime = mtime;
    pendingLaragonSelections = true;
  }
  if (!pendingLaragonSelections) return;
  const configuredApache = pickApache();
  const configuredMysql = pickMysql();
  const configuredApachePort = config.getApachePort();
  const configuredMysqlPort = config.getMysqlPort();
  const [apacheBusy, mysqlBusy] = await Promise.all([portOpen(APACHE_PORT), portOpen(MYSQL_PORT)]);
  selectionWarnings = [];
  let stillPending = false;

  const apacheChanged = (configuredApache && configuredApache.name || '') !== (apache && apache.name || '') || configuredApachePort !== APACHE_PORT;
  if (apacheChanged && apacheBusy) {
    selectionWarnings.push(`Laragon cambió Apache/puerto; el proceso actual sigue usando ${apache ? apache.name : 'versión desconocida'}:${APACHE_PORT}. Detén Apache para heredar la nueva selección.`);
    stillPending = true;
  } else {
    apache = configuredApache;
    APACHE_PORT = configuredApachePort;
  }

  const mysqlChanged = (configuredMysql && configuredMysql.name || '') !== (mysql && mysql.name || '') || configuredMysqlPort !== MYSQL_PORT;
  if (mysqlChanged && mysqlBusy) {
    selectionWarnings.push(`Laragon cambió MySQL/puerto; el proceso actual sigue usando ${mysql ? mysql.name : 'versión desconocida'}:${MYSQL_PORT}. Detén MySQL para heredar la nueva selección.`);
    stillPending = true;
  } else {
    mysql = configuredMysql;
    MYSQL_PORT = configuredMysqlPort;
  }
  WWW = config.getWwwRoot();
  pendingLaragonSelections = stillPending;
  syncActiveRuntimeEnv();
}

try { fs.mkdirSync(path.join(LARAGON, 'backups', 'db'), { recursive: true }); } catch {}

function phpVersions() {
  return laragonStack.phpVersions(LARAGON).map(item => ({ ...item, short: item.full }));
}

function activePhpFolder() {
  return laragonStack.apachePhpFolder(LARAGON) || laragonStack.phpFolder(LARAGON);
}

function activePhp() {
  return activePhpObj()?.full || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function portOpen(port, timeout = 700) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = val => { if (!done) { done = true; socket.destroy(); resolve(val); } };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function run(exe, args, opts = {}) {
  return new Promise(resolve => {
    execFile(exe, args, { windowsHide: true, timeout: 30000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function startDetached(exe, args, cwd) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true }); }
    catch (error) { return resolve({ ok: false, error: error.message }); }
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, pid: child.pid });
    });
    child.once('error', error => resolve({ ok: false, error: error.message }));
  });
}

async function waitPort(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port, 400)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function waitPortClosed(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portOpen(port, 400))) return true;
    await sleep(400);
  }
  return !(await portOpen(port, 400));
}

async function serviceStatus() {
  const redisPort = config.getRedisPort();
  const [apacheUp, mysqlUp, redisUp] = await Promise.all([portOpen(APACHE_PORT), portOpen(MYSQL_PORT), portOpen(redisPort)]);
  const stack = laragonStack.stackSnapshot(LARAGON, config.redisPath);
  return {
    apache: { up: apacheUp, port: APACHE_PORT, version: apache ? apache.name.replace(/^httpd-/, '') : null },
    mysql: { up: mysqlUp, port: MYSQL_PORT, version: mysql ? mysql.name.replace(/^mysql-/, '') : null },
    redis: { up: redisUp, port: redisPort, version: stack.redis.selected || null },
  };
}

async function mysqldRunning() {
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq mysqld.exe', '/NH']);
  return /mysqld\.exe/i.test(r.stdout || '');
}

const serviceLocks = new Map();

function withServiceLock(name, fn) {
  const key = String(name || '');
  const prev = serviceLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  serviceLocks.set(key, run);
  return run.finally(() => {
    if (serviceLocks.get(key) === run) serviceLocks.delete(key);
  });
}

const WIN_SERVICE_NAMES = { apache: 'LaragonApache', mysql: 'LaragonMySQL' };

async function managedWinService(name) {
  const target = WIN_SERVICE_NAMES[name];
  if (!target) return null;
  const list = await winservices.listWindowsServices();
  return list.some(s => String(s.Name || '').toLowerCase() === target.toLowerCase()) ? target : null;
}

async function startService(name) {
  const winSvc = await managedWinService(name);
  if (winSvc) {
    const r = await winservices.action(winSvc, 'start');
    return { ok: r.ok, error: r.error, viaService: true, elevated: r.elevated };
  }
  if (name === 'apache') {
    if (!apache) return { ok: false, error: 'Apache no encontrado' };
    if (await portOpen(APACHE_PORT)) return { ok: true, already: true };
    const launched = await startDetached(apache.exe, ['-d', apache.base], path.join(apache.base, 'bin'));
    if (!launched.ok) return { ok: false, error: `No pude iniciar Apache: ${launched.error}` };
    const up = await waitPort(APACHE_PORT, 30000);
    return { ok: up, error: up ? null : `Apache no abrió el puerto ${APACHE_PORT} en 30 s; no se iniciará otra copia. Revisa el log de Apache.` };
  }
  if (name === 'mysql') {
    if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
    if (await portOpen(MYSQL_PORT)) return { ok: true, already: true };

    if (await mysqldRunning()) {
      // Otro proceso puede estar recuperando InnoDB o pertenecer a otra instancia.
      // Esperar y reportar; nunca terminarlo ni iniciar una segunda copia por nombre global.
      const up = await waitPort(MYSQL_PORT, 120000);
      return up
        ? { ok: true, already: true }
        : { ok: false, error: 'Ya existe mysqld.exe pero no abrió el puerto configurado en 120 s. No se inició ni terminó ningún proceso; revisa su log.' };
    }

    const launched = await startDetached(mysql.exe, [`--defaults-file=${mysql.ini}`], path.join(mysql.base, 'bin'));
    if (!launched.ok) return { ok: false, error: `No pude iniciar MySQL: ${launched.error}` };
    const up = await waitPort(MYSQL_PORT, 120000);
    if (up) return { ok: true };
    const stillRunning = await mysqldRunning();
    return { ok: false, error: stillRunning
      ? 'MySQL sigue inicializando después de 120 s. No se lanzará una segunda instancia; revisa el log y consulta el estado antes de reintentar.'
      : 'MySQL terminó antes de abrir el puerto. Revisa el log de MySQL.' };
  }
  return { ok: false, error: 'Servicio desconocido' };
}

async function stopService(name) {
  const winSvc = await managedWinService(name);
  if (winSvc) {
    const r = await winservices.action(winSvc, 'stop');
    return { ok: r.ok, error: r.error, viaService: true, elevated: r.elevated };
  }
  if (name === 'apache') {
    if (!apache) return { ok: false, error: 'Apache no encontrado' };
    const r = await run(apache.exe, ['-k', 'shutdown', '-d', apache.base], { cwd: path.join(apache.base, 'bin'), timeout: 15000 });
    if (r.code !== 0 && !(await portOpen(APACHE_PORT))) return { ok: true, already: true };
    const stopped = await waitPortClosed(APACHE_PORT, 20000);
    return stopped ? { ok: true } : { ok: false, error: 'Apache no confirmó el cierre ordenado; no se forzó el cierre para proteger las solicitudes activas.' };
  }
  if (name === 'mysql') {
    if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
    await run(mysql.admin, ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', 'shutdown']);

    // Esperar a que terminen TODOS los procesos mysqld (padre e hijo)
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const running = await mysqldRunning();
      const open = await portOpen(MYSQL_PORT, 300);
      if (!running && !open) break;
      await sleep(500);
    }

    await sleep(500);
    const stillRunning = await mysqldRunning();
    const stillOpen = await portOpen(MYSQL_PORT);
    return !stillRunning && !stillOpen
      ? { ok: true }
      : { ok: false, error: 'MySQL no confirmó el cierre en 120 s. No se forzó la terminación; revisa transacciones y el log antes de reintentar.' };
  }
  return { ok: false, error: 'Servicio desconocido' };
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function detectProjectType(root) {
  try {
    const norm = String(root || '').replace(/\\/g, '/');
    if (/\/public$/i.test(norm) && fs.existsSync(path.join(root, '..', 'artisan'))) return 'laravel';
    if (fs.existsSync(path.join(root, 'artisan')) && fs.existsSync(path.join(root, 'public', 'index.php'))) return 'laravel';
    if (fs.existsSync(path.join(root, 'package.json')) && (fs.existsSync(path.join(root, 'server.js')) || fs.existsSync(path.join(root, 'app.js')))) return 'node';
    if (fs.existsSync(path.join(root, 'index.php'))) return 'php';
    if (fs.existsSync(path.join(root, 'index.html'))) return 'html';
  } catch {}
  return 'static';
}

function readApacheDefines() {
  const out = {};
  if (!apache) return out;
  try {
    const text = fs.readFileSync(apache.conf, 'utf8');
    const re = /^\s*Define\s+([A-Za-z0-9_]+)\s+"?([^"\r\n]+)"?\s*$/gim;
    let m;
    while ((m = re.exec(text))) out[m[1]] = m[2].trim().replace(/\\/g, '/');
  } catch {}
  return out;
}

function projectName(root) {
  const clean = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/\/public$/i.test(clean)) return path.basename(path.dirname(clean));
  return path.basename(clean);
}

// Puertos reales tomados de httpd-vhosts.conf cuando no hay puertos.csv.
function readVhostProjects() {
  if (!apache) return [];
  let text = '';
  try { text = fs.readFileSync(path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf'), 'utf8'); } catch { return []; }
  const defines = readApacheDefines();
  const out = [];
  const seen = new Set();
  const re = /<VirtualHost\s*\*:(\d+)>([\s\S]*?)<\/VirtualHost>/gi;
  let m;
  while ((m = re.exec(text))) {
    const port = Number(m[1]);
    if (!port || port === 80 || seen.has(port)) continue;
    const dr = m[2].match(/DocumentRoot\s+"([^"]+)"/i);
    if (!dr) continue;
    let root = dr[1];
    for (const [k, v] of Object.entries(defines)) root = root.split('${' + k + '}').join(v);
    root = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/[${}]/.test(root) || !/^[A-Za-z]:\//.test(root)) continue;
    if (!fs.existsSync(root)) continue;
    seen.add(port);
    out.push({ port, name: projectName(root), root, url: `http://127.0.0.1:${port}`, public: /\/public$/i.test(root), type: detectProjectType(root) });
  }
  return out.sort((a, b) => a.port - b.port);
}

function readProjects() {
  const csv = path.join(LARAGON, 'puertos.csv');
  const projects = [];
  try {
    let text = fs.readFileSync(csv, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const [port, name, root] = parseCsvLine(lines[i]);
      if (!port || !name) continue;
      projects.push({
        port: Number(port),
        name,
        root: root || '',
        url: `http://127.0.0.1:${port}`,
        public: /\/public$/i.test(root || ''),
        type: detectProjectType(root || ''),
      });
    }
  } catch {}
  if (!projects.length) projects.push(...readVhostProjects());
  const known = new Set(projects.map(p => (p.root || '').toLowerCase()));
  const dirs = listDirs(WWW)
    .filter(d => !d.startsWith('.') && !['Respaldos', 'moodledata', 'node_modules'].includes(d))
    .sort();
  let next = projects.reduce((max, p) => Math.max(max, p.port), 8000) + 1;
  for (const d of dirs) {
    const root = path.join(WWW, d).replace(/\\/g, '/');
    if (known.has(root.toLowerCase())) continue;
    const dup = projects.some(p => (p.root || '').toLowerCase().startsWith(root.toLowerCase() + '/'));
    if (dup) continue;
    projects.push({ port: next, name: d, root, url: `http://127.0.0.1:${next}`, public: false, type: detectProjectType(root) });
    next += 1;
  }
  return projects;
}

let dbCache = { at: 0, data: [] };
async function listDatabases(force = false) {
  if (!force && Date.now() - dbCache.at < 20000) return dbCache.data;
  if (!mysql) return [];
  const sql = "SELECT s.schema_name, COALESCE(t.tablas,0), COALESCE(ROUND(t.mb,1),0) FROM information_schema.schemata s LEFT JOIN (SELECT table_schema, COUNT(*) AS tablas, SUM(data_length+index_length)/1024/1024 AS mb FROM information_schema.tables GROUP BY table_schema) t ON t.table_schema=s.schema_name WHERE s.schema_name NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY 3 DESC;";
  const r = await run(mysql.client, ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', '-N', '-B', '-e', sql]);
  const data = r.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, tables, mb] = line.split('\t');
    return { name, tables: Number(tables) || 0, mb: Number(mb) || 0 };
  });
  dbCache = { at: Date.now(), data };
  return data;
}

function tailFile(file, lines = 100) {
  try {
    const st = fs.statSync(file);
    const max = 256 * 1024;
    const start = Math.max(0, st.size - max);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch { return ''; }
}

function latestFile(dir, filter) {
  try {
    return fs.readdirSync(dir)
      .filter(filter)
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.f || null;
  } catch { return null; }
}

function setIniValue(iniPath, section, key, value) {
  return laragonStack.writeIniValue(LARAGON, section, key, value);
}

function atomicReplace(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents);
  try { fs.renameSync(temp, file); }
  catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

const NODE_PID_FILE = path.join(config.dataDir, 'node-pids.json');

function readNodePidMap() {
  try {
    const value = JSON.parse(fs.readFileSync(NODE_PID_FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function nodePidKey(root) {
  return path.resolve(root).toLowerCase();
}

function setNodePid(root, pid) {
  const map = readNodePidMap();
  const key = nodePidKey(root);
  if (pid) map[key] = Number(pid);
  else delete map[key];
  try { atomicReplace(NODE_PID_FILE, JSON.stringify(map, null, 2)); } catch {}
}

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const VSCODE = config.codePath || path.join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
const WT = config.wtPath || path.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
const COMPOSER = path.join(LARAGON, 'bin', 'composer', 'composer.phar');

function activePhpObj() {
  const folder = activePhpFolder();
  return phpVersions().find(p => p.folder.toLowerCase() === String(folder).toLowerCase()) || null;
}

const EXTENSIONS = ['curl','fileinfo','gd','intl','mbstring','exif','mysqli','openssl','pdo_mysql','pdo_sqlite','soap','sodium','sqlite3','xsl','zip','sqlsrv','pdo_sqlsrv','redis','opcache'];

function extensionLineMatches(line, name) {
  const kind = name === 'opcache' ? 'zend_extension' : 'extension';
  const match = String(line).match(/^\s*;?\s*(zend_extension|extension)\s*=\s*["']?([^"'\s;]+)["']?/i);
  if (!match || match[1].toLowerCase() !== kind) return false;
  let module = path.basename(match[2]).replace(/\.dll$/i, '').replace(/^php_/i, '').toLowerCase();
  const wanted = String(name).toLowerCase();
  return module === wanted || module.startsWith(`${wanted}_`);
}

function extensionConfigLine(php, name) {
  if (name === 'opcache') return 'zend_extension=opcache';
  const extDir = path.join(php.base, 'ext');
  let files = [];
  try { files = fs.readdirSync(extDir).filter(file => /^php_.*\.dll$/i.test(file)); } catch {}
  const stem = name === 'sqlsrv' ? /^php_sqlsrv(?:_|\.dll)/i
    : name === 'pdo_sqlsrv' ? /^php_pdo_sqlsrv(?:_|\.dll)/i
      : new RegExp(`^php_${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:_|\\.dll)`, 'i');
  const file = files.find(item => stem.test(item));
  return file ? `extension=${file}` : '';
}

function getExtensions() {
  const p = activePhpObj();
  if (!p || !fs.existsSync(p.ini)) return [];
  const lines = fs.readFileSync(p.ini, 'utf8').split(/\r?\n/);
  return EXTENSIONS.map(name => {
    const indices = lines.map((l, i) => extensionLineMatches(l, name) ? i : -1).filter(i => i >= 0);
    const enabledIdx = indices.find(i => !/^\s*;/.test(lines[i]));
    const idx = enabledIdx !== undefined ? enabledIdx : (indices[0] ?? -1);
    return { name, enabled: enabledIdx !== undefined, line: idx >= 0 ? lines[idx].trim() : null };
  });
}

async function toggleExtension(name, enabled) {
  if (selectionWarnings.some(warning => warning.startsWith('Laragon cambió Apache/puerto'))) {
    return { ok: false, error: 'Detén Apache para aplicar la versión seleccionada en laragon.ini antes de cambiar extensiones.' };
  }
  const p = activePhpObj();
  if (!p || !fs.existsSync(p.ini)) return { ok: false, error: 'PHP activo no encontrado' };
  if (!EXTENSIONS.includes(name)) return { ok: false, error: 'Extensión no permitida' };
  const lines = fs.readFileSync(p.ini, 'utf8').split(/\r?\n/);
  const indices = lines.map((l, i) => extensionLineMatches(l, name) ? i : -1).filter(i => i >= 0);
  const activeIndex = indices.find(i => !/^\s*;/.test(lines[i]));
  if (!enabled && activeIndex === undefined) return { ok: true, unchanged: true, extensions: getExtensions() };
  if (enabled && activeIndex !== undefined) return { ok: true, unchanged: true, extensions: getExtensions() };
  if (enabled && activeIndex === undefined && indices.length === 0) {
    const declaration = extensionConfigLine(p, name);
    if (!declaration) return { ok: false, error: `No existe una DLL compatible para ${name} en PHP ${p.full}; no se modificó php.ini.` };
    lines.push(declaration);
  } else if (enabled) {
    let activated = false;
    for (const i of indices) {
      if (!/^\s*;/.test(lines[i]) && !activated) { activated = true; continue; }
      lines[i] = `;${lines[i].replace(/^\s*;\s*/, '')}`;
    }
    if (!activated && indices.length) lines[indices[0]] = lines[indices[0]].replace(/^\s*;\s*/, '');
  } else {
    for (const i of indices) if (!/^\s*;/.test(lines[i])) lines[i] = `;${lines[i]}`;
  }

  const oldIni = fs.readFileSync(p.ini);
  const wasUp = await portOpen(APACHE_PORT);
  atomicReplace(p.ini, lines.join('\r\n'));
  try {
    if (apache) {
      const validation = await run(apache.exe, ['-t', '-d', apache.base], { cwd: path.join(apache.base, 'bin') });
      if (validation.code !== 0) throw new Error((validation.stderr || validation.stdout || 'httpd -t falló').trim());
    }
    if (wasUp) {
      const stopped = await stopService('apache');
      if (!stopped.ok) throw new Error(stopped.error || 'No se pudo detener Apache ordenadamente.');
      const started = await startService('apache');
      if (!started.ok) throw new Error(started.error || 'Apache no inició tras cambiar la extensión.');
    }
  } catch (error) {
    atomicReplace(p.ini, oldIni);
    if (wasUp && !(await portOpen(APACHE_PORT))) await startService('apache');
    return { ok: false, error: `${error.message} Se restauró el php.ini anterior.` };
  }
  return { ok: true, extensions: getExtensions() };
}

async function nextPort() {
  const ports = readProjects().map(p => p.port).filter(n => Number.isFinite(n));
  let port = Math.max(8058, ...ports) + 1;
  while (port <= 65535 && await portOpen(port, 200)) port++;
  if (port > 65535) throw new Error('No quedan puertos disponibles para el sitio.');
  return port;
}

function csvValue(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function snapshotFiles(files) {
  return new Map(files.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
}

function restoreFiles(snapshot) {
  for (const [file, contents] of snapshot) {
    if (contents === null) {
      try { fs.rmSync(file, { force: true }); } catch {}
    } else {
      atomicReplace(file, contents);
    }
  }
}

function addVhost(name, root, port) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const r = root.replace(/\\/g, '/');
  const block = `\nListen ${port}\n\n<VirtualHost *:${port}>\n    DocumentRoot "${r}"\n    ServerName 127.0.0.1\n    DirectoryIndex index.php index.html\n    <Directory "${r}">\n        Options Indexes FollowSymLinks\n        AllowOverride All\n        Require all granted\n    </Directory>\n    ErrorLog "logs/${safe}-error.log"\n    CustomLog "logs/${safe}-access.log" common\n</VirtualHost>\n`;
  const file = path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf');
  const current = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  atomicReplace(file, Buffer.concat([current, Buffer.from(block, 'utf8')]));
}

function htmlPage(name) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8eefb;font-family:system-ui,sans-serif}main{text-align:center;padding:40px}h1{font-size:32px;margin:0 0 8px}p{color:#8ea0ba}</style></head><body><main><h1>${name}</h1><p>Proyecto creado desde Laragon Panel.</p></main></body></html>`;
}

function ensureProxyModules() {
  const conf = path.join(apache.base, 'conf', 'httpd.conf');
  let c = fs.readFileSync(conf, 'utf8');
  const original = c;
  c = c.replace(/^#\s*LoadModule proxy_module .*$/m, 'LoadModule proxy_module modules/mod_proxy.so');
  c = c.replace(/^#\s*LoadModule proxy_http_module .*$/m, 'LoadModule proxy_http_module modules/mod_proxy_http.so');
  if (c !== original) atomicReplace(conf, c);
}

function ensureSqliteDriver() {
  try {
    const p = activePhpObj();
    if (!p) return;
    const dst = path.join(apache.base, 'bin', 'libsqlite3.dll');
    if (fs.existsSync(dst)) return;
    const src = path.join(p.base, 'libsqlite3.dll');
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  } catch {}
}

async function findFreePort(start) {
  let p = start;
  while (await portOpen(p, 300)) p++;
  return p;
}

function startNodeApp(root, port) {
  const logDir = path.join(LARAGON, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const safe = path.basename(root).replace(/[^A-Za-z0-9._-]/g, '_');
  const logFile = path.join(logDir, `node-${safe}.log`);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] start ${safe} en 127.0.0.1:${port}\r\n`);
  const fd = fs.openSync(logFile, 'a');
  const nodeEnv = { ...process.env, PORT: String(port) };
  delete nodeEnv.PANEL_ACTIVE_MYSQL_VERSION;
  delete nodeEnv.PANEL_ACTIVE_MYSQL_PORT;
  delete nodeEnv.PANEL_ACTIVE_WWW_ROOT;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, 'server.js')], {
        cwd: root,
        env: nodeEnv,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      try { fs.closeSync(fd); } catch {}
      return resolve({ ok: false, error: error.message });
    }
    child.once('spawn', () => {
      try { fs.closeSync(fd); } catch {}
      setNodePid(root, child.pid);
      child.once('exit', () => {
        if (Number(readNodePidMap()[nodePidKey(root)]) === child.pid) setNodePid(root, 0);
      });
      child.unref();
      resolve({ ok: true, pid: child.pid });
    });
    child.once('error', error => {
      try { fs.closeSync(fd); } catch {}
      resolve({ ok: false, error: error.message });
    });
  });
}

async function startNodeApps() {
  for (const p of readProjects()) {
    if (p.type !== 'node') continue;
    const marker = path.join(p.root, '.panel-node-port');
    if (!fs.existsSync(marker)) continue;
    const port = Number(fs.readFileSync(marker, 'utf8').trim());
    if (!port) continue;
    if (!(await portOpen(port, 500))) {
      const result = await startNodeApp(p.root, port);
      if (!result.ok) throw new Error(`No se pudo iniciar ${p.name}: ${result.error}`);
    }
  }
}

async function nodeServices() {
  const out = [];
  for (const p of readProjects()) {
    if (p.type !== 'node') continue;
    const marker = path.join(p.root, '.panel-node-port');
    let internalPort = null;
    if (fs.existsSync(marker)) internalPort = Number(fs.readFileSync(marker, 'utf8').trim()) || null;
    out.push({
      name: p.name,
      port: p.port,
      root: p.root,
      internalPort,
      running: internalPort ? await portOpen(internalPort, 300) : false,
    });
  }
  return out;
}

async function stopNodeByPort(port, root) {
  const pid = Number(readNodePidMap()[nodePidKey(root)]) || 0;
  if (!pid) return { ok: false, error: 'No hay PID propio registrado; no se terminará un proceso que solo coincide por puerto.' };
  const expectedRoot = path.resolve(root).replace(/'/g, "''");
  const cmd = `$expected='${expectedRoot}'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p -and $p.Name -match '^node(\.exe)?$' -and $p.CommandLine -and $p.CommandLine.IndexOf($expected,[StringComparison]::OrdinalIgnoreCase) -ge 0){ Stop-Process -Id ${pid} -Force; exit 0 } else { exit 2 }`;
  const result = await run('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 15000 });
  if (result.code !== 0) return { ok: false, error: 'El PID registrado no coincide con un proceso Node de este proyecto; no se tocó el proceso.' };
  for (let i = 0; i < 40 && await portOpen(port, 300); i++) await sleep(300);
  const stopped = !(await portOpen(port));
  if (stopped) setNodePid(root, 0);
  return stopped ? { ok: true } : { ok: false, error: 'El proceso terminó, pero el puerto sigue ocupado por otro proceso.' };
}

async function nodeAction(name, action) {
  const p = readProjects().find(x => x.name === name && x.type === 'node');
  if (!p) return { ok: false, error: 'Aplicación Node no encontrada' };
  const marker = path.join(p.root, '.panel-node-port');
  if (!fs.existsSync(marker)) return { ok: false, error: 'Falta .panel-node-port' };
  const internal = Number(fs.readFileSync(marker, 'utf8').trim());
  if (!internal) return { ok: false, error: 'Puerto interno inválido' };
  if (action === 'stop' || action === 'restart') {
    const stopped = await stopNodeByPort(internal, p.root);
    if (!stopped.ok) return stopped;
  }
  if (action === 'start' || action === 'restart') {
    if (!(await portOpen(internal, 300))) {
      const launched = await startNodeApp(p.root, internal);
      if (!launched.ok) return { ok: false, error: launched.error };
      for (let i = 0; i < 30 && !(await portOpen(internal, 300)); i++) await new Promise(r => setTimeout(r, 300));
    }
  }
  const running = await portOpen(internal, 300);
  return { ok: running, running, error: running ? null : 'La aplicación no abrió su puerto interno.' };
}

function addProxyVhost(name, port, internalPort) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const block = `\nListen ${port}\n\n<VirtualHost *:${port}>\n    ProxyPreserveHost On\n    ProxyPass "/" "http://127.0.0.1:${internalPort}/"\n    ProxyPassReverse "/" "http://127.0.0.1:${internalPort}/"\n    ServerName 127.0.0.1\n    ErrorLog "logs/${safe}-error.log"\n    CustomLog "logs/${safe}-access.log" common\n</VirtualHost>\n`;
  const file = path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf');
  const current = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  atomicReplace(file, Buffer.concat([current, Buffer.from(block, 'utf8')]));
}

async function createSite(body) {
  let name = String(body.name || '').trim();
  const type = body.type || 'php';
  if (!['link', 'php', 'laravel', 'html', 'node'].includes(type)) return { ok: false, error: 'Tipo de sitio inválido' };
  const existing = String(body.path || '').trim();
  if (type === 'link') {
    if (!existing || !fs.existsSync(existing) || !fs.statSync(existing).isDirectory()) return { ok: false, error: 'Carpeta no válida' };
    name = path.basename(existing);
  }
  if (!/^[A-Za-z0-9._ -]{1,60}$/.test(name)) return { ok: false, error: 'Nombre inválido' };

  let root = type === 'link' ? existing : path.join(WWW, name);
  let nodeInternal = null;

  if (type !== 'link') {
    if (fs.existsSync(root)) return { ok: false, error: 'Ya existe esa carpeta' };
    fs.mkdirSync(root, { recursive: true });

    if (type === 'laravel') {
      const p = activePhpObj();
      if (!p) return { ok: false, error: 'No hay un PHP válido activo para crear Laravel.' };
      const r = await run(p.exe, [COMPOSER, 'create-project', 'laravel/laravel', root, '--prefer-dist', '--no-interaction'], { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
      if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'Composer falló').slice(0, 2000) };
      ensureSqliteDriver();
      try {
        const dbFile = path.join(root, 'database', 'database.sqlite');
        if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '');
        await run(p.exe, [path.join(root, 'artisan'), 'migrate', '--force'], { cwd: root, timeout: 180000, maxBuffer: 5 * 1024 * 1024 });
      } catch {}
    } else if (type === 'node') {
      const serverCode = `const http = require('http');
const html = ${JSON.stringify(htmlPage(name))};
const port = Number(process.env.PORT || 3100);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(port, '127.0.0.1', () => console.log('Node site en ' + port));
`;
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9._-]/g, '-'), version: '1.0.0', private: true, scripts: { start: 'node server.js' } }, null, 2), 'utf8');
      fs.writeFileSync(path.join(root, 'server.js'), serverCode, 'utf8');
      nodeInternal = await findFreePort(3100);
      fs.writeFileSync(path.join(root, '.panel-node-port'), String(nodeInternal), 'utf8');
    } else if (type === 'html') {
      fs.writeFileSync(path.join(root, 'index.html'), htmlPage(name), 'utf8');
    } else {
      fs.writeFileSync(path.join(root, 'index.php'), `<?php echo <<<'HTML'\n${htmlPage(name)}\nHTML;\n`, 'utf8');
    }
  }

  const docs = path.join(root, 'public');
  const docRoot = fs.existsSync(path.join(docs, 'index.php')) ? docs : root;
  const port = await nextPort();

  const linkedNode = type === 'link' && detectProjectType(root) === 'node' && fs.existsSync(path.join(root, '.panel-node-port'));
  const isNodeSite = type === 'node' || linkedNode;
  if (isNodeSite && !nodeInternal) nodeInternal = Number(fs.readFileSync(path.join(root, '.panel-node-port'), 'utf8').trim());
  if (isNodeSite && (!Number.isInteger(nodeInternal) || nodeInternal < 1 || nodeInternal > 65535)) return { ok: false, error: 'Puerto interno de Node inválido.' };

  const vhostsFile = path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf');
  const apacheConf = path.join(apache.base, 'conf', 'httpd.conf');
  const portsFile = path.join(LARAGON, 'puertos.csv');
  const snapshots = snapshotFiles(isNodeSite ? [apacheConf, vhostsFile, portsFile] : [vhostsFile, portsFile]);
  const apacheWasUp = await portOpen(APACHE_PORT);
  try {
    if (isNodeSite) ensureProxyModules();
    if (isNodeSite) addProxyVhost(name, port, nodeInternal);
    else addVhost(name, docRoot, port);

    let csv = '';
    if (fs.existsSync(portsFile)) csv = fs.readFileSync(portsFile, 'utf8');
    if (!csv.trim()) csv = `${csvValue('Puerto')},${csvValue('Proyecto')},${csvValue('DocumentRoot')}\r\n`;
    const row = [port, name, docRoot.replace(/\\/g, '/')].map(csvValue).join(',') + '\r\n';
    atomicReplace(portsFile, `${csv.replace(/\s*$/, '')}\r\n${row}`);

    const validation = await run(apache.exe, ['-t', '-d', apache.base], { cwd: path.join(apache.base, 'bin') });
    if (validation.code !== 0) throw new Error(`Apache rechazó el nuevo sitio: ${(validation.stderr || validation.stdout || 'httpd -t falló').trim()}`);
    if (apacheWasUp) {
      const stopped = await stopService('apache');
      if (!stopped.ok) throw new Error(stopped.error || 'No se pudo detener Apache ordenadamente.');
      const started = await startService('apache');
      if (!started.ok) throw new Error(`Apache no reinició: ${started.error || 'error desconocido'}`);
    }
  } catch (error) {
    restoreFiles(snapshots);
    if (apacheWasUp && !(await portOpen(APACHE_PORT))) await startService('apache');
    return { ok: false, error: `${error.message} Se restauraron los vhosts y el mapeo de puertos; la carpeta del proyecto se conservó.` };
  }

  let nodeWarning = null;
  if (type === 'node') {
    const launched = await startNodeApp(root, nodeInternal);
    if (!launched.ok) nodeWarning = `Sitio creado, pero Node no arrancó: ${launched.error}`;
  }
  return { ok: true, warning: nodeWarning, project: { name, port, root: docRoot.replace(/\\/g, '/'), url: `http://127.0.0.1:${port}`, type: type === 'link' ? detectProjectType(docRoot) : type } };
}

function listBackups() {
  const roots = [path.join(LARAGON, 'backups', 'db')];
  if (LEGACY_DUMPS && fs.existsSync(LEGACY_DUMPS)) roots.push(LEGACY_DUMPS);
  const out = [];
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith('.sql')) {
        try {
          const st = fs.statSync(full);
          out.push({ name: full.replace(/\\/g, '/'), file: full, mb: +(st.size / 1048576).toFixed(2), mtime: st.mtimeMs });
        } catch {}
      }
    }
  }
  roots.forEach(walk);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}

async function importDump(file) {
  const allowed = [path.resolve(LARAGON, 'backups')];
  if (LEGACY_DUMPS) allowed.push(path.resolve(LEGACY_DUMPS));
  const full = path.resolve(String(file || ''));
  if (!allowed.some(r => full === r || full.startsWith(r + path.sep))) return { ok: false, error: 'Archivo no permitido' };
  if (!fs.existsSync(full)) return { ok: false, error: 'Archivo no encontrado' };
  if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
  // Se envia el dump por stdin: evita cmd.exe, comillas y redirecciones fragiles.
  return await new Promise(resolve => {
    const child = spawn(mysql.client, ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', '--default-character-set=utf8mb4'], { windowsHide: true });
    let err = '';
    const stream = fs.createReadStream(full);
    stream.on('error', e => { err += e.message; try { child.kill(); } catch {} });
    stream.pipe(child.stdin);
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => resolve({ ok: false, error: e.message }));
    child.on('close', code => resolve(code === 0 ? { ok: true } : { ok: false, error: (err || `exit ${code}`).slice(0, 2000) }));
  });
}

async function dbAction(action, name) {
  if (!/^[A-Za-z0-9_$.-]{1,64}$/.test(name)) return { ok: false, error: 'Nombre inválido' };
  const sql = action === 'create'
    ? `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    : `DROP DATABASE \`${name}\`;`;
  const r = await run(mysql.client, ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', '-e', sql]);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || 'Error SQL').slice(0, 1000) };
}

async function backupAll() {
  const dbs = (await listDatabases(true)).map(d => d.name);
  if (!dbs.length) return { ok: false, error: 'No hay bases' };
  const dir = path.join(LARAGON, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = path.join(dir, `all_${stamp}.sql`);
  const args = ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob', '--default-character-set=utf8mb4', '--set-gtid-purged=OFF', '--no-tablespaces', '--databases', ...dbs];
  return await new Promise(resolve => {
    const ws = fs.createWriteStream(out);
    const child = spawn(mysql.dump, args, { windowsHide: true });
    let err = '';
    child.stdout.pipe(ws);
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => {
      ws.end(() => resolve(code === 0 ? { ok: true, file: out, mb: +(fs.statSync(out).size / 1048576).toFixed(2) } : { ok: false, error: err || `exit ${code}` }));
    });
  });
}

function httpStatus(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3500 }, res => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

const PREVIEW_DIR = path.join(config.dataDir, 'previews');
const PREVIEW_TTL = 15 * 60 * 1000;
const PREVIEW_MAX = 3;
const PREVIEW_WIDTH = 1000;
const PREVIEW_HEIGHT = 700;
let previewBrowser;
const previewQueue = [];
const previewPending = new Set();
let previewRunning = 0;

function findBrowser() {
  if (previewBrowser !== undefined) return previewBrowser;
  const candidates = [
    process.env.PREVIEW_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  previewBrowser = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || '';
  return previewBrowser;
}

function capturePreview(port) {
  return new Promise(resolve => {
    const browser = findBrowser();
    if (!browser) return resolve({ ok: false, error: 'No hay Edge ni Chrome para capturar la vista previa' });
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    const target = path.join(PREVIEW_DIR, `${port}.png`);
    const stamp = `${port}-${Date.now()}`;
    const tmpFile = path.join(PREVIEW_DIR, `.tmp-${stamp}.png`);
    const profile = path.join(os.tmpdir(), `laragon-preview-profile-${stamp}`);
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      `--user-data-dir=${profile}`,
      `--window-size=${PREVIEW_WIDTH},${PREVIEW_HEIGHT}`,
      '--virtual-time-budget=2500',
      `--screenshot=${tmpFile}`,
      `http://127.0.0.1:${port}/`,
    ], { windowsHide: true, stdio: 'ignore' });
    let done = false;
    let exitCode = null;
    let spawnError = '';
    const finish = () => {
      if (done) return;
      done = true;
      let ok = false;
      try {
        if (fs.existsSync(tmpFile)) { fs.renameSync(tmpFile, target); ok = true; }
      } catch (e) { spawnError = spawnError || e.message; }
      try { fs.rmSync(tmpFile, { force: true }); } catch {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
      try {
        fs.appendFileSync(path.join(PREVIEW_DIR, '.capture.log'), `${new Date().toISOString()} port=${port} ok=${ok} code=${exitCode} ${spawnError}\n`);
      } catch {}
      resolve({ ok, error: ok ? null : (spawnError || `captura vacía (exit ${exitCode})`) });
    };
    child.on('error', e => { spawnError = e.message; finish(); });
    child.on('close', code => { exitCode = code; finish(); });
    setTimeout(() => { try { child.kill(); } catch {} finish(); }, 30000);
  });
}

function pumpPreviews() {
  while (previewRunning < PREVIEW_MAX && previewQueue.length) {
    const port = previewQueue.shift();
    previewRunning += 1;
    capturePreview(port).catch(() => {}).finally(() => {
      previewRunning -= 1;
      previewPending.delete(port);
      pumpPreviews();
    });
  }
}

function enqueuePreview(port) {
  if (previewPending.has(port)) return;
  previewPending.add(port);
  previewQueue.push(port);
  pumpPreviews();
}

function sendPreview(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'sin vista previa' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function apacheVhostLogs(port) {
  if (!apache) return [];
  let text = '';
  try { text = fs.readFileSync(path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf'), 'utf8'); } catch { return []; }
  const out = [];
  const re = /<VirtualHost\s*\*:(\d+)>([\s\S]*?)<\/VirtualHost>/gi;
  let m;
  while ((m = re.exec(text))) {
    if (Number(m[1]) !== Number(port)) continue;
    for (const kind of ['ErrorLog', 'CustomLog']) {
      const lm = m[2].match(new RegExp(`^\\s*${kind}\\s+"?([^"\\r\\n]+)"?`, 'im'));
      if (!lm) continue;
      const raw = lm[1].trim().replace(/\\/g, '/');
      if (!raw || /^(pipe|syslog)/i.test(raw)) continue;
      const full = path.isAbsolute(raw) ? raw : path.join(apache.base, raw);
      out.push({ kind: kind === 'ErrorLog' ? 'error' : 'access', file: full });
    }
  }
  return out;
}

function projectLogFiles(project) {
  const files = [];
  const seen = new Set();
  const add = (id, label, file, kind) => {
    if (!file) return;
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return;
    let st = null;
    try { st = fs.statSync(file); } catch { return; }
    if (!st.isFile()) return;
    seen.add(key);
    files.push({ id, label, kind, path: file.replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs });
  };

  let root = (project.root || '').replace(/\\/g, '/');
  if (/\/public$/i.test(root)) root = path.dirname(root);
  const logDir = path.join(root, 'storage', 'logs');
  try {
    fs.readdirSync(logDir)
      .filter(f => f.toLowerCase().endsWith('.log'))
      .map(f => ({ f, t: fs.statSync(path.join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .forEach(({ f }) => add(`app:${f}`, `App · ${f}`, path.join(logDir, f), 'app'));
  } catch {}

  for (const l of apacheVhostLogs(project.port)) {
    add(`apache:${l.kind}`, `Apache · ${l.kind}`, l.file, 'apache');
  }

  const safe = (project.name || '').replace(/[^A-Za-z0-9._-]/g, '_');
  add('node', 'Node · panel', path.join(LARAGON, 'logs', `node-${safe}.log`), 'node');

  return files;
}

function lineTime(line) {
  let m;
  if ((m = line.match(/^\[(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/))) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  if ((m = line.match(/^\[(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/))) {
    const t = Date.parse(`${m[1]} ${m[2]} ${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`);
    if (!Number.isNaN(t)) return t;
  }
  if ((m = line.match(/^\[\w{3} ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)? (\d{4})/))) {
    const t = Date.parse(`${m[1]} ${m[2]} ${m[6]} ${m[3]}:${m[4]}:${m[5]}`);
    if (!Number.isNaN(t)) return t;
  }
  if ((m = line.match(/^\[?(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/))) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  return null;
}

function readLogFiltered(file, sinceMs, untilMs, maxLines) {
  const st = fs.statSync(file);
  const maxBytes = 4 * 1024 * 1024;
  const start = Math.max(0, st.size - maxBytes);
  const buf = Buffer.alloc(st.size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split(/\r?\n/);
  // Agrupar en entradas: la linea con fecha abre una entrada y las continuaciones
  // (trazas de Laravel, etc.) se van con ella para no cortar el bloque a medias.
  const blocks = [];
  let current = null;
  let lastTime = null;
  for (const line of lines) {
    const t = lineTime(line);
    if (t !== null) {
      if (current) blocks.push(current);
      current = { t, lines: [line] };
      lastTime = t;
      continue;
    }
    if (!current) current = { t: lastTime, lines: [line] };
    else current.lines.push(line);
  }
  if (current) blocks.push(current);
  const kept = blocks.filter(b => {
    if (b.t === null) return !sinceMs && !untilMs;
    if (sinceMs && b.t < sinceMs) return false;
    if (untilMs && b.t > untilMs) return false;
    return true;
  });
  const MAX_ENTRY_LINES = 60;
  const picked = [];
  let count = 0;
  for (let i = kept.length - 1; i >= 0 && count < maxLines; i--) {
    const b = kept[i];
    const body = b.lines.length > MAX_ENTRY_LINES
      ? [...b.lines.slice(0, MAX_ENTRY_LINES), `… (${b.lines.length - MAX_ENTRY_LINES} líneas omitidas)`]
      : b.lines;
    if (picked.length && count + body.length > maxLines) break;
    picked.unshift(body.join('\n'));
    count += body.length;
  }
  const text = picked.join('\n');
  return {
    text,
    truncated: start > 0,
    lines: count,
    entries: kept.length,
    cut: picked.length < kept.length,
  };
}

function apacheErrorLog() {
  if (!apache) return null;
  let text = '';
  try { text = fs.readFileSync(apache.conf, 'utf8'); } catch {}
  const m = text.match(/^\s*ErrorLog\s+"?([^"\r\n]+)"?/im);
  if (m) {
    const raw = m[1].trim().replace(/\\/g, '/');
    if (!/^(pipe|syslog)/i.test(raw)) {
      const full = path.isAbsolute(raw) ? raw : path.join(apache.base, raw);
      if (fs.existsSync(full)) return full;
    }
  }
  for (const cand of ['logs/error_log', 'logs/error.log']) {
    const full = path.join(apache.base, cand);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function mysqlErrorLog() {
  if (!mysql) return null;
  let dataDir = '';
  try {
    const ini = fs.readFileSync(mysql.ini, 'utf8');
    const m = ini.match(/^\s*datadir\s*=\s*"?([^"\r\n]+)"?/im);
    if (m) {
      const raw = m[1].trim().replace(/\\/g, '/');
      dataDir = path.isAbsolute(raw) ? raw : path.join(mysql.base, raw);
    }
  } catch {}
  const dirs = [dataDir, path.join(LARAGON, 'data', 'mysql-8'), path.join(LARAGON, 'data', 'mysql-8.4')].filter(Boolean);
  for (const dir of dirs) {
    const f = latestFile(dir, x => x.endsWith('.err'));
    if (f) return path.join(dir, f);
  }
  return null;
}

let statusCache = { at: 0, data: {} };
async function projectStatuses() {
  if (Date.now() - statusCache.at < 15000) return statusCache.data;
  const list = readProjects();
  const data = {};
  const queue = list.slice();
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      data[p.port] = await httpStatus(p.port);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  statusCache = { at: Date.now(), data };
  return data;
}

function openTool(target, tool) {
  const p = path.resolve(target);
  const allowed = [path.resolve(WWW), ...readProjects().map(x => path.resolve(x.root))];
  if (!allowed.some(r => p === r || p.startsWith(r + path.sep))) return { ok: false, error: 'Ruta no permitida' };
  if (tool === 'folder') spawn('explorer.exe', [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else if (tool === 'code') {
    if (!fs.existsSync(VSCODE)) return { ok: false, error: 'VS Code no encontrado' };
    spawn('cmd.exe', ['/c', `"${VSCODE}" "${p}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (tool === 'terminal') {
    if (!fs.existsSync(WT)) {
      spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', `cd /d "${p}"`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      spawn(WT, ['-d', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } else return { ok: false, error: 'Herramienta inválida' };
  return { ok: true };
}

async function switchPhp(branch) {
  if (selectionWarnings.some(warning => warning.startsWith('Laragon cambió Apache/puerto'))) {
    return { ok: false, error: 'Laragon tiene otra versión de Apache seleccionada; detén el servicio y vuelve a intentar.' };
  }
  const list = phpVersions();
  // mod_php necesita PHP Thread Safe (ZTS); un build NTS no se debe activar en Apache.
  const candidates = list
    .filter(p => p.branch === branch && p.apache && p.ts && p.x64)
    .sort((a, b) => laragonStack.compareVersions(b.full, a.full)
      || laragonStack.compareVersionNames(b.folder, a.folder)
      || (Number(b.ts) - Number(a.ts)));
  const target = candidates[0];
  if (!target) return { ok: false, error: 'Versión no instalada' };
  const dir = target.base.replace(/\\/g, '/');
  let conf = `# PHP ${target.short} (panel)\n`;
  // Apache puede cargar su propia libssl; precargar las de PHP evita conflictos de version.
  for (const lib of ['libcrypto-3-x64.dll', 'libssl-3-x64.dll']) {
    if (fs.existsSync(path.join(target.base, lib))) conf += `LoadFile "${dir}/${lib}"\n`;
  }
  conf += `LoadModule php_module "${dir}/php8apache2_4.dll"\nPHPIniDir "${dir}"\n<IfModule mime_module>\n    AddType application/x-httpd-php .php\n</IfModule>\n`;
  const modPhpFile = path.join(LARAGON, 'etc', 'apache2', 'mod_php.conf');
  const laragonIni = path.join(LARAGON, 'usr', 'laragon.ini');
  const apacheFolder = apache && apache.name;
  if (!apacheFolder) return { ok: false, error: 'Apache no encontrado; no se cambió PHP.' };
  const httpd = path.join(apache.base, 'bin', 'httpd.exe');
  const wasUp = await portOpen(APACHE_PORT);
  let oldModPhp;
  let oldIni;
  try {
    oldModPhp = fs.existsSync(modPhpFile) ? fs.readFileSync(modPhpFile) : null;
    oldIni = fs.readFileSync(laragonIni);
    fs.mkdirSync(path.dirname(modPhpFile), { recursive: true });
    atomicReplace(modPhpFile, conf);
    setIniValue(laragonIni, 'php', 'Version', target.folder);

    const validation = await run(httpd, ['-t', '-d', apache.base], { cwd: path.join(apache.base, 'bin') });
    if (validation.code !== 0) throw new Error(`Apache rechazó PHP ${target.full}: ${(validation.stderr || validation.stdout || 'httpd -t falló').trim()}`);

    if (wasUp) {
      const stopped = await stopService('apache');
      if (!stopped.ok) throw new Error(stopped.error || 'No se pudo detener Apache ordenadamente.');
      const started = await startService('apache');
      if (!started.ok) throw new Error(started.error || 'Apache no pudo iniciar con la versión PHP seleccionada.');
    }
    return { ok: true, active: target.full, folder: target.folder, restarted: wasUp };
  } catch (error) {
    try {
      if (oldModPhp) atomicReplace(modPhpFile, oldModPhp);
      else fs.rmSync(modPhpFile, { force: true });
      if (oldIni) atomicReplace(laragonIni, oldIni);
    } catch (restoreError) {
      return { ok: false, error: `${error.message} Además, falló la restauración de la configuración: ${restoreError.message}` };
    }
    if (wasUp && !(await portOpen(APACHE_PORT))) {
      const restored = await startService('apache');
      if (!restored.ok) return { ok: false, error: `${error.message} La configuración previa fue restaurada, pero Apache no arrancó: ${restored.error}` };
    }
    return { ok: false, error: `${error.message} Se restauró la configuración anterior.` };
  }
}

async function dumpDatabase(db) {
  if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
  if (!/^[A-Za-z0-9_$.-]+$/.test(db)) return { ok: false, error: 'Nombre inválido' };
  const dir = path.join(LARAGON, 'backups', 'db');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = path.join(dir, `${db}_${stamp}.sql`);
  const args = ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob', '--default-character-set=utf8mb4', '--set-gtid-purged=OFF', '--no-tablespaces', '--databases', db];
  return await new Promise(resolve => {
    const ws = fs.createWriteStream(out);
    const child = spawn(mysql.dump, args, { windowsHide: true });
    let err = '';
    child.stdout.pipe(ws);
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => {
      ws.end(() => {
        resolve(code === 0 ? { ok: true, file: out, mb: (fs.statSync(out).size / 1024 / 1024).toFixed(2) } : { ok: false, error: err || `exit ${code}` });
      });
    });
  });
}

function diskInfo() {
  try {
    const s = fs.statfsSync('C:/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { totalGB: +(total / 1073741824).toFixed(1), freeGB: +(free / 1073741824).toFixed(1), usedPct: Math.round((1 - free / total) * 100) };
  } catch { return null; }
}

function sendSession(res, token) {
  res.writeHead(302, {
    'Set-Cookie': `laragon_sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(LAN_SESSION_TTL / 1000)}`,
    Location: '/',
  });
  return res.end();
}

function serveLogin(res, error = '') {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laragon Panel · Acceso</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(800px 500px at 20% 0%,rgba(34,211,238,.16),transparent 60%),#070b14;color:#e8eefb;font-family:Inter,system-ui,sans-serif}
  .box{width:min(380px,90vw);background:linear-gradient(180deg,#0e1829,#111f36);border:1px solid rgba(148,163,184,.2);border-radius:18px;padding:26px;box-shadow:0 18px 50px rgba(0,0,0,.4)}
  .mark{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;font-weight:800;color:#041016;background:linear-gradient(135deg,#22d3ee,#818cf8);margin-bottom:14px}
  h1{font-size:20px;margin:0 0 6px}
  p{color:#8ea0ba;font-size:13px;line-height:1.5;margin:0 0 18px}
  input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:11px;border:1px solid rgba(148,163,184,.3);background:#070b14;color:#e8eefb;font-size:14px;outline:none}
  input:focus{border-color:rgba(34,211,238,.6)}
  button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:11px;font-weight:700;color:#06101d;background:linear-gradient(135deg,#22d3ee,#818cf8);cursor:pointer}
  .err{color:#fb7185;font-size:12px;margin-top:10px}
</style></head><body>
<div class="box">
  <div class="mark">L</div>
  <h1>Laragon Panel</h1>
  <p>Acceso desde la red local. Introduce la clave que aparece en el panel local, sección <strong>Compartir</strong>.</p>
  <form method="post" action="/login">
    <input name="key" type="password" placeholder="Clave de acceso" autofocus autocomplete="off">
    <button type="submit">Entrar</button>
  </form>
  ${error ? `<div class="err">${error}</div>` : ''}
</div></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

let cpuPrev = null;
let gpuCache = { at: 0, name: null };
let procCache = { at: 0, data: null, snapshot: {} };

function cpuUsage(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (!cpuPrev) {
    cpuPrev = { idle, total };
    return 0;
  }
  const dIdle = idle - cpuPrev.idle;
  const dTotal = total - cpuPrev.total;
  cpuPrev = { idle, total };
  if (dTotal <= 0) return 0;
  return +(100 * (1 - dIdle / dTotal)).toFixed(1);
}

async function getGpuName() {
  if (Date.now() - gpuCache.at < 300000) return gpuCache.name;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name"]);
  const name = (r.stdout || '').trim().split(/\r?\n/)[0] || null;
  gpuCache = { at: Date.now(), name };
  return name;
}

async function getProcessStats() {
  const now = Date.now();
  if (procCache.data && now - procCache.at < 2500) return procCache.data;

  const cmd = `Get-CimInstance Win32_Process -Filter "Name='httpd.exe' OR Name='mysqld.exe' OR Name='node.exe' OR Name='electron.exe'" | Select-Object ProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime,CommandLine | ConvertTo-Json -Compress`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', cmd]);
  let panelPid = 0;
  try { panelPid = Number(fs.readFileSync(PANEL_PID_FILE, 'utf8')) || 0; } catch {}
  let list = [];
  try {
    const parsed = JSON.parse((r.stdout || '').trim() || '[]');
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}

  const cores = os.cpus().length || 1;
  const elapsed = procCache.at ? (now - procCache.at) / 1000 : 0;
  const groups = {
    apache: { count: 0, ram: 0, cpu: 0 },
    mysql: { count: 0, ram: 0, cpu: 0 },
    node: { count: 0, ram: 0, cpu: 0 },
    panel: { count: 0, ram: 0, cpu: 0 },
  };
  for (const p of list) {
    const name = String(p.Name || '').toLowerCase();
    let key = name === 'httpd.exe' ? 'apache' : name === 'mysqld.exe' ? 'mysql' : name === 'electron.exe' ? 'panel' : null;
    if (name === 'node.exe') {
      const cl = String(p.CommandLine || '');
      if (Number(p.ProcessId) === panelPid) key = 'panel';
      else if (/server\.js/i.test(cl)) key = 'node';
      else continue;
    }
    if (!key) continue;
    const cpuSec = ((Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0)) / 1e7;
    const old = procCache.snapshot[p.ProcessId];
    const pct = old !== undefined && elapsed > 0
      ? Math.max(0, Math.min(100, ((cpuSec - old) / elapsed / cores) * 100))
      : 0;
    groups[key].count++;
    groups[key].ram += Number(p.WorkingSetSize) || 0;
    groups[key].cpu += pct;
  }

  const data = {};
  for (const [k, g] of Object.entries(groups)) {
    data[k] = {
      count: g.count,
      ramMB: +(g.ram / 1048576).toFixed(1),
      cpuPct: +g.cpu.toFixed(1),
    };
  }
  procCache = {
    at: now,
    data,
    snapshot: Object.fromEntries(list.map(p => [
      p.ProcessId,
      ((Number(p.UserModeTime) || 0) + (Number(p.KernelModeTime) || 0)) / 1e7,
    ])),
  };
  return data;
}

async function systemStats() {
  const cpus = os.cpus();
  const usage = cpuUsage(cpus);
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const disk = diskInfo();
  return {
    host: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    version: typeof os.version === 'function' ? os.version() : '',
    arch: os.arch(),
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      model: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim(),
      cores: cpus.length,
      speedMHz: cpus[0] ? cpus[0].speed : 0,
      usage,
    },
    memory: {
      totalMB: +(memTotal / 1048576).toFixed(0),
      freeMB: +(memFree / 1048576).toFixed(0),
      usedMB: +((memTotal - memFree) / 1048576).toFixed(0),
      usedPct: Math.round((1 - memFree / memTotal) * 100),
    },
    disk,
    gpu: await getGpuName(),
    processes: await getProcessStats(),
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function readForm(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      const out = {};
      try { new URLSearchParams(body).forEach((v, k) => { out[k] = v; }); } catch {}
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });
}

async function handle(req, res, isLan) {
  try {
    await refreshLaragonSelections();
    const url = new URL(req.url, 'http://127.0.0.1');

    if (isLan) {
      const ip = (req.socket && req.socket.remoteAddress) || 'desconocido';
      const cookies = parseCookies(req.headers.cookie);
      const authed = lanSessionValid(cookies.laragon_sess);
      const isLoginPage = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/login';

      if (!authed && isLoginPage) {
        if (req.method === 'GET') {
          const qkey = url.searchParams.get('key');
          if (!qkey) return serveLogin(res, '');
          if (lanFails(ip) >= LAN_MAX_FAILS) return serveLogin(res, 'Demasiados intentos. Espera unos minutos.');
          if (!safeEqual(qkey, LAN_KEY)) { lanRegisterFail(ip); return serveLogin(res, 'Clave incorrecta'); }
          return sendSession(res, newLanSession());
        }
        if (req.method === 'POST' && url.pathname === '/login') {
          if (lanFails(ip) >= LAN_MAX_FAILS) return serveLogin(res, 'Demasiados intentos. Espera unos minutos.');
          const form = await readForm(req);
          if (!safeEqual(form.key, LAN_KEY)) { lanRegisterFail(ip); return serveLogin(res, 'Clave incorrecta'); }
          LAN_FAILS.delete(ip);
          return sendSession(res, newLanSession());
        }
      }
      if (!authed) return json(res, 401, { error: 'No autorizado' });
      if (url.pathname === '/login') {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
    }
    if (url.pathname.startsWith('/api/winservices') && isLan) {
      return json(res, 403, { error: 'Los servicios de Windows solo se administran desde el equipo local' });
    }
    if (url.pathname === '/api/winservices' && req.method === 'GET') {
      try { return json(res, 200, await winservices.overview()); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/winservices/discover' && req.method === 'GET') {
      try { return json(res, 200, { services: await winservices.discover(url.searchParams.get('q') || '') }); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/winservices/install' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await winservices.install(body);
        return json(res, r.ok ? 200 : 400, r);
      } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/winservices/action' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await winservices.action(String(body.name || ''), String(body.action || ''));
        return json(res, r.ok ? 200 : 400, r);
      } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/winservices/adopt' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, 200, await winservices.adopt(String(body.name || ''))); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/winservices/forget' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, 200, await winservices.forget(String(body.name || ''))); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/winservices/logs' && req.method === 'GET') {
      try { return json(res, 200, await winservices.serviceLogs(url.searchParams.get('name') || '')); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (url.pathname.startsWith('/api/backup') && isLan) {
      return json(res, 403, { error: 'Los respaldos solo se administran desde el equipo local' });
    }
    if (url.pathname === '/api/backup/jobs' && req.method === 'GET') {
      const dbs = (await listDatabases()).map(d => ({ name: d.name, tables: d.tables, mb: d.mb }));
      const prjs = backup.listProjects(dbs.map(d => d.name));
      return json(res, 200, await backup.jobsPayload({ databases: dbs, projects: prjs }));
    }
    if (url.pathname === '/api/backup/job' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const job = backup.saveJob(body);
        const applied = await backup.applyTasks();
        return json(res, 200, {
          ok: true,
          job,
          tasks: applied.tasks,
          taskError: applied.ok ? null : applied.error,
        });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/api/backup/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await backup.deleteJob(String(body.id || ''));
      if (!r.ok) return json(res, 404, r);
      const applied = await backup.applyTasks();
      return json(res, 200, { ok: true, job: r.job, taskError: applied.ok ? null : applied.error });
    }
    if (url.pathname === '/api/backup/run' && req.method === 'POST') {
      const body = await readBody(req);
      const job = backup.getJob(String(body.id || ''));
      if (!job) return json(res, 404, { ok: false, error: 'Tarea no encontrada' });
      if (backup.isRunning()) return json(res, 409, { ok: false, error: 'Ya hay un respaldo en ejecución' });
      backup.spawnRunner(job.id, false);
      return json(res, 200, { ok: true, started: true, job: job.name });
    }
    if (url.pathname === '/api/backup/status') {
      return json(res, 200, await backup.status());
    }
    if (url.pathname === '/api/backup/apply' && req.method === 'POST') {
      const r = await backup.applyTasks();
      return json(res, r.ok ? 200 : 500, r);
    }
    if (url.pathname === '/api/backup/open' && req.method === 'POST') {
      const body = await readBody(req);
      const dir = backup.snapshotForOpen(String(body.id || ''), body.latest !== false);
      if (!dir) return json(res, 404, { ok: false, error: 'Todavía no hay copias de esta tarea' });
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true, path: dir });
    }
    if (url.pathname === '/api/overview') {
      const [services, dbs] = await Promise.all([serviceStatus(), listDatabases()]);
      const stack = laragonStack.stackSnapshot(LARAGON, config.redisPath, {
        apacheFolder: apache && apache.name,
        mysqlFolder: mysql && mysql.name,
        apachePort: APACHE_PORT,
        mysqlPort: MYSQL_PORT,
      });
      stack.warnings.push(...selectionWarnings);
      return json(res, 200, {
        services,
        php: { versions: phpVersions().map(p => ({ short: p.full, full: p.full, branch: p.branch, folder: p.folder, ts: p.ts, modPhp: p.apache, x64: p.x64, compiler: p.compiler, hasSqlsrv: fs.existsSync(path.join(p.base, 'ext', `php_sqlsrv_${p.branch.replace('.', '')}_ts_x64.dll`)) })), active: activePhp(), activeFolder: activePhpFolder() },
        stack,
        projects: readProjects().length,
        databases: dbs.length,
        disk: diskInfo(),
        system: { host: os.hostname(), platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model?.trim(), ramGB: Math.round(os.totalmem() / 1073741824), uptimeH: Math.round(os.uptime() / 3600) },
        timestamp: new Date().toISOString(),
      });
    }
    if (url.pathname === '/api/projects') return json(res, 200, { projects: readProjects() });
    if (url.pathname === '/api/databases') return json(res, 200, { databases: await listDatabases(url.searchParams.get('refresh') === '1') });
    if (url.pathname === '/api/logs') {
      const service = url.searchParams.get('service') || 'apache';
      let text = '';
      let file = null;
      if (service === 'apache') {
        file = apacheErrorLog();
        if (file) text = tailFile(file, 200);
      }
      if (service === 'mysql') {
        file = mysqlErrorLog();
        if (file) text = tailFile(file, 200);
      }
      if (service.startsWith('node:')) {
        const name = service.slice(5).replace(/[^A-Za-z0-9._-]/g, '_');
        file = path.join(LARAGON, 'logs', `node-${name}.log`);
        text = tailFile(file, 200);
      }
      return json(res, 200, { service, text, file: file ? file.replace(/\\/g, '/') : null });
    }
    if (url.pathname === '/api/service' && req.method === 'POST') {
      const body = await readBody(req);
      const name = body.name, action = body.action;
      const result = await withServiceLock(name, async () => {
        if (action === 'start') return startService(name);
        if (action === 'stop') return stopService(name);
        if (action === 'restart') {
          const winSvc = await managedWinService(name);
          if (winSvc) return winservices.action(winSvc, 'restart');
          const stopped = await stopService(name);
          if (!stopped.ok) return stopped;
          await sleep(1500);
          return startService(name);
        }
        return { ok: false, error: 'Acción inválida' };
      });
      return json(res, result.ok ? 200 : 500, { ...result, services: await serviceStatus() });
    }
    if (url.pathname === '/api/php' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await switchPhp(body.branch);
      return json(res, result.ok ? 200 : 400, { ...result, active: activePhp() });
    }
    if (url.pathname === '/api/preview') {
      const port = Number(url.searchParams.get('port'));
      if (!port || port < 1 || port > 65535) return json(res, 400, { error: 'Puerto inválido' });
      // Solo se capturan proyectos activos: si no responde, no hay vista previa.
      if (!(await portOpen(port, 2500))) return json(res, 204, { up: false });
      const file = path.join(PREVIEW_DIR, `${port}.png`);
      const force = url.searchParams.get('force') === '1';
      let st = null;
      try { st = fs.statSync(file); } catch {}
      if (st && !force && Date.now() - st.mtimeMs < PREVIEW_TTL) return sendPreview(res, file);
      enqueuePreview(port);
      return json(res, 202, { pending: true });
    }
    if (url.pathname === '/api/dump' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await dumpDatabase(body.db);
      return json(res, result.ok ? 200 : 500, result);
    }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const port = Number(body.port);
      if (!port || port < 1 || port > 65535) return json(res, 400, { ok: false });
      spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/open-path' && req.method === 'POST') {
      const body = await readBody(req);
      const p = path.resolve(String(body.path || ''));
      const roots = [LARAGON, WWW];
      if (config.legacyDumps) roots.push(config.legacyDumps);
      for (const prj of readProjects()) if (prj.root) roots.push(prj.root);
      const allowed = roots.some(root => {
        const r = path.resolve(root).toLowerCase();
        const f = p.toLowerCase();
        return f === r || f.startsWith(r + path.sep);
      });
      if (!allowed) return json(res, 400, { ok: false, error: 'Ruta no permitida' });
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch {}
      if (isDir) spawn('explorer.exe', [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn('cmd.exe', ['/c', 'start', '', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true, dir: isDir });
    }
    if (url.pathname === '/api/system') return json(res, 200, await systemStats());
    if (url.pathname === '/api/network') {
      const nets = os.networkInterfaces();
      const ips = [];
      for (const [name, addrs] of Object.entries(nets)) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
            ips.push({ name, address: a.address });
          }
        }
      }
      const score = n => /wi-?fi|ethernet/i.test(n) ? 0 : /vEthernet|tailscale|vmware|virtualbox|hyper-v|loopback/i.test(n) ? 2 : 1;
      ips.sort((a, b) => score(a.name) - score(b.name));
      const primary = ips[0]?.address || '127.0.0.1';
      return json(res, 200, {
        ips,
        primary,
        localUrl: `http://127.0.0.1:${PANEL_PORT}`,
        lanUrl: `http://${primary}:${PANEL_LAN_PORT}/?key=${LAN_KEY}`,
        lanPort: PANEL_LAN_PORT,
        key: LAN_KEY,
        projects: readProjects().map(p => ({ name: p.name, port: p.port })),
      });
    }
    if (url.pathname === '/api/firewall' && req.method === 'POST') {
      if (isLan) return json(res, 403, { error: 'Solo se puede configurar desde el equipo local' });
      const script = [
        'netsh advfirewall firewall delete rule name="Laragon Panel LAN" >nul 2>&1',
        'netsh advfirewall firewall delete rule name="Laragon Projects LAN" >nul 2>&1',
        'netsh advfirewall firewall delete rule name="Laragon Apache LAN" >nul 2>&1',
        `netsh advfirewall firewall add rule name="Laragon Panel LAN" dir=in action=allow protocol=TCP localport=${PANEL_LAN_PORT} profile=any`,
        'netsh advfirewall firewall add rule name="Laragon Projects LAN" dir=in action=allow protocol=TCP localport=8001-8100 profile=any',
        `netsh advfirewall firewall add rule name="Laragon Apache LAN" dir=in action=allow protocol=TCP localport=${APACHE_PORT} profile=any`,
      ].join('\r\n');
      const ps1 = path.join(config.dataDir, 'firewall.ps1');
      fs.writeFileSync(ps1, script, 'utf8');
      const cmd = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${ps1}'`;
      spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true, message: 'Acepta el aviso de UAC para abrir los puertos' });
    }
    if (url.pathname === '/api/services') {
      const status = await serviceStatus();
      return json(res, 200, { ...status, nodes: await nodeServices() });
    }
    if (url.pathname === '/api/node' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await nodeAction(String(body.name || ''), String(body.action || ''));
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/open-dir' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = String(body.kind || '');
      const map = {
        dumps: path.join(LARAGON, 'backups', 'db'),
        logs: path.join(LARAGON, 'logs'),
        www: WWW,
        ports: path.join(LARAGON, 'puertos.csv'),
        vhosts: apache ? path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf') : '',
      };
      const target = map[kind];
      if (!target) return json(res, 400, { error: 'Tipo inválido' });
      if (!fs.existsSync(target) && kind === 'dumps') {
        try { fs.mkdirSync(target, { recursive: true }); } catch {}
      }
      if (!fs.existsSync(target)) return json(res, 404, { error: 'No existe todavía', path: target.replace(/\\/g, '/') });
      let isDir = false;
      try { isDir = fs.statSync(target).isDirectory(); } catch {}
      if (isDir) spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true, path: target.replace(/\\/g, '/'), dir: isDir });
    }
    if (url.pathname === '/api/projects/status') return json(res, 200, { statuses: await projectStatuses() });
    if (url.pathname === '/api/project-logs') {
      const port = Number(url.searchParams.get('port'));
      const project = readProjects().find(p => p.port === port);
      if (!project) return json(res, 404, { error: 'Proyecto no encontrado' });
      return json(res, 200, { project: project.name, files: projectLogFiles(project) });
    }
    if (url.pathname === '/api/project-log') {
      const port = Number(url.searchParams.get('port'));
      const project = readProjects().find(p => p.port === port);
      if (!project) return json(res, 404, { error: 'Proyecto no encontrado' });
      const files = projectLogFiles(project);
      if (!files.length) return json(res, 200, { file: null, text: '', lines: 0, files: [] });
      const id = url.searchParams.get('file') || files[0].id;
      const chosen = files.find(f => f.id === id);
      if (!chosen) return json(res, 404, { error: 'Archivo de log no encontrado' });
      const since = Number(url.searchParams.get('since')) || 0;
      const until = Number(url.searchParams.get('until')) || 0;
      const maxLines = Math.min(Number(url.searchParams.get('lines')) || 800, 5000);
      const r = readLogFiltered(chosen.path, since, until, maxLines);
      return json(res, 200, {
        file: chosen.path,
        label: chosen.label,
        size: chosen.size,
        mtime: chosen.mtime,
        files,
        text: r.text,
        lines: r.lines,
        entries: r.entries,
        truncated: r.truncated,
        cut: r.cut,
      });
    }
    if (url.pathname === '/api/project-log/clear' && req.method === 'POST') {
      const body = await readBody(req);
      const port = Number(body.port);
      const project = readProjects().find(p => p.port === port);
      if (!project) return json(res, 404, { error: 'Proyecto no encontrado' });
      const chosen = projectLogFiles(project).find(f => f.id === String(body.file || ''));
      if (!chosen) return json(res, 404, { error: 'Archivo de log no encontrado' });
      try {
        const freed = chosen.size;
        if (freed > 0) {
          fs.copyFileSync(chosen.path, `${chosen.path}.old`);
          fs.truncateSync(chosen.path, 0);
        }
        return json(res, 200, { ok: true, file: chosen.path, freed });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }
    if (url.pathname === '/api/extensions') {
      if (req.method === 'GET') return json(res, 200, { extensions: getExtensions() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const result = await toggleExtension(body.name, !!body.enabled);
        return json(res, result.ok ? 200 : 400, result);
      }
    }
    if (url.pathname === '/api/site' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await createSite(body);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/backups') return json(res, 200, { backups: listBackups() });
    if (url.pathname === '/api/db' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await dbAction(body.action, String(body.name || ''));
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await importDump(String(body.file || ''));
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/backup-all' && req.method === 'POST') {
      const result = await backupAll();
      return json(res, result.ok ? 200 : 500, result);
    }
    if (url.pathname === '/api/open-tool' && req.method === 'POST') {
      const body = await readBody(req);
      const result = openTool(String(body.path || ''), String(body.tool || ''));
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveStatic(req, res);
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
}

const localServer = http.createServer((req, res) => handle(req, res, false));
const lanServer = http.createServer((req, res) => handle(req, res, true));

localServer.on('error', e => {
  console.error(`No se pudo abrir el panel local en 127.0.0.1:${PANEL_PORT}: ${e.message}`);
  process.exitCode = 1;
  process.exit(1);
});
localServer.listen(PANEL_PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(PANEL_PID_FILE, String(process.pid), 'utf8'); } catch {}
  console.log(`Laragon Panel local en http://127.0.0.1:${PANEL_PORT}`);
  ensureSqliteDriver();
  setTimeout(() => { startNodeApps().catch(e => console.error(`[node] ${e.message}`)); }, 1500);
});

lanServer.on('error', e => console.error(`LAN listener: ${e.message}`));
lanServer.listen(PANEL_LAN_PORT, '0.0.0.0', () => {
  console.log(`Laragon Panel LAN en http://0.0.0.0:${PANEL_LAN_PORT} (clave ${LAN_KEY})`);
});

backup.startScheduler(msg => console.log(`[respaldos] ${msg}`));

function cleanupPid() {
  try {
    if (Number(fs.readFileSync(PANEL_PID_FILE, 'utf8')) === process.pid) fs.unlinkSync(PANEL_PID_FILE);
  } catch {}
}
process.once('exit', cleanupPid);
process.once('SIGINT', () => { cleanupPid(); process.exit(0); });
process.once('SIGTERM', () => { cleanupPid(); process.exit(0); });


