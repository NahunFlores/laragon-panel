'use strict';

/*
 * Motor de respaldos de Laragon Panel.
 *
 * - Copia bases de datos MySQL (un .sql por base) y carpetas de proyectos.
 * - Guarda un manifiesto y un log por copia.
 * - Aplica retención (número de copias a conservar).
 * - Se puede ejecutar desde el panel o desde el Programador de tareas
 *   de Windows mediante backup-runner.js (sin necesidad del panel abierto).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { laragonRoot, dataDir, getMysqlPort, getWwwRoot } = require('./config');
const laragonStack = require('./laragon-stack');

const LARAGON = laragonRoot;
const mysqlPortNow = () => Number(process.env.PANEL_ACTIVE_MYSQL_PORT) || getMysqlPort();
const wwwRootNow = () => process.env.PANEL_ACTIVE_WWW_ROOT || getWwwRoot();
const PANEL_DIR = __dirname;
const DATA_DIR = dataDir;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const CONFIG_FILE = path.join(DATA_DIR, 'backups.json');
const STATE_FILE = path.join(BACKUP_DIR, 'state.json');
const LOCK_FILE = path.join(BACKUP_DIR, 'backup.lock');
const TASKS_DATA = path.join(BACKUP_DIR, 'tasks.json');
const TASKS_SCRIPT = path.join(DATA_DIR, 'apply-backup-tasks.ps1');
const TASK_PREFIX = 'LaragonPanel_Backup_';
const HISTORY_LIMIT = 100;
const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$/;
const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let activeLockToken = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureDirs() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function isInside(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

function atomicJson(file, obj) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      jobs: Array.isArray(cfg.jobs) ? cfg.jobs : [],
      history: Array.isArray(cfg.history) ? cfg.history : [],
    };
  } catch {
    return { jobs: [], history: [] };
  }
}

function writeConfig(cfg) {
  atomicJson(CONFIG_FILE, {
    jobs: cfg.jobs || [],
    history: (cfg.history || []).slice(0, HISTORY_LIMIT),
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try { atomicJson(STATE_FILE, { ...state, updatedAt: new Date().toISOString() }); } catch {}
  if (activeLockToken) {
    const lock = readLock();
    if (lock && lock.token === activeLockToken && lock.pid === process.pid) {
      try { atomicJson(LOCK_FILE, { ...lock, at: Date.now() }); } catch {}
    }
  }
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(jobId) {
  ensureDirs();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomBytes(16).toString('hex');
    let fd;
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, jobId, at: Date.now(), token }), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      activeLockToken = token;
      return true;
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (error.code !== 'EEXIST') {
        if (fd !== undefined) try { fs.unlinkSync(LOCK_FILE); } catch {}
        return false;
      }
      const current = readLock();
      if (current && pidAlive(current.pid) && Date.now() - (current.at || 0) < 12 * 3600 * 1000) return false;
      // An empty lock may be in the tiny window between exclusive creation and its write.
      if (!current) {
        try { if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs < 30000) return false; } catch { return false; }
      }
      try { fs.unlinkSync(LOCK_FILE); } catch { return false; }
    }
  }
  return false;
}

function releaseLock() {
  const current = readLock();
  if (current && current.pid === process.pid && current.token === activeLockToken) {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
  activeLockToken = '';
}

function isRunning() {
  const st = readState();
  const lock = readLock();
  if (lock && pidAlive(lock.pid) && Date.now() - (lock.at || 0) < 12 * 3600 * 1000) return true;
  if (st.running) {
    writeState({ ...st, running: false, stale: true });
  }
  return false;
}

function run(exe, args, opts = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(exe, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: opts.env || process.env,
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message });
    }
    const timer = opts.timeout ? setTimeout(() => {
      try { child.kill(); } catch {}
    }, opts.timeout) : null;
    child.stdout.on('data', d => {
      if (stdout.length < 4 * 1024 * 1024) stdout += d.toString();
    });
    child.stderr.on('data', d => {
      if (stderr.length < 4 * 1024 * 1024) stderr += d.toString();
    });
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + e.message });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function portOpen(port, timeout = 500) {
  return new Promise(resolve => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch {}
      resolve(ok);
    };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, '127.0.0.1');
  });
}

function slug(text) {
  return String(text || 'respaldo')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'respaldo';
}

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function uniqueSnapshotDir(root) {
  const base = stamp();
  let name = base;
  let i = 2;
  while (fs.existsSync(path.join(root, name))) {
    name = `${base}-${i++}`;
  }
  return name;
}

function mysqlInfo() {
  const baseDir = path.join(LARAGON, 'bin', 'mysql');
  const name = laragonStack.mysqlFolder(LARAGON, process.env.PANEL_ACTIVE_MYSQL_VERSION || '');
  if (!name) return null;
  const base = path.join(baseDir, name);
  return {
    name,
    base,
    exe: path.join(base, 'bin', 'mysqld.exe'),
    client: path.join(base, 'bin', 'mysql.exe'),
    dump: path.join(base, 'bin', 'mysqldump.exe'),
    ini: path.join(base, 'my.ini'),
  };
}

async function listDatabaseNames() {
  const mysql = mysqlInfo();
  if (!mysql) return [];
  const r = await run(mysql.client, ['-u', 'root', `--port=${mysqlPortNow()}`, '--protocol=TCP', '-N', '-B', '-e', 'SHOW DATABASES;']);
  if (r.code !== 0) throw new Error((r.stderr || 'No se pudo consultar MySQL').trim().slice(0, 500));
  return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(d => !SYSTEM_DBS.has(d));
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
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

function projectBase(root) {
  const p = path.resolve(root);
  if (path.basename(p).toLowerCase() === 'public' && fs.existsSync(path.join(p, '..', 'artisan'))) {
    return path.dirname(p);
  }
  return p;
}

function normName(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function readEnvFile(file) {
  const map = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      value = value.replace(/\s+#.*$/, '').trim();
      map[m[1]] = value;
    }
  } catch {}
  return map;
}

// Intenta saber qué base de datos usa cada proyecto (.env, wp-config, CI, etc.).
function detectProjectDatabases(root, knownDbs = null) {
  const found = [];
  const seen = new Set();
  const known = new Map((knownDbs || []).map(d => [String(d).toLowerCase(), d]));

  const add = raw => {
    let value = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value || /^[<${]/.test(value)) return;
    if (/^(localhost|127\.0\.0\.1|mysql|sqlite|pgsql|forge)$/i.test(value)) return;
    if (known.size) {
      const actual = known.get(value.toLowerCase());
      if (!actual) return;
      value = actual;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(value);
  };

  const env = readEnvFile(path.join(root, '.env'));
  if (env.DB_DATABASE) add(env.DB_DATABASE);

  const candidates = [
    'wp-config.php',
    'config.php',
    'database.php',
    'config/database.php',
    'application/config/database.php',
    'includes/config.php',
    'config/db.php',
    'db.php',
  ];
  const patterns = [
    /define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]/gi,
    /define\s*\(\s*['"]DB_DATABASE['"]\s*,\s*['"]([^'"]+)['"]/gi,
    /\$db(?:name|_name|database|_database)\s*=\s*['"]([^'"]+)['"]/gi,
    /['"]database['"]\s*=>\s*['"]([^'"]+)['"]/gi,
  ];

  for (const rel of candidates) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 512 * 1024); } catch { continue; }
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text))) add(m[1]);
    }
  }

  // Si no hay configuración legible, comparar el nombre del proyecto con las bases.
  if (!found.length && knownDbs && knownDbs.length) {
    const pn = normName(path.basename(root));
    if (pn.length >= 4) {
      for (const db of knownDbs) {
        const dn = normName(db);
        if (!dn) continue;
        if (dn === pn) { add(db); continue; }
        if (dn.length >= 6 && pn.length >= 6 && (dn.startsWith(pn) || pn.startsWith(dn))) add(db);
      }
    }
  }

  return found;
}

// Devuelve los proyectos servidos (nombre, puerto, carpeta real y bases detectadas).
function listProjects(knownDbs = null) {
  const csv = path.join(LARAGON, 'puertos.csv');
  const out = [];
  const seen = new Set();
  const add = (name, port, root) => {
    const base = projectBase(root);
    const key = base.toLowerCase();
    if (seen.has(key) || !fs.existsSync(base)) return;
    seen.add(key);
    out.push({
      name,
      port: Number(port) || 0,
      root: base.replace(/\\/g, '/'),
      databases: detectProjectDatabases(base, knownDbs),
    });
  };

  try {
    const text = fs.readFileSync(csv, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const [port, name, root] = parseCsvLine(lines[i]);
      if (name && root) add(name, port, root);
    }
  } catch {}

  if (!out.length) {
    let port = 8001;
    try {
      for (const e of fs.readdirSync(wwwRootNow(), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (['Respaldos', 'moodledata', 'node_modules'].includes(e.name)) continue;
        add(e.name, port++, path.join(wwwRootNow(), e.name));
      }
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { total += fs.statSync(full).size; files++; } catch {}
      }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

async function freeBytes(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${path.parse(dir).root.replace(/\\/g, '\\\\')}'").FreeSpace`]);
    return Number((r.stdout || '0').trim()) || 0;
  }
}

function normalizeJob(input, existing) {
  const name = String(input.name || '').trim().slice(0, 80) || 'Respaldo';
  const destRaw = String(input.destination || '').trim();
  if (!/^[A-Za-z]:[\\/]/.test(destRaw)) {
    throw new Error('El destino debe ser una ruta absoluta (ejemplo: D:\\RespaldosLaragon)');
  }
  const destination = path.resolve(destRaw);
  if (path.parse(destination).root.toLowerCase() === destination.toLowerCase()) {
    throw new Error('Elige una carpeta dentro del disco, no la raíz completa');
  }
  if (isInside(destination, LARAGON)) {
    throw new Error('El destino no puede estar dentro de Laragon (se respaldaría a sí mismo)');
  }

  const s = input.schedule || {};
  const type = ['manual', 'daily', 'weekly', 'hourly', 'window'].includes(s.type) ? s.type : 'daily';
  let time = /^\d{2}:\d{2}$/.test(String(s.time || '')) ? String(s.time) : '02:00';
  {
    const [hh, mm] = time.split(':').map(Number);
    if (!(hh >= 0 && hh < 24 && mm >= 0 && mm < 60)) time = '02:00';
  }
  const days = Array.isArray(s.days)
    ? [...new Set(s.days.map(Number).filter(d => d >= 0 && d <= 6))].sort()
    : [1, 2, 3, 4, 5];
  if ((type === 'weekly' || type === 'window') && !days.length) days.push(1, 2, 3, 4, 5);
  const every = Math.min(168, Math.max(1, Number(s.every) || 24));
  const startHour = Math.min(23, Math.max(0, Number(s.startHour) || 4));
  let endHour = Math.min(24, Math.max(1, Number(s.endHour) || 18));
  if (endHour <= startHour) endHour = Math.min(24, startHour + 1);
  const maxPerMonth = Math.min(1000, Math.max(0, Number(input.maxPerMonth) || 0));
  const retentionDays = Math.min(3650, Math.max(0, Number(input.retentionDays) || 0));

  const dbIn = input.databases || {};
  const prjIn = input.projects || {};
  const dbMode = dbIn.mode === 'selected' ? 'selected' : 'all';
  const prjMode = prjIn.mode === 'selected' ? 'selected' : 'all';
  const dbList = dbMode === 'selected'
    ? [...new Set((dbIn.list || []).map(String).filter(n => /^[A-Za-z0-9_$.-]{1,64}$/.test(n)))]
    : [];
  const prjList = prjMode === 'selected'
    ? [...new Set((prjIn.list || []).map(String).filter(Boolean))]
    : [];

  if (dbMode === 'selected' && !dbList.length && prjMode === 'selected' && !prjList.length) {
    throw new Error('Selecciona al menos una base de datos o un proyecto');
  }

  const id = existing?.id || `b_${crypto.randomBytes(4).toString('hex')}`;
  return {
    id,
    name,
    folder: existing?.folder || `${slug(name)}-${id.slice(2, 8)}`,
    destination,
    schedule: { type, time, days, every, startHour, endHour },
    databases: { mode: dbMode, list: dbList },
    projects: { mode: prjMode, list: prjList },
    excludeDeps: input.excludeDeps !== false,
    compress: input.compress !== false,
    retention: (() => {
      const raw = input.retention;
      if (raw === undefined || raw === null || raw === '') return existing?.retention ?? 5;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : (existing?.retention ?? 5);
    })(),
    retentionDays,
    maxPerMonth,
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    last: existing?.last || null,
    lastSkipAt: existing?.lastSkipAt || null,
  };
}

function saveJob(input) {
  const cfg = readConfig();
  const idx = input.id ? cfg.jobs.findIndex(j => j.id === input.id) : -1;
  const existing = idx >= 0 ? cfg.jobs[idx] : null;
  const job = normalizeJob(input, existing);
  if (idx >= 0) cfg.jobs[idx] = job;
  else cfg.jobs.push(job);
  writeConfig(cfg);
  return job;
}

function getJob(id) {
  return readConfig().jobs.find(j => j.id === id) || null;
}

async function deleteJob(id) {
  const cfg = readConfig();
  const job = cfg.jobs.find(j => j.id === id);
  if (!job) return { ok: false, error: 'Tarea no encontrada' };
  cfg.jobs = cfg.jobs.filter(j => j.id !== id);
  cfg.history = cfg.history.filter(h => h.jobId !== id);
  writeConfig(cfg);
  await deleteTask(job);
  try { fs.unlinkSync(taskCmdPath(job)); } catch {}
  return { ok: true, job };
}

function jobRoot(job) {
  return path.join(job.destination, 'LaragonBackup', job.folder);
}

function snapshots(job) {
  try {
    return fs.readdirSync(jobRoot(job), { withFileTypes: true })
      .filter(e => e.isDirectory() && SNAPSHOT_RE.test(e.name))
      .map(e => e.name)
      .sort();
  } catch { return []; }
}

function latestSnapshot(job) {
  const list = snapshots(job);
  return list.length ? path.join(jobRoot(job), list[list.length - 1]) : null;
}

function snapshotForOpen(id, wantLatest = true) {
  const job = getJob(id);
  if (!job) return null;
  const base = wantLatest ? latestSnapshot(job) : jobRoot(job);
  if (base && fs.existsSync(base)) return base;
  if (fs.existsSync(job.destination)) return job.destination;
  return null;
}

async function ensureMysql(log) {
  if (await portOpen(mysqlPortNow(), 400)) return;
  const mysql = mysqlInfo();
  if (!mysql || !fs.existsSync(mysql.exe)) throw new Error('MySQL no está instalado');

  // Si ya hay un mysqld arrancando, esperar en vez de lanzar un duplicado.
  const tl = await run('tasklist', ['/FI', 'IMAGENAME eq mysqld.exe', '/NH']);
  if (/mysqld\.exe/i.test(tl.stdout || '')) {
    log('MySQL está arrancando; esperando…');
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (await portOpen(mysqlPortNow(), 300)) return;
    }
    throw new Error('MySQL no terminó de arrancar');
  }

  log('MySQL estaba detenido; iniciando para el respaldo…');
  spawn(mysql.exe, [`--defaults-file=${mysql.ini}`], {
    cwd: path.join(mysql.base, 'bin'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await portOpen(mysqlPortNow(), 300)) {
      log('MySQL listo.');
      return;
    }
  }
  throw new Error('MySQL no arrancó; no se pueden respaldar las bases');
}

function dumpDatabase(mysql, db, file, log) {
  return new Promise((resolve, reject) => {
    const args = [
      '-u', 'root', `--port=${mysqlPortNow()}`, '--protocol=TCP',
      '--single-transaction', '--quick', '--routines', '--triggers',
      '--events', '--hex-blob', '--default-character-set=utf8mb4',
      '--set-gtid-purged=OFF', '--no-tablespaces',
      '--databases', db,
    ];
    let stderr = '';
    let finished = false;
    const ws = fs.createWriteStream(file);
    const child = spawn(mysql.dump, args, { windowsHide: true });
    const fail = err => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch {}
      try { ws.destroy(); } catch {}
      try { fs.unlinkSync(file); } catch {}
      reject(err);
    };
    ws.on('error', fail);
    child.on('error', fail);
    child.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
    });
    child.stdout.pipe(ws);
    child.on('close', code => {
      if (finished) return;
      ws.end(() => {
        if (code !== 0) {
          finished = true;
          try { fs.unlinkSync(file); } catch {}
          return reject(new Error((stderr || `mysqldump salió con código ${code}`).trim().slice(0, 800)));
        }
        finished = true;
        try {
          const size = fs.statSync(file).size;
          log(`  ${db}: ${(size / 1048576).toFixed(1)} MB`);
          resolve(size);
        } catch (e) { reject(e); }
      });
    });
  });
}

async function copyProject(src, dst, excludeDeps, log) {
  if (!fs.existsSync(src)) throw new Error('La carpeta del proyecto no existe');
  const args = [src, dst, '/E', '/R:1', '/W:1', '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'];
  if (excludeDeps) args.push('/XD', 'node_modules', 'vendor', '.git', '.idea', '.vscode');
  const r = await run('robocopy.exe', args, { timeout: 6 * 3600 * 1000 });
  if (r.code >= 8) {
    throw new Error((r.stderr || r.stdout || `robocopy salió con código ${r.code}`).trim().slice(-800));
  }
  log(`  ${path.basename(dst)}: copiado`);
}

async function zipDirectory(src, zipFile, log) {
  const tar = fs.existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar.exe';
  try { fs.unlinkSync(zipFile); } catch {}
  const r = await run(tar, ['-a', '-c', '-f', zipFile, '-C', src, '.'], { timeout: 8 * 3600 * 1000 });
  if (r.code !== 0) {
    try { fs.unlinkSync(zipFile); } catch {}
    throw new Error((r.stderr || r.stdout || `tar salió con código ${r.code}`).trim().slice(-800));
  }
  const size = fs.statSync(zipFile).size;
  log(`  ZIP ${path.basename(zipFile)}: ${(size / 1048576).toFixed(1)} MB`);
  return size;
}

// Agrupa las bases seleccionadas dentro de su proyecto; las que no tengan proyecto quedan sueltas.
function planGroups(projects, dbNames) {
  const assigned = new Set();
  const groups = projects.map(project => {
    const databases = (project.databases || []).filter(db => dbNames.includes(db));
    databases.forEach(db => assigned.add(db));
    return { project, databases };
  });
  return { groups, loose: dbNames.filter(db => !assigned.has(db)) };
}

function record(cfg, job, entry, skipped = false) {
  const fresh = readConfig();
  const idx = fresh.jobs.findIndex(j => j.id === job.id);
  if (idx >= 0) {
    if (skipped) fresh.jobs[idx].lastSkipAt = entry.at;
    else fresh.jobs[idx].last = entry;
    fresh.jobs[idx].updatedAt = new Date().toISOString();
  }
  fresh.history.unshift(entry);
  fresh.history = fresh.history.slice(0, HISTORY_LIMIT);
  writeConfig(fresh);
}

function panelLogName(job) {
  return path.join(BACKUP_DIR, `run-${job.folder}-${stamp()}.log`);
}

async function runJob(jobId, opts = {}) {
  ensureDirs();
  const cfg = readConfig();
  const job = cfg.jobs.find(j => j.id === jobId);
  if (!job) return { ok: false, error: 'Tarea no encontrada' };
  if (opts.scheduled && !isDue(job, new Date(), cfg)) {
    console.log(`[backup] "${job.name}" fuera de programación; se omite.`);
    return { ok: true, skipped: true, message: 'Fuera de programación' };
  }
  if (!acquireLock(job.id)) {
    return { ok: true, skipped: true, error: 'Ya hay un respaldo en ejecución' };
  }

  const started = Date.now();
  const startedAt = new Date().toISOString();
  const trigger = opts.scheduled ? 'programado' : 'manual';
  const lines = [];
  const logFile = panelLogName(job);
  const log = msg => {
    const line = `[${new Date().toLocaleString('es-ES')}] ${msg}`;
    lines.push(line);
    console.log(`[backup] ${msg}`);
    try { fs.appendFileSync(logFile, line + '\r\n'); } catch {}
  };

  let snapshot = null;
  let progressTotal = 0;

  try {
    log(`Tarea "${job.name}" (${trigger})`);
    log(`Destino: ${job.destination}`);

    const driveRoot = path.parse(job.destination).root;
    if (!fs.existsSync(driveRoot)) {
      if (opts.scheduled) {
        log(`El disco ${driveRoot} no está conectado; se omite esta ejecución.`);
        const entry = {
          id: `h_${crypto.randomBytes(4).toString('hex')}`,
          jobId: job.id, name: job.name, at: new Date().toISOString(),
          trigger, ok: true, skipped: true, durationSec: 0, mb: 0, files: 0,
          message: `Disco ${driveRoot} no conectado`, destination: job.destination, snapshot: null,
        };
        record(cfg, job, entry, true);
        writeState({ running: false, last: entry });
        log('Omitido: disco no conectado.');
        return { ok: true, skipped: true, entry };
      }
      throw new Error(`El disco ${driveRoot} no está conectado`);
    }

    fs.mkdirSync(job.destination, { recursive: true });
    const root = jobRoot(job);
    fs.mkdirSync(root, { recursive: true });

    const compress = job.compress !== false;
    const free = await freeBytes(job.destination);
    const estimate = job.last && job.last.mb
      ? Math.ceil(job.last.mb * (compress ? 2.2 : 1.2))
      : 1024;
    if (free && free < estimate * 1048576) {
      throw new Error(`Espacio insuficiente en ${driveRoot}: ${(free / 1073741824).toFixed(1)} GB libres, se estiman ${(estimate / 1024).toFixed(1)} GB`);
    }

    let dbNames = [];
    if (job.databases.mode === 'all' || job.databases.list.length) {
      await ensureMysql(log);
      dbNames = job.databases.mode === 'all' ? await listDatabaseNames() : job.databases.list;
    }
    const allProjects = listProjects(dbNames);
    const selectedProjects = job.projects.mode === 'all'
      ? allProjects
      : allProjects.filter(p => job.projects.list.includes(p.name));
    const missing = job.projects.mode === 'selected'
      ? job.projects.list.filter(n => !allProjects.some(p => p.name === n))
      : [];
    if (missing.length) log(`Aviso: proyectos no encontrados: ${missing.join(', ')}`);

    const plan = compress ? planGroups(selectedProjects, dbNames) : null;
    progressTotal = compress
      ? selectedProjects.length + (plan.loose.length ? 1 : 0)
      : dbNames.length + selectedProjects.length;
    if (!progressTotal) throw new Error('La tarea no incluye bases de datos ni proyectos');

    snapshot = path.join(root, uniqueSnapshotDir(root));
    fs.mkdirSync(snapshot, { recursive: true });
    const dbDir = path.join(snapshot, 'databases');
    const prjDir = path.join(snapshot, 'projects');
    const tmpDir = path.join(snapshot, '.tmp');
    const errors = [];
    const projectResults = [];
    let looseResult = null;
    let looseDbs = [];
    let done = 0;

    writeState({
      running: true, jobId: job.id, jobName: job.name, startedAt,
      step: 'Preparando', done: 0, total: progressTotal, pct: 0,
      snapshot, destination: job.destination,
    });

    const mysql = dbNames.length ? mysqlInfo() : null;

    if (compress) {
      fs.mkdirSync(tmpDir, { recursive: true });
      const cacheDir = path.join(tmpDir, '_dumps');
      const cache = new Map();
      const failed = new Set();

      const dumpCached = async db => {
        if (cache.has(db)) return cache.get(db);
        if (failed.has(db)) return null;
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          const file = path.join(cacheDir, `${slug(db)}.sql`);
          await dumpDatabase(mysql, db, file, log);
          cache.set(db, file);
          return file;
        } catch (e) {
          failed.add(db);
          errors.push(`Base ${db}: ${e.message}`);
          log(`  ERROR: ${e.message}`);
          return null;
        }
      };

      try {
        looseDbs = plan.loose.slice();
        for (const group of plan.groups) {
          const p = group.project;
          log(`Proyecto: ${p.name} (${p.root})`);
          writeState({
            running: true, jobId: job.id, jobName: job.name, startedAt,
            step: `Comprimiendo ${p.name}`, done, total: progressTotal,
            pct: Math.round((done / progressTotal) * 100), snapshot, destination: job.destination,
          });

          const stage = path.join(tmpDir, `p_${slug(p.name)}`);
          try {
            fs.rmSync(stage, { recursive: true, force: true });
            fs.mkdirSync(stage, { recursive: true });
            await copyProject(p.root, stage, job.excludeDeps, log);

            const included = [];
            if (group.databases.length) {
              const dbStage = path.join(stage, '_database');
              fs.mkdirSync(dbStage, { recursive: true });
              for (const db of group.databases) {
                const dump = await dumpCached(db);
                if (!dump) continue;
                fs.copyFileSync(dump, path.join(dbStage, `${slug(db)}.sql`));
                included.push(db);
              }
            }

            fs.mkdirSync(prjDir, { recursive: true });
            const zip = path.join(prjDir, `${slug(p.name)}.zip`);
            const bytes = await zipDirectory(stage, zip, log);
            projectResults.push({
              name: p.name,
              port: p.port,
              root: p.root,
              databases: included,
              archive: `projects/${path.basename(zip)}`,
              mb: +(bytes / 1048576).toFixed(2),
            });
          } catch (e) {
            errors.push(`Proyecto ${p.name}: ${e.message}`);
            log(`  ERROR: ${e.message}`);
          } finally {
            try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
          }
          done++;
        }

        // Si un proyecto falló, sus bases no quedaron en ningún ZIP: incluirlas en el grupo suelto.
        const includedDbs = new Set(projectResults.flatMap(p => p.databases || []));
        for (const db of dbNames) {
          if (!includedDbs.has(db) && !looseDbs.includes(db)) {
            looseDbs.push(db);
            if (progressTotal === selectedProjects.length) progressTotal += 1;
          }
        }

        if (looseDbs.length) {
          log(`Bases sin proyecto: ${looseDbs.join(', ')}`);
          writeState({
            running: true, jobId: job.id, jobName: job.name, startedAt,
            step: 'Comprimiendo bases sin proyecto', done, total: progressTotal,
            pct: Math.round((done / progressTotal) * 100), snapshot, destination: job.destination,
          });

          const stage = path.join(tmpDir, '_bases_sin_proyecto');
          try {
            fs.rmSync(stage, { recursive: true, force: true });
            const dbStage = path.join(stage, 'databases');
            fs.mkdirSync(dbStage, { recursive: true });
            const included = [];
            for (const db of looseDbs) {
              const dump = await dumpCached(db);
              if (!dump) continue;
              fs.copyFileSync(dump, path.join(dbStage, `${slug(db)}.sql`));
              included.push(db);
            }
            if (included.length) {
              fs.mkdirSync(prjDir, { recursive: true });
              const zip = path.join(prjDir, '_bases_sin_proyecto.zip');
              const bytes = await zipDirectory(stage, zip, log);
              looseResult = {
                archive: `projects/${path.basename(zip)}`,
                databases: included,
                mb: +(bytes / 1048576).toFixed(2),
              };
            }
          } catch (e) {
            errors.push(`Bases sin proyecto: ${e.message}`);
            log(`  ERROR: ${e.message}`);
          } finally {
            try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
          }
          done++;
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    } else {
      if (dbNames.length) {
        fs.mkdirSync(dbDir, { recursive: true });
        let i = 0;
        for (const db of dbNames) {
          i++;
          log(`Base ${i}/${dbNames.length}: ${db}`);
          writeState({
            running: true, jobId: job.id, jobName: job.name, startedAt,
            step: `Base de datos ${db}`, done, total: progressTotal,
            pct: Math.round((done / progressTotal) * 100), snapshot, destination: job.destination,
          });
          try {
            await dumpDatabase(mysql, db, path.join(dbDir, `${slug(db)}.sql`), log);
          } catch (e) {
            errors.push(`Base ${db}: ${e.message}`);
            log(`  ERROR: ${e.message}`);
          }
          done++;
        }
      }

      if (selectedProjects.length) {
        fs.mkdirSync(prjDir, { recursive: true });
        for (const p of selectedProjects) {
          log(`Proyecto: ${p.name} (${p.root})`);
          writeState({
            running: true, jobId: job.id, jobName: job.name, startedAt,
            step: `Proyecto ${p.name}`, done, total: progressTotal,
            pct: Math.round((done / progressTotal) * 100), snapshot, destination: job.destination,
          });
          try {
            const target = path.join(prjDir, slug(p.name));
            await copyProject(p.root, target, job.excludeDeps, log);
            const local = dirSize(target);
            projectResults.push({
              name: p.name,
              port: p.port,
              root: p.root,
              databases: (p.databases || []).filter(db => dbNames.includes(db)),
              archive: `projects/${slug(p.name)}/`,
              mb: +(local.bytes / 1048576).toFixed(2),
            });
          } catch (e) {
            errors.push(`Proyecto ${p.name}: ${e.message}`);
            log(`  ERROR: ${e.message}`);
          }
          done++;
        }
      }
    }

    const size = dirSize(snapshot);
    const finishedAt = new Date().toISOString();
    const ok = errors.length === 0;
    const manifest = {
      job: { id: job.id, name: job.name, destination: job.destination, excludeDeps: job.excludeDeps, compress },
      format: compress ? 'zip-per-project' : 'folders',
      trigger,
      startedAt,
      finishedAt,
      durationSec: Math.round((Date.now() - started) / 1000),
      databases: dbNames,
      unassignedDatabases: compress ? looseDbs : [],
      looseArchive: looseResult,
      projects: projectResults,
      totals: { mb: +(size.bytes / 1048576).toFixed(2), files: size.files },
      errors,
      environment: {
        host: require('os').hostname(),
        node: process.version,
        mysql: mysqlInfo()?.name || null,
        selectedProjects: selectedProjects.length,
        selectedDatabases: dbNames.length,
      },
    };
    fs.writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(snapshot, 'respaldo.log'), lines.join('\r\n'), 'utf8');

    // Retención: solo dentro de la carpeta de esta tarea y solo si la copia salió bien.
    if (ok) {
      const keep = Math.max(0, Number(job.retention) || 0);
      const maxAge = Number(job.retentionDays) > 0
        ? Date.now() - Number(job.retentionDays) * 86400 * 1000
        : 0;
      const all = snapshots(job);
      const remove = new Set();
      if (maxAge) {
        for (const name of all) {
          try {
            if (fs.statSync(path.join(root, name)).mtimeMs < maxAge) remove.add(name);
          } catch {}
        }
      }
      const remaining = all.filter(name => !remove.has(name));
      if (keep > 0) {
        remaining.slice(0, Math.max(0, remaining.length - keep)).forEach(name => remove.add(name));
      }
      for (const old of all.filter(name => remove.has(name))) {
        log(`Retención: eliminando copia antigua ${old}`);
        try { fs.rmSync(path.join(root, old), { recursive: true, force: true }); } catch (e) { log(`  ERROR al borrar: ${e.message}`); }
      }
    } else {
      log('Retención omitida porque la copia tuvo errores.');
    }

    const entry = {
      id: `h_${crypto.randomBytes(4).toString('hex')}`,
      jobId: job.id,
      name: job.name,
      at: finishedAt,
      trigger,
      ok,
      skipped: false,
      durationSec: Math.round((Date.now() - started) / 1000),
      mb: manifest.totals.mb,
      files: manifest.totals.files,
      databases: dbNames.length,
      projects: selectedProjects.length,
      compress,
      snapshot,
      destination: job.destination,
      errors: errors.slice(0, 5),
    };
    record(cfg, job, entry);
    writeState({ running: false, last: entry });
    log(ok ? `Respaldo completado: ${entry.mb} MB en ${entry.durationSec} s` : `Respaldo con errores (${errors.length})`);
    return { ok, entry, snapshot, errors };
  } catch (e) {
    const entry = {
      id: `h_${crypto.randomBytes(4).toString('hex')}`,
      jobId: job.id,
      name: job.name,
      at: new Date().toISOString(),
      trigger,
      ok: false,
      skipped: false,
      durationSec: Math.round((Date.now() - started) / 1000),
      mb: 0,
      files: 0,
      snapshot,
      destination: job.destination,
      error: e.message,
    };
    record(cfg, job, entry);
    writeState({ running: false, last: entry });
    log(`ERROR: ${e.message}`);
    return { ok: false, error: e.message, entry };
  } finally {
    releaseLock();
  }
}

/* ---------------- Programador de tareas de Windows ---------------- */

