'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, execFile } = require('child_process');
const backup = require('./backup');
const config = require('./config');

const LARAGON = config.laragonRoot;
const MYSQL_PORT = config.mysqlPort;
const PANEL_PORT = config.panelPort;
const PANEL_LAN_PORT = config.lanPort;
const LEGACY_DUMPS = config.legacyDumps ? path.join(config.legacyDumps, 'dumps') : null;
const LAN_KEY_FILE = path.join(__dirname, 'lan-key.txt');
const PANEL_PID_FILE = path.join(__dirname, 'panel.pid');

function getLanKey() {
  try {
    const k = fs.readFileSync(LAN_KEY_FILE, 'utf8').trim();
    if (k) return k;
  } catch {}
  const k = crypto.randomBytes(5).toString('hex');
  try { fs.writeFileSync(LAN_KEY_FILE, k, 'utf8'); } catch {}
  return k;
}

const LAN_KEY = getLanKey();

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
const WWW = path.join(LARAGON, 'www');
const PUBLIC = path.join(__dirname, 'public');

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return []; }
}

function pickApache() {
  const dirs = listDirs(path.join(LARAGON, 'bin', 'apache')).filter(d => d.startsWith('httpd-')).sort();
  const name = dirs[dirs.length - 1];
  if (!name) return null;
  const base = path.join(LARAGON, 'bin', 'apache', name);
  return { name, base, exe: path.join(base, 'bin', 'httpd.exe'), conf: path.join(base, 'conf', 'httpd.conf'), logs: path.join(base, 'logs') };
}

