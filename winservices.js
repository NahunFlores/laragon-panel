'use strict';

/*
 * Gestión de servicios de Windows con NSSM.
 *
 * - Lista servicios instalados y su estado real (sc / Win32_Service).
 * - Detecta Apache, MySQL, Redis y colas Laravel.
 * - Permite instalar servicios nuevos (core, queue o personalizado),
 *   iniciarlos, detenerlos, reiniciarlos, cambiar auto-inicio y quitarlos.
 *
 * Las operaciones de escritura requieren que el panel se ejecute como
 * administrador. Las lecturas funcionan sin elevación.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const config = require('./config');
const backup = require('./backup');

const LARAGON = config.laragonRoot;
const NSSM = config.nssmPath || 'C:/laragon/nssm-2.24/win64/nssm.exe';
const STATE_FILE = path.join(config.dataDir, 'winservices.json');
const LOG_DIR = path.join(LARAGON, 'tmp', 'logs');
const SERVICE_PREFIX = 'Laragon';

let servicesCache = { at: 0, data: null };

function run(exe, args, opts = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(exe, args, { cwd: opts.cwd, windowsHide: true, env: opts.env || process.env });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message });
    }
    const timer = opts.timeout ? setTimeout(() => { try { child.kill(); } catch {} }, opts.timeout) : null;
    child.stdout.on('data', d => { if (stdout.length < 2e6) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < 2e6) stderr += d.toString(); });
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

function win(p) {
  return String(p || '').replace(/\//g, '\\');
}

function hasNssm() {
  return fs.existsSync(NSSM);
}

function wrapperPath(name) {
  return path.join(config.dataDir, `svc-${slug(name)}.cmd`);
}

function writeWrapper(spec) {
  const file = wrapperPath(spec.name);
  const q = value => /[\s"]/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
  const lines = [
    '@echo off',
    `cd /d "${win(spec.cwd)}"`,
  ];
  if (spec.kind === 'queue') {
    lines.push(`set PATH=${win(path.dirname(spec.exe))};%PATH%`);
  }
  lines.push(`"${win(spec.exe)}" ${spec.args.map(q).join(' ')} >> "${win(spec.logOut)}" 2>&1`);
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

function slug(text) {
  return String(text || 'servicio')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'servicio';
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { managed: Array.isArray(s.managed) ? s.managed : [] };
  } catch {
    return { managed: [] };
  }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ managed: state.managed || [] }, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function addManaged(entry) {
  const state = readState();
  const idx = state.managed.findIndex(m => m.name.toLowerCase() === entry.name.toLowerCase());
  if (idx >= 0) state.managed[idx] = { ...state.managed[idx], ...entry };
  else state.managed.push(entry);
  writeState(state);
}

function removeManaged(name) {
  const state = readState();
  state.managed = state.managed.filter(m => m.name.toLowerCase() !== String(name).toLowerCase());
  writeState(state);
}

function latestDir(base, prefix) {
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith(prefix))
      .map(e => path.join(base, e.name))
      .sort()
      .pop() || null;
  } catch { return null; }
}

function findRedis() {
  if (config.redisPath && fs.existsSync(config.redisPath)) return config.redisPath;
  const base = path.join(LARAGON, 'bin', 'redis');
  const direct = path.join(base, 'redis-server.exe');
  if (fs.existsSync(direct)) return direct;
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const exe = path.join(base, e.name, 'redis-server.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  return '';
}

function findPhp() {
  if (config.phpPath && fs.existsSync(config.phpPath)) return config.phpPath;
  const base = path.join(LARAGON, 'bin', 'php');
  try {
    const ini = fs.readFileSync(path.join(LARAGON, 'usr', 'laragon.ini'), 'utf8');
    const m = ini.match(/^\s*\[php\][\s\S]*?^\s*Version\s*=\s*(.+)$/im);
    if (m) {
      const exe = path.join(base, m[1].trim(), 'php.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  const dir = latestDir(base, 'php-');
  if (dir) {
    const exe = path.join(dir, 'php.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

function coreCatalog() {
  const apacheBase = latestDir(path.join(LARAGON, 'bin', 'apache'), 'httpd-');
  const mysqlBase = latestDir(path.join(LARAGON, 'bin', 'mysql'), 'mysql-');
  const redisExe = findRedis();
  const apacheExe = apacheBase ? path.join(apacheBase, 'bin', 'httpd.exe') : '';
  const mysqlExe = mysqlBase ? path.join(mysqlBase, 'bin', 'mysqld.exe') : '';
  const mysqlIni = mysqlBase ? path.join(mysqlBase, 'my.ini') : '';
  const redisConf = redisExe ? path.join(path.dirname(redisExe), 'redis.windows.conf') : '';

  const list = [
    {
      key: 'apache', name: `${SERVICE_PREFIX}Apache`, label: 'Apache',
      exe: apacheExe, args: [], cwd: apacheBase ? path.join(apacheBase, 'bin') : '',
    },
    {
      key: 'mysql', name: `${SERVICE_PREFIX}MySQL`, label: 'MySQL',
      exe: mysqlExe, args: mysqlIni ? [`--defaults-file=${win(mysqlIni)}`] : [],
      cwd: mysqlBase ? path.join(mysqlBase, 'bin') : '',
    },
    {
      key: 'redis', name: `${SERVICE_PREFIX}Redis`, label: 'Redis',
      exe: redisExe,
      args: redisConf && fs.existsSync(redisConf) ? [win(redisConf)] : [],
      cwd: redisExe ? path.dirname(redisExe) : '',
    },
  ];
  return list.map(x => ({
    ...x,
    exists: !!(x.exe && fs.existsSync(x.exe)),
    logOut: path.join(LOG_DIR, `${x.key}.log`),
    logErr: path.join(LOG_DIR, `${x.key}-error.log`),
  }));
}

function parseEnv(file) {
  const map = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      map[m[1]] = v.replace(/\s+#.*$/, '').trim();
    }
  } catch {}
  return map;
}

function queueCandidates() {
  const php = findPhp();
  if (!php) return [];
  const out = [];
  for (const p of backup.listProjects()) {
    const artisan = path.join(p.root, 'artisan');
    if (!fs.existsSync(artisan)) continue;
    const env = parseEnv(path.join(p.root, '.env'));
    const conn = env.QUEUE_CONNECTION || 'sync';
    const name = `${SERVICE_PREFIX}Queue_${slug(p.name)}`;
    out.push({
      name,
      label: `Cola · ${p.name}`,
      kind: 'queue',
      project: p.name,
      root: p.root,
      connection: conn,
      queue: env.QUEUE_NAME || 'default',
      exe: php,
      args: [
        win(artisan), 'queue:work', conn,
        '--tries=3', '--sleep=3', '--timeout=300',
        `--queue=${env.QUEUE_NAME || 'default'}`,
      ],
      cwd: p.root,
      logOut: path.join(LOG_DIR, `queue-${slug(p.name)}.log`),
      logErr: path.join(LOG_DIR, `queue-${slug(p.name)}-error.log`),
      suggested: conn !== 'sync',
    });
  }
  return out;
}

async function listWindowsServices(force = false) {
  if (!force && servicesCache.data && Date.now() - servicesCache.at < 5000) return servicesCache.data;
  const ps = "Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode,PathName,StartName | ConvertTo-Json -Compress";
  const r = await run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 30000 });
  let list = [];
  try {
    const parsed = JSON.parse((r.stdout || '').trim() || '[]');
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  servicesCache = { at: Date.now(), data: list };
  return list;
}

function findService(list, name) {
  return list.find(s => String(s.Name || '').toLowerCase() === String(name || '').toLowerCase()) || null;
}

function statusFor(list, name) {
  const s = findService(list, name);
  return s ? s.State : 'Not installed';
}

async function isAdmin() {
  const r = await run('powershell.exe', ['-NoProfile', '-Command',
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"]);
  return /true/i.test(r.stdout || '');
}

const ELEV_DIR = path.join(os.tmpdir(), 'laragon-panel-svc');

async function runElevated(cmds) {
  fs.mkdirSync(ELEV_DIR, { recursive: true });
  const id = `elev-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const jsonFile = path.join(ELEV_DIR, `${id}.json`);
  const resultFile = path.join(ELEV_DIR, `${id}-result.json`);
  const script = path.join(ELEV_DIR, `${id}.ps1`);
  fs.writeFileSync(jsonFile, JSON.stringify(cmds), 'utf8');

  const ps = String.raw`
$ErrorActionPreference = 'Continue'
$cmds = Get-Content -LiteralPath '${jsonFile}' -Raw | ConvertFrom-Json
$steps = @()
$fail = 0
foreach ($c in @($cmds)) {
  $exe = [string]$c[0]
  $a = @()
  for ($i = 1; $i -lt $c.Count; $i++) { $a += [string]$c[$i] }
  $out = & $exe @a 2>&1
  $code = $LASTEXITCODE
  $text = ($out | Out-String)
  $steps += [pscustomobject]@{ cmd = ($exe + ' ' + ($a -join ' ')); code = $code; output = $text }
  if ($code -ne 0) { $fail++ }
}
[pscustomobject]@{ ok = ($fail -eq 0); fail = $fail; steps = $steps } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath '${resultFile}' -Encoding UTF8
exit $fail
`;
  fs.writeFileSync(script, ps, 'utf8');

  const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${script}')`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', command], { timeout: 240000 });

  // Start-Process -Wait puede volver antes de que el proceso elevado termine
  // de escribir el resultado; esperar el archivo.
  let result = null;
  for (let i = 0; i < 120; i++) {
    try {
      const text = fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '');
      result = JSON.parse(text);
      break;
    } catch {}
    if (r.code !== 0 && i > 10) break;
    await new Promise(res => setTimeout(res, 500));
  }
  if (!result) {
    return {
      ok: false,
      error: (r.stderr || r.stdout || 'No se completó la elevación (¿cancelaste el UAC?)').trim(),
      steps: [],
    };
  }
  return {
    ok: !!result.ok,
    error: result.ok ? null : `Fallaron ${result.fail} comando(s)`,
    steps: (result.steps || []).map(s => ({
      cmd: String(s.cmd || '').replace(/\u0000/g, ''),
      code: s.code,
      stdout: String(s.output || '').replace(/\u0000/g, '').trim(),
      stderr: '',
    })),
  };
}

async function overview() {
  const list = await listWindowsServices();
  const core = coreCatalog().map(c => ({
    ...c,
    status: statusFor(list, c.name),
    installed: !!findService(list, c.name),
    startMode: (findService(list, c.name) || {}).StartMode || '',
  }));
  const queues = queueCandidates().map(q => ({
    ...q,
    status: statusFor(list, q.name),
    installed: !!findService(list, q.name),
    startMode: (findService(list, q.name) || {}).StartMode || '',
  }));
  const managed = readState().managed.map(m => ({
    ...m,
    status: statusFor(list, m.name),
    installed: !!findService(list, m.name),
    startMode: (findService(list, m.name) || {}).StartMode || '',
  }));
  const known = new Set([...core, ...queues, ...managed].map(x => x.name.toLowerCase()));
  const detected = list
    .filter(s => /laragon|redis|queue|backup|apache|mysql/i.test(`${s.Name} ${s.DisplayName} ${s.PathName || ''}`))
    .filter(s => !known.has(String(s.Name).toLowerCase()))
    .map(s => ({
      name: s.Name, label: s.DisplayName || s.Name, status: s.State,
      startMode: s.StartMode, path: s.PathName || '',
    }));

  return {
    nssm: { path: NSSM, exists: fs.existsSync(NSSM) },
    admin: await isAdmin(),
    core,
    queues,
    managed,
    detected,
  };
}

function buildSpec(spec) {
  const kind = String(spec.kind || 'custom');
  if (kind === 'core') {
    const key = String(spec.key || '');
    const c = coreCatalog().find(x => x.key === key);
    if (!c) throw new Error('Servicio base no válido');
    if (!c.exists) throw new Error(`No se encontró el ejecutable de ${c.label}: ${c.exe || 'ruta vacía'}`);
    return {
      kind: 'core', key: c.key, name: c.name, label: c.label,
      exe: c.exe, args: c.args, cwd: c.cwd,
      logOut: c.logOut, logErr: c.logErr,
      autoStart: spec.autoStart !== false,
    };
  }
  if (kind === 'queue') {
    const name = String(spec.name || '');
    const q = queueCandidates().find(x => x.name === name);
    if (!q) throw new Error('Proyecto de cola no encontrado');
    return {
      kind: 'queue', name: q.name, label: q.label, project: q.project,
      exe: q.exe, args: q.args, cwd: q.cwd,
      logOut: q.logOut, logErr: q.logErr,
      autoStart: spec.autoStart !== false,
    };
  }

  const name = String(spec.name || '').trim();
  if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(name)) throw new Error('Nombre de servicio inválido');
  const exe = path.resolve(String(spec.exe || ''));
  if (!fs.existsSync(exe)) throw new Error(`No existe el ejecutable: ${exe}`);
  const args = Array.isArray(spec.args)
    ? spec.args.map(String)
    : String(spec.args || '').trim().split(/\s+/).filter(Boolean);
  const cwd = spec.cwd ? path.resolve(String(spec.cwd)) : path.dirname(exe);
  if (!fs.existsSync(cwd)) throw new Error(`No existe la carpeta de trabajo: ${cwd}`);
  const logDir = spec.logDir ? path.resolve(String(spec.logDir)) : LOG_DIR;
  return {
    kind: 'custom', name,
    label: String(spec.label || name).trim(),
    exe, args, cwd,
    logOut: path.join(logDir, `${slug(name)}.log`),
    logErr: path.join(logDir, `${slug(name)}-error.log`),
    autoStart: spec.autoStart !== false,
  };
}

function nssmCommands(spec, installed = false) {
  const cmds = [];
  if (!installed) cmds.push([NSSM, 'install', spec.name, spec.exe]);
  cmds.push([NSSM, 'set', spec.name, 'Application', spec.exe]);
  cmds.push([NSSM, 'set', spec.name, 'AppParameters', spec.args.join(' ')]);
  cmds.push([NSSM, 'set', spec.name, 'AppDirectory', spec.cwd]);
  cmds.push([NSSM, 'set', spec.name, 'DisplayName', spec.label]);
  cmds.push([NSSM, 'set', spec.name, 'Description', `Laragon Panel: ${spec.label}`]);
  cmds.push([NSSM, 'set', spec.name, 'Start', spec.autoStart ? 'SERVICE_AUTO_START' : 'SERVICE_DEMAND_START']);
  cmds.push([NSSM, 'set', spec.name, 'AppStdout', spec.logOut]);
  cmds.push([NSSM, 'set', spec.name, 'AppStderr', spec.logErr]);
  cmds.push([NSSM, 'set', spec.name, 'AppRotateFiles', '1']);
  cmds.push([NSSM, 'set', spec.name, 'AppRotateOnline', '1']);
  cmds.push([NSSM, 'set', spec.name, 'AppRotateBytes', '10485760']);
  cmds.push([NSSM, 'set', spec.name, 'AppRestartDelay', '5000']);
  if (spec.kind === 'queue' && spec.exe.toLowerCase().endsWith('php.exe')) {
    cmds.push([NSSM, 'set', spec.name, 'AppEnvironmentExtra', `PATH=${win(path.dirname(spec.exe))};%PATH%`]);
  }
  cmds.push([NSSM, 'start', spec.name]);
  return cmds;
}

async function install(specInput) {
  if (!fs.existsSync(NSSM)) throw new Error(`NSSM no encontrado en ${NSSM}`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const spec = buildSpec(specInput);
  const list = await listWindowsServices(true);
  const exists = !!findService(list, spec.name);
  if (exists && !specInput.overwrite) {
    throw new Error(`El servicio ${spec.name} ya existe. Marca "reemplazar" para reinstalarlo.`);
  }

  const cmds = [];
  if (exists) {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    cmds.push([comspec, '/c', actionWrapper(spec.name, 'remove')]);
  }
  cmds.push(...nssmCommands(spec, false));

  const steps = [];
  const admin = await isAdmin();
  let ok = true;
  let error = null;

  if (!admin) {
    const elevated = await runElevated(cmds);
    steps.push(...elevated.steps);
    ok = elevated.ok;
    error = elevated.error;
  } else {
    for (const cmd of cmds) {
      const r = await run(cmd[0], cmd.slice(1), { timeout: 60000 });
      steps.push({ cmd: cmd.join(' '), code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
      if (r.code !== 0) {
        ok = false;
        error = `Falló: ${cmd.slice(1, 3).join(' ')}`;
        break;
      }
    }
  }

  if (!ok) {
    return { ok: false, error: error || 'No se pudo instalar el servicio', steps, elevated: !admin };
  }
  addManaged({ name: spec.name, kind: spec.kind, label: spec.label, addedAt: new Date().toISOString() });
  servicesCache = { at: 0, data: null };
  return { ok: true, service: spec.name, steps, elevated: !admin };
}

function actionWrapper(name, act) {
  const file = path.join(config.dataDir, `svc-${act}-${slug(name)}.cmd`);
  const n = `"${win(NSSM)}"`;
  const lines = ['@echo off'];
  if (act === 'remove') {
    lines.push(`${n} stop ${name} confirm`);
    lines.push('timeout /t 1 /nobreak >nul');
    lines.push(`${n} remove ${name} confirm`);
  } else if (act === 'restart') {
    // Mismo patrón que el manager: stop, esperar, start y reintentar.
    lines.push(`${n} stop ${name} confirm`);
    lines.push('timeout /t 2 /nobreak >nul');
    lines.push(`${n} start ${name}`);
    lines.push('timeout /t 4 /nobreak >nul');
    lines.push(`sc query ${name} | find "RUNNING" >nul && exit /b 0`);
    lines.push(`${n} start ${name}`);
    lines.push('timeout /t 7 /nobreak >nul');
    lines.push(`sc query ${name} | find "RUNNING" >nul && exit /b 0`);
    lines.push(`${n} start ${name}`);
    lines.push('timeout /t 10 /nobreak >nul');
    lines.push(`sc query ${name} | find "RUNNING" >nul`);
  }
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
  return file;
}

async function action(name, act) {
  const safe = String(name || '');
  if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(safe)) throw new Error('Servicio inválido');
  const list = await listWindowsServices(true);
  const svc = findService(list, safe);
  if (!svc) throw new Error('El servicio no está instalado');

  if (act === 'start' && /running/i.test(String(svc.State || ''))) {
    return { ok: true, already: true, steps: [] };
  }
  if (act === 'stop' && /stopped/i.test(String(svc.State || ''))) {
    return { ok: true, already: true, steps: [] };
  }

  const map = {
    start: [NSSM, 'start', safe],
    stop: [NSSM, 'stop', safe, 'confirm'],
    restart: [NSSM, 'restart', safe],
    autostart: [NSSM, 'set', safe, 'Start', 'SERVICE_AUTO_START'],
    manual: [NSSM, 'set', safe, 'Start', 'SERVICE_DEMAND_START'],
    disable: [NSSM, 'set', safe, 'Start', 'SERVICE_DISABLED'],
  };
  let cmd = map[act];
  if (act === 'remove' || act === 'restart') {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const wrapper = actionWrapper(safe, act);
    cmd = [comspec, '/c', wrapper];
  }
  if (!cmd) throw new Error('Acción inválida');
  const admin = await isAdmin();
  let steps = [];
  let ok = true;
  let error = null;

  if (!admin) {
    const elevated = await runElevated([cmd]);
    steps = elevated.steps;
    ok = elevated.ok;
    error = elevated.error;
  } else {
    const r = await run(cmd[0], cmd.slice(1), { timeout: 90000 });
    steps = [{ cmd: cmd.join(' '), code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() }];
    ok = r.code === 0;
    error = ok ? null : (r.stderr || r.stdout || `nssm salió con código ${r.code}`).trim();
  }

  servicesCache = { at: 0, data: null };
  if (act === 'remove' && ok) removeManaged(safe);
  return { ok, error, steps, elevated: !admin };
}

async function serviceLogs(name) {
  const safe = String(name || '');
  const out = await run(NSSM, ['get', safe, 'AppStdout']);
  const err = await run(NSSM, ['get', safe, 'AppStderr']);
  const read = file => {
    try {
      const text = fs.readFileSync(file.trim(), 'utf8');
      return text.split(/\r?\n/).slice(-160).join('\n');
    } catch { return ''; }
  };
  return {
    stdoutFile: out.stdout.trim(),
    stderrFile: err.stdout.trim(),
    stdout: read(out.stdout),
    stderr: read(err.stdout),
  };
}

async function adopt(name) {
  const list = await listWindowsServices();
  const svc = findService(list, name);
  if (!svc) throw new Error('Servicio no encontrado');
  addManaged({
    name: svc.Name, kind: 'existing',
    label: svc.DisplayName || svc.Name,
    addedAt: new Date().toISOString(),
  });
  return { ok: true };
}

async function discover(q = '') {
  const list = await listWindowsServices(true);
  const term = String(q || '').toLowerCase().trim();
  return list
    .filter(s => !term || `${s.Name} ${s.DisplayName}`.toLowerCase().includes(term))
    .slice(0, 200)
    .map(s => ({
      name: s.Name,
      label: s.DisplayName || s.Name,
      status: s.State,
      startMode: s.StartMode,
      path: s.PathName || '',
      laragon: /laragon|redis|queue|backup|apache|mysql/i.test(`${s.Name} ${s.DisplayName} ${s.PathName || ''}`),
    }));
}

module.exports = {
  NSSM,
  overview,
  install,
  action,
  serviceLogs,
  adopt,
  forget: async name => { removeManaged(name); return { ok: true }; },
  discover,
  isAdmin,
  listWindowsServices,
};