function taskName(job) {
  return `${TASK_PREFIX}${job.id}`;
}

function taskCmdPath(job) {
  return path.join(DATA_DIR, `backup-task-${job.id}.cmd`);
}

function nodeForTask() {
  if (process.env.PANEL_NODE && fs.existsSync(process.env.PANEL_NODE)) return process.env.PANEL_NODE;
  if (/node\.exe$/i.test(process.execPath)) return process.execPath;
  const sys = 'C:/Program Files/nodejs/node.exe';
  if (fs.existsSync(sys)) return sys;
  return process.execPath;
}

function writeTaskCmd(job) {
  const exe = nodeForTask();
  const script = path.join(PANEL_DIR, 'backup-runner.js');
  const log = path.join(BACKUP_DIR, `task-${job.id}.log`);
  const content = [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `cd /d "${PANEL_DIR}"`,
    `"${exe}" "${script}" --job ${job.id} --scheduled >> "${log}" 2>&1`,
    '',
  ].join('\r\n');
  fs.writeFileSync(taskCmdPath(job), content, 'utf8');
  return taskCmdPath(job);
}

async function listTasks() {
  const cmd = "Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'LaragonPanel_Backup_*' } | Select-Object TaskName,State | ConvertTo-Json -Compress";
  const r = await run('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 30000 });
  try {
    const parsed = JSON.parse((r.stdout || '').trim() || '[]');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const states = { 0: 'Unknown', 1: 'Disabled', 2: 'Queued', 3: 'Ready', 4: 'Running' };
    const map = {};
    for (const t of list) {
      if (t && t.TaskName) {
        map[t.TaskName] = typeof t.State === 'number' ? (states[t.State] || String(t.State)) : t.State;
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function deleteTask(job) {
  const name = taskName(job).replace(/'/g, "''");
  const cmd = `Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false -ErrorAction SilentlyContinue`;
  return run('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 30000 });
}

const TASKS_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$data = Get-Content -LiteralPath '__TASKS_DATA__' -Raw -Encoding UTF8 | ConvertFrom-Json
Get-ScheduledTask -ErrorAction SilentlyContinue |
  Where-Object { $_.TaskName -like 'LaragonPanel_Backup_*' } |
  ForEach-Object { Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false }
foreach ($t in @($data.tasks)) {
  $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument ('/c "' + $t.cmd + '"') -WorkingDirectory $t.cwd
  if ($t.type -eq 'daily') {
    $trigger = New-ScheduledTaskTrigger -Daily -At $t.time
  } elseif ($t.type -eq 'weekly') {
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.days -At $t.time
  } elseif ($t.type -eq 'window') {
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours $t.every) -RepetitionDuration (New-TimeSpan -Days 3650)
  } else {
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours $t.every) -RepetitionDuration (New-TimeSpan -Days 3650)
  }
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
  Register-ScheduledTask -TaskName $t.name -Action $action -Trigger $trigger -Settings $settings -Description $t.description -Force | Out-Null
}
`;

async function applyTasks() {
  ensureDirs();
  const cfg = readConfig();
  const jobs = cfg.jobs.filter(j => j.enabled && j.schedule && j.schedule.type !== 'manual');
  const tasks = [];
  for (const job of jobs) {
    const cmd = writeTaskCmd(job);
    tasks.push({
      name: taskName(job),
      cmd,
      cwd: PANEL_DIR,
      type: job.schedule.type,
      time: job.schedule.time,
      days: (job.schedule.days || []).map(d => DAY_NAMES[d]).filter(Boolean),
      every: job.schedule.every || 24,
      description: `Laragon Panel: ${job.name}`,
    });
  }

  atomicJson(TASKS_DATA, { tasks });
  const script = TASKS_PS1.replace('__TASKS_DATA__', TASKS_DATA.replace(/'/g, "''"));
  fs.writeFileSync(TASKS_SCRIPT, script, 'utf8');

  const r = await run('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TASKS_SCRIPT,
  ], { timeout: 180000 });

  if (r.code !== 0) {
    return {
      ok: false,
      error: (r.stderr || r.stdout || 'No se pudieron registrar las tareas').trim().slice(0, 1500),
      count: 0,
      tasks: {},
    };
  }
  const installed = await listTasks();
  return { ok: true, count: tasks.length, tasks: installed };
}

/* ---------------- Programación interna (respaldo si el panel está abierto) ---------------- */

function monthlyRuns(cfg, jobId, now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  return (cfg.history || []).filter(h => {
    if (h.jobId !== jobId || !h.ok || h.skipped) return false;
    const d = new Date(h.at);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
}

function isDue(job, now = new Date(), cfg = null) {
  const s = job.schedule || {};
  if (!job.enabled || s.type === 'manual') return false;
  if (cfg && job.maxPerMonth > 0 && monthlyRuns(cfg, job.id, now) >= job.maxPerMonth) return false;
  const last = job.last?.at ? new Date(job.last.at).getTime() : 0;

  if (s.type === 'hourly') {
    const every = Math.max(1, Number(s.every) || 24);
    return now.getTime() - last >= every * 3600 * 1000 - 5 * 60 * 1000;
  }
  if (s.type === 'window') {
    if (!(s.days || []).includes(now.getDay())) return false;
    const hour = now.getHours();
    const start = Number(s.startHour) || 0;
    const end = Number(s.endHour) || 24;
    if (hour < start || hour >= end) return false;
    const every = Math.max(1, Number(s.every) || 2) * 3600 * 1000;
    return now.getTime() - last >= every - 5 * 60 * 1000;
  }

  const [h, m] = String(s.time || '02:00').split(':').map(Number);
  const target = new Date(now);
  target.setHours(h || 0, m || 0, 0, 0);
  if (s.type === 'weekly') {
    if (!(s.days || []).includes(now.getDay())) return false;
  }
  return now.getTime() >= target.getTime() && last < target.getTime();
}

function spawnRunner(jobId, scheduled) {
  ensureDirs();
  const args = [path.join(PANEL_DIR, 'backup-runner.js'), '--job', jobId];
  if (scheduled) args.push('--scheduled');
  const node = process.env.PANEL_NODE && fs.existsSync(process.env.PANEL_NODE)
    ? process.env.PANEL_NODE
    : process.execPath;
  const child = spawn(node, args, {
    cwd: PANEL_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

let schedulerTimer = null;

async function maybeRunDue(log = () => {}) {
  if (isRunning()) return;
  const cfg = readConfig();
  const now = new Date();
  for (const job of cfg.jobs) {
    if (!isDue(job, now, cfg)) continue;
    if (job.lastSkipAt && Date.now() - Date.parse(job.lastSkipAt) < 30 * 60 * 1000) continue;
    const driveRoot = path.parse(job.destination).root;
    if (!fs.existsSync(driveRoot)) {
      log(`"${job.name}": disco ${driveRoot} no conectado; se reintentará.`);
      continue;
    }
    log(`Ejecutando respaldo programado: ${job.name}`);
    spawnRunner(job.id, true);
    return;
  }
}

function startScheduler(log = () => {}) {
  if (schedulerTimer) return;
  const tick = () => maybeRunDue(log).catch(e => log(`Error del programador: ${e.message}`));
  setTimeout(tick, 8000);
  schedulerTimer = setInterval(tick, 5 * 60 * 1000);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

/* ---------------- Datos para la interfaz ---------------- */

let drivesCache = { at: 0, data: [] };

async function listDrives() {
  if (drivesCache.data.length && Date.now() - drivesCache.at < 30000) return drivesCache.data;
  const cmd = "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 } | Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | ConvertTo-Json -Compress";
  const r = await run('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 30000 });
  let list = [];
  try {
    const parsed = JSON.parse((r.stdout || '').trim() || '[]');
    list = (Array.isArray(parsed) ? parsed : [parsed]).map(d => ({
      root: `${d.DeviceID}\\`,
      label: d.VolumeName ? `${d.DeviceID} ${d.VolumeName}` : d.DeviceID,
      removable: Number(d.DriveType) === 2,
      totalGB: +(Number(d.Size) / 1073741824).toFixed(1),
      freeGB: +(Number(d.FreeSpace) / 1073741824).toFixed(1),
    })).filter(d => d.totalGB > 0);
  } catch {}
  drivesCache = { at: Date.now(), data: list };
  return list;
}

async function status() {
  const running = isRunning();
  const st = readState();
  return { running, state: running ? st : { ...st, running: false }, lock: readLock() };
}

async function jobsPayload(catalog = {}) {
  const cfg = readConfig();
  const [drives, tasks] = await Promise.all([listDrives(), listTasks()]);
  return {
    jobs: cfg.jobs.map(j => ({ ...j, monthlyRuns: monthlyRuns(cfg, j.id) })),
    history: cfg.history.slice(0, 60),
    drives,
    tasks,
    catalog,
    state: readState(),
    running: isRunning(),
  };
}

module.exports = {
  LARAGON,
  BACKUP_DIR,
  CONFIG_FILE,
  readConfig,
  saveJob,
  deleteJob,
  getJob,
  runJob,
  listProjects,
  listDatabaseNames,
  listDrives,
  listTasks,
  applyTasks,
  spawnRunner,
  startScheduler,
  isDue,
  isRunning,
  status,
  jobsPayload,
  latestSnapshot,
  snapshotForOpen,
  taskName,
  // Para pruebas
  normalizeJob,
};