function pickMysql() {
  const dirs = listDirs(path.join(LARAGON, 'bin', 'mysql')).filter(d => d.startsWith('mysql-')).sort();
  const name = dirs[dirs.length - 1];
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

const apache = pickApache();
const mysql = pickMysql();

try { fs.mkdirSync(path.join(LARAGON, 'backups', 'db'), { recursive: true }); } catch {}

function phpVersions() {
  const dirs = listDirs(path.join(LARAGON, 'bin', 'php')).filter(d => /^php-\d/.test(d));
  return dirs.map(name => {
    const m = name.match(/^php-(\d+\.\d+)\.(\d+)/);
    const base = path.join(LARAGON, 'bin', 'php', name);
    return {
      folder: name,
      short: m ? `${m[1]}.${m[2]}` : name,
      branch: m ? m[1] : name,
      exe: path.join(base, 'php.exe'),
      ini: path.join(base, 'php.ini'),
      base,
    };
  }).sort((a, b) => a.short.localeCompare(b.short, undefined, { numeric: true }));
}

function activePhp() {
  try {
    const conf = fs.readFileSync(path.join(LARAGON, 'etc', 'apache2', 'mod_php.conf'), 'utf8');
    const m = conf.match(/php-(\d+\.\d+)\.(\d+)[^/\\"]*/);
    return m ? `${m[1]}.${m[2]}` : null;
  } catch { return null; }
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
  const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function waitPort(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen(port, 400)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function serviceStatus() {
  const [apacheUp, mysqlUp] = await Promise.all([portOpen(80), portOpen(MYSQL_PORT)]);
  return {
    apache: { up: apacheUp, port: 80, version: apache ? apache.name.replace(/^httpd-/, '') : null },
    mysql: { up: mysqlUp, port: MYSQL_PORT, version: mysql ? mysql.name.replace(/^mysql-/, '') : null },
  };
}

async function mysqldRunning() {
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq mysqld.exe', '/NH']);
  return /mysqld\.exe/i.test(r.stdout || '');
}

async function startService(name) {
  if (name === 'apache') {
    if (!apache) return { ok: false, error: 'Apache no encontrado' };
    if (await portOpen(80)) return { ok: true, already: true };
    startDetached(apache.exe, [], path.join(apache.base, 'bin'));
    const up = await waitPort(80);
    return { ok: up, error: up ? null : 'Apache no arranc?? (revisa logs)' };
  }
  if (name === 'mysql') {
    if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
    if (await portOpen(MYSQL_PORT)) return { ok: true, already: true };

    if (await mysqldRunning()) {
      // Puede ser un arranque en curso: darle unos segundos antes de forzar.
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        if (await portOpen(MYSQL_PORT, 300)) return { ok: true, already: true };
      }
      await run('taskkill', ['/F', '/IM', 'mysqld.exe']);
      await sleep(1500);
    }

    const launch = () => startDetached(mysql.exe, [`--defaults-file=${mysql.ini}`], path.join(mysql.base, 'bin'));
    launch();
    let up = await waitPort(MYSQL_PORT, 30000);
    if (!up) {
      await sleep(2000);
      launch();
      up = await waitPort(MYSQL_PORT, 30000);
    }
    return { ok: up, error: up ? null : 'MySQL no arranc?? (revisa logs)' };
  }
  return { ok: false, error: 'Servicio desconocido' };
}

async function stopService(name) {
  if (name === 'apache') {
    await run('taskkill', ['/F', '/IM', 'httpd.exe']);
    for (let i = 0; i < 20 && await portOpen(80, 300); i++) await new Promise(r => setTimeout(r, 300));
    return { ok: !(await portOpen(80)) };
  }
  if (name === 'mysql') {
    if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
    await run(mysql.admin, ['-u', 'root', `--port=${MYSQL_PORT}`, '--protocol=TCP', 'shutdown']);

    // Esperar a que terminen TODOS los procesos mysqld (padre e hijo)
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const running = await mysqldRunning();
      const open = await portOpen(MYSQL_PORT, 300);
      if (!running && !open) break;
      await sleep(500);
    }

    if (await mysqldRunning()) {
      await run('taskkill', ['/F', '/IM', 'mysqld.exe']);
      await sleep(1500);
    }
    await sleep(1000);
    return { ok: !(await mysqldRunning()) && !(await portOpen(MYSQL_PORT)) };
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
  if (!projects.length) {
    const dirs = listDirs(WWW).filter(d => !['Respaldos', 'moodledata', 'node_modules'].includes(d)).sort();
    let p = 8001;
    for (const d of dirs) {
      const root = path.join(WWW, d).replace(/\\/g, '/');
      projects.push({ port: p++, name: d, root, url: `http://127.0.0.1:${p - 1}`, public: false, type: detectProjectType(root) });
    }
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
  let text = fs.readFileSync(iniPath, 'utf8');
  const secRe = new RegExp(`\\[${section}\\]`, 'i');
  if (!secRe.test(text)) { text += `\n[${section}]\n${key}=${value}\n`; }
  else {
    const start = text.search(secRe);
    const rest = text.slice(start + text.match(secRe)[0].length);
    const next = rest.search(/\n\[/);
    const end = next === -1 ? text.length : start + text.match(secRe)[0].length + next;
    let block = text.slice(start, end);
    const keyRe = new RegExp(`^\\s*${key}\\s*=.*$`, 'im');
    if (keyRe.test(block)) block = block.replace(keyRe, `${key}=${value}`);
    else block = block.replace(/\s*$/, `\n${key}=${value}\n`);
    text = text.slice(0, start) + block + text.slice(end);
  }
  fs.writeFileSync(iniPath, text, 'utf8');
}

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const VSCODE = config.codePath || path.join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd');
const WT = config.wtPath || path.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
const COMPOSER = path.join(LARAGON, 'bin', 'composer', 'composer.phar');

function activePhpObj() {
  const a = activePhp();
  return phpVersions().find(p => p.short === a) || null;
}

const EXTENSIONS = ['curl','fileinfo','gd','intl','mbstring','exif','mysqli','openssl','pdo_mysql','pdo_sqlite','soap','sodium','sqlite3','xsl','zip','sqlsrv','pdo_sqlsrv','opcache'];

function extRegex(name) {
  return name === 'opcache'
    ? /^\s*(;)?\s*zend_extension\s*=\s*"?opcache"?/i
    : new RegExp(`^\\s*(;)?\\s*extension\\s*=\\s*"?[^"\\r\\n]*${name}[^"\\r\\n]*"?`, 'i');
}

function getExtensions() {
  const p = activePhpObj();
  if (!p || !fs.existsSync(p.ini)) return [];
  const lines = fs.readFileSync(p.ini, 'utf8').split(/\r?\n/);
  return EXTENSIONS.map(name => {
    const re = extRegex(name);
    const indices = lines.map((l, i) => re.test(l) ? i : -1).filter(i => i >= 0);
    const enabledIdx = indices.find(i => !/^\s*;/.test(lines[i]));
    const idx = enabledIdx !== undefined ? enabledIdx : (indices[0] ?? -1);
    return { name, enabled: enabledIdx !== undefined, line: idx >= 0 ? lines[idx].trim() : null };
  });
}

async function toggleExtension(name, enabled) {
  const p = activePhpObj();
  if (!p || !fs.existsSync(p.ini)) return { ok: false, error: 'PHP activo no encontrado' };
  if (!EXTENSIONS.includes(name)) return { ok: false, error: 'Extensi??n no permitida' };
  const lines = fs.readFileSync(p.ini, 'utf8').split(/\r?\n/);
  const re = extRegex(name);
  const indices = lines.map((l, i) => re.test(l) ? i : -1).filter(i => i >= 0);
  let idx = indices.find(i => !/^\s*;/.test(lines[i]));
  if (idx === undefined) idx = indices[0] ?? -1;
  if (idx === -1) {
    lines.push(name === 'opcache' ? 'zend_extension=opcache' : `extension=${name}`);
  } else {
    let line = lines[idx];
    if (enabled) line = line.replace(/^\s*;\s*/, '');
    else if (!/^\s*;/.test(line)) line = ';' + line;
    lines[idx] = line;
  }
  fs.writeFileSync(p.ini, lines.join('\r\n'), 'utf8');
  if (await portOpen(80)) { await stopService('apache'); await startService('apache'); }
  return { ok: true, extensions: getExtensions() };
}

function nextPort() {
  const ports = readProjects().map(p => p.port).filter(n => Number.isFinite(n));
  return Math.max(8058, ...ports) + 1;
}

function addVhost(name, root, port) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const r = root.replace(/\\/g, '/');
  const block = `\nListen ${port}\n\n<VirtualHost *:${port}>\n    DocumentRoot "${r}"\n    ServerName 127.0.0.1\n    DirectoryIndex index.php index.html\n    <Directory "${r}">\n        Options Indexes FollowSymLinks\n        AllowOverride All\n        Require all granted\n    </Directory>\n    ErrorLog "logs/${safe}-error.log"\n    CustomLog "logs/${safe}-access.log" common\n</VirtualHost>\n`;
  fs.appendFileSync(path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf'), block, 'utf8');
}

function htmlPage(name) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;color:#e8eefb;font-family:system-ui,sans-serif}main{text-align:center;padding:40px}h1{font-size:32px;margin:0 0 8px}p{color:#8ea0ba}</style></head><body><main><h1>${name}</h1><p>Proyecto creado desde Laragon Panel.</p></main></body></html>`;
}

function ensureProxyModules() {
  const conf = path.join(apache.base, 'conf', 'httpd.conf');
  let c = fs.readFileSync(conf, 'utf8');
  c = c.replace(/^#\s*LoadModule proxy_module .*$/m, 'LoadModule proxy_module modules/mod_proxy.so');
  c = c.replace(/^#\s*LoadModule proxy_http_module .*$/m, 'LoadModule proxy_http_module modules/mod_proxy_http.so');
  fs.writeFileSync(conf, c, 'utf8');
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
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  try { fs.closeSync(fd); } catch {}
  child.unref();
  return child.pid;
}

async function startNodeApps() {
  for (const p of readProjects()) {
    if (p.type !== 'node') continue;
    const marker = path.join(p.root, '.panel-node-port');
    if (!fs.existsSync(marker)) continue;
    const port = Number(fs.readFileSync(marker, 'utf8').trim());
    if (!port) continue;
    if (!(await portOpen(port, 500))) startNodeApp(p.root, port);
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

async function stopNodeByPort(port) {
  const cmd = `$p=(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if($p){ Stop-Process -Id $p -Force }`;
  await run('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 15000 });
  for (let i = 0; i < 20 && await portOpen(port, 300); i++) await new Promise(r => setTimeout(r, 300));
  return !(await portOpen(port));
}

async function nodeAction(name, action) {
  const p = readProjects().find(x => x.name === name && x.type === 'node');
  if (!p) return { ok: false, error: 'Aplicación Node no encontrada' };
  const marker = path.join(p.root, '.panel-node-port');
  if (!fs.existsSync(marker)) return { ok: false, error: 'Falta .panel-node-port' };
  const internal = Number(fs.readFileSync(marker, 'utf8').trim());
  if (!internal) return { ok: false, error: 'Puerto interno inválido' };
  if (action === 'stop' || action === 'restart') await stopNodeByPort(internal);
  if (action === 'start' || action === 'restart') {
    if (!(await portOpen(internal, 300))) {
      startNodeApp(p.root, internal);
      for (let i = 0; i < 30 && !(await portOpen(internal, 300)); i++) await new Promise(r => setTimeout(r, 300));
    }
  }
  return { ok: true, running: await portOpen(internal, 300) };
}

function addProxyVhost(name, port, internalPort) {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const block = `\nListen ${port}\n\n<VirtualHost *:${port}>\n    ProxyPreserveHost On\n    ProxyPass "/" "http://127.0.0.1:${internalPort}/"\n    ProxyPassReverse "/" "http://127.0.0.1:${internalPort}/"\n    ServerName 127.0.0.1\n    ErrorLog "logs/${safe}-error.log"\n    CustomLog "logs/${safe}-access.log" common\n</VirtualHost>\n`;
  fs.appendFileSync(path.join(apache.base, 'conf', 'extra', 'httpd-vhosts.conf'), block, 'utf8');
}

async function createSite(body) {
  let name = String(body.name || '').trim();
  const type = body.type || 'php';
  const existing = String(body.path || '').trim();
  if (type === 'link') {
    if (!existing || !fs.existsSync(existing) || !fs.statSync(existing).isDirectory()) return { ok: false, error: 'Carpeta no v??lida' };
    name = path.basename(existing);
  }
  if (!/^[A-Za-z0-9._ -]{1,60}$/.test(name)) return { ok: false, error: 'Nombre inv??lido' };

  let root = type === 'link' ? existing : path.join(WWW, name);
  let nodeInternal = null;

  if (type !== 'link') {
    if (fs.existsSync(root)) return { ok: false, error: 'Ya existe esa carpeta' };
    fs.mkdirSync(root, { recursive: true });

    if (type === 'laravel') {
      const p = activePhpObj();
      const r = await run(p.exe, [COMPOSER, 'create-project', 'laravel/laravel', root, '--prefer-dist', '--no-interaction'], { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
      if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'Composer fall??').slice(0, 2000) };
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
      ensureProxyModules();
      startNodeApp(root, nodeInternal);
    } else if (type === 'html') {
      fs.writeFileSync(path.join(root, 'index.html'), htmlPage(name), 'utf8');
    } else {
      fs.writeFileSync(path.join(root, 'index.php'), `<?php echo <<<'HTML'\n${htmlPage(name)}\nHTML;\n`, 'utf8');
    }
  }

  const docs = path.join(root, 'public');
  const docRoot = fs.existsSync(path.join(docs, 'index.php')) ? docs : root;
  const port = nextPort();

  const linkedNode = type === 'link' && detectProjectType(root) === 'node' && fs.existsSync(path.join(root, '.panel-node-port'));
  if (type === 'node' || linkedNode) {
    if (!nodeInternal) nodeInternal = Number(fs.readFileSync(path.join(root, '.panel-node-port'), 'utf8').trim());
    ensureProxyModules();
    addProxyVhost(name, port, nodeInternal);
  } else {
    addVhost(name, docRoot, port);
  }

  fs.appendFileSync(path.join(LARAGON, 'puertos.csv'), `"${port}","${name}","${docRoot.replace(/\\/g, '/')}"\r\n`, 'utf8');
  if (await portOpen(80)) {
    await stopService('apache');
    const r = await startService('apache');
    if (!r.ok) return { ok: false, error: `Sitio creado, pero Apache no reinici??: ${r.error || ''}` };
  }
  return { ok: true, project: { name, port, root: docRoot.replace(/\\/g, '/'), url: `http://127.0.0.1:${port}`, type: type === 'link' ? detectProjectType(docRoot) : type } };
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
  const full = path.resolve(file);
  if (!allowed.some(r => full.startsWith(r))) return { ok: false, error: 'Archivo no permitido' };
  if (!fs.existsSync(full)) return { ok: false, error: 'Archivo no encontrado' };
  const cmd = `"${mysql.client}" -u root --port=${MYSQL_PORT} --protocol=TCP --default-character-set=utf8mb4 < "${full}"`;
  const r = await run('cmd.exe', ['/c', cmd], { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || 'Error al importar').slice(0, 2000) };
}

async function dbAction(action, name) {
  if (!/^[A-Za-z0-9_$.-]{1,64}$/.test(name)) return { ok: false, error: 'Nombre inv??lido' };
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
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, res => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
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
  } else return { ok: false, error: 'Herramienta inv??lida' };
  return { ok: true };
}

async function switchPhp(branch) {
  const list = phpVersions();
  const target = list.find(p => p.branch === branch);
  if (!target) return { ok: false, error: 'Versi??n no instalada' };
  const dll = path.join(target.base, 'php8apache2_4.dll');
  if (!fs.existsSync(dll)) return { ok: false, error: 'php8apache2_4.dll no encontrado' };
  const conf = `# PHP ${target.short} (panel)\nLoadModule php_module "${dll.replace(/\\/g, '/')}"\nPHPIniDir "${target.base.replace(/\\/g, '/')}"\n<IfModule mime_module>\n    AddType application/x-httpd-php .php\n</IfModule>\n`;
  fs.writeFileSync(path.join(LARAGON, 'etc', 'apache2', 'mod_php.conf'), conf, 'utf8');
  try { setIniValue(path.join(LARAGON, 'usr', 'laragon.ini'), 'php', 'Version', target.folder); } catch {}
  const wasUp = await portOpen(80);
  if (wasUp) { await stopService('apache'); await startService('apache'); }
  return { ok: true, active: target.short };
}

async function dumpDatabase(db) {
  if (!mysql) return { ok: false, error: 'MySQL no encontrado' };
  if (!/^[A-Za-z0-9_$.-]+$/.test(db)) return { ok: false, error: 'Nombre inv??lido' };
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

function serveLogin(res, error = '') {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laragon Panel ?? Acceso</title>
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
  <p>Acceso desde la red local. Introduce la clave que aparece en el panel local, secci??n <strong>Compartir</strong>.</p>
  <form method="get" action="/">
    <input name="key" placeholder="Clave de acceso" autofocus autocomplete="off">
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
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
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

async function handle(req, res, isLan) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (isLan) {
      const qkey = url.searchParams.get('key');
      if (qkey && qkey === LAN_KEY) {
        res.writeHead(302, {
          'Set-Cookie': `laragon_lan=${LAN_KEY}; HttpOnly; SameSite=Lax; Path=/`,
          Location: '/',
        });
        return res.end();
      }
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.laragon_lan !== LAN_KEY) {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          return serveLogin(res, qkey ? 'Clave incorrecta' : '');
        }
        return json(res, 401, { error: 'No autorizado' });
      }
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
      return json(res, 200, {
        services,
        php: { versions: phpVersions().map(p => ({ short: p.short, branch: p.branch, folder: p.folder, hasSqlsrv: fs.existsSync(path.join(p.base, 'ext', `php_sqlsrv_${p.branch.replace('.', '')}_ts_x64.dll`)) })), active: activePhp() },
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
      if (service === 'apache' && apache) text = tailFile(path.join(apache.logs, 'error.log'), 120);
      if (service === 'mysql') {
        const dir = path.join(LARAGON, 'data', 'mysql-8');
        const f = latestFile(dir, f => f.endsWith('.err'));
        if (f) text = tailFile(path.join(dir, f), 120);
      }
      if (service.startsWith('node:')) {
        const name = service.slice(5).replace(/[^A-Za-z0-9._-]/g, '_');
        text = tailFile(path.join(LARAGON, 'logs', `node-${name}.log`), 200);
      }
      return json(res, 200, { service, text });
    }
    if (url.pathname === '/api/service' && req.method === 'POST') {
      const body = await readBody(req);
      const name = body.name, action = body.action;
      let result;
      if (action === 'start') result = await startService(name);
      else if (action === 'stop') result = await stopService(name);
      else if (action === 'restart') {
        await stopService(name);
        await sleep(1500);
        result = await startService(name);
      }
      else result = { ok: false, error: 'Acci??n inv??lida' };
      return json(res, result.ok ? 200 : 500, { ...result, services: await serviceStatus() });
    }
    if (url.pathname === '/api/php' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await switchPhp(body.branch);
      return json(res, result.ok ? 200 : 400, { ...result, active: activePhp() });
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
      const roots = [LARAGON];
      if (config.legacyDumps) roots.push(config.legacyDumps);
      const allowed = roots.some(root => {
        const r = path.resolve(root).toLowerCase();
        const f = p.toLowerCase();
        return f === r || f.startsWith(r + path.sep);
      });
      if (!allowed) return json(res, 400, { ok: false, error: 'Ruta no permitida' });
      spawn('cmd.exe', ['/c', 'start', '', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true });
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
        'netsh advfirewall firewall add rule name="Laragon Apache LAN" dir=in action=allow protocol=TCP localport=80 profile=any',
      ].join('\r\n');
      const ps1 = path.join(__dirname, 'firewall.ps1');
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
    if (url.pathname === '/api/projects/status') return json(res, 200, { statuses: await projectStatuses() });
    if (url.pathname === '/api/project-log') {
      const port = Number(url.searchParams.get('port'));
      const project = readProjects().find(p => p.port === port);
      if (!project) return json(res, 404, { error: 'Proyecto no encontrado' });
      const safe = project.name.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = path.join(apache.logs, `${safe}-error.log`);
      return json(res, 200, { file: file.replace(/\\/g, '/'), text: tailFile(file, 120) });
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

localServer.listen(PANEL_PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(PANEL_PID_FILE, String(process.pid), 'utf8'); } catch {}
  console.log(`Laragon Panel local en http://127.0.0.1:${PANEL_PORT}`);
});

lanServer.on('error', e => console.error(`LAN listener: ${e.message}`));
lanServer.listen(PANEL_LAN_PORT, '0.0.0.0', () => {
  console.log(`Laragon Panel LAN en http://0.0.0.0:${PANEL_LAN_PORT} (clave ${LAN_KEY})`);
});

ensureSqliteDriver();
setTimeout(() => { startNodeApps().catch(() => {}); }, 1500);
backup.startScheduler(msg => console.log(`[respaldos] ${msg}`));


