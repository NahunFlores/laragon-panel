#!/usr/bin/env node
'use strict';

/*
 * Instalador del Laragon Panel.
 *
 * Uso:
 *   node instalar.js                              (autodetecta Laragon)
 *   node instalar.js --laragon D:/Laragon
 *   node instalar.js --laragon D:/Laragon --www D:/Laragon/www --port 9090
 *   node instalar.js --dry-run                    (solo informa, no escribe)
 *   node instalar.js --php 8.3                    (fuerza una rama de PHP)
 *   node instalar.js --no-php                     (no toca PHP)
 *
 * Busca siempre una version de PHP sin vulnerabilidades conocidas: si la
 * instalada es anterior a la parcheada, descarga e instala la ultima version
 * x64 ZTS con mod_php y la deja activa.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PANEL_DIR = __dirname;
const CONFIG_FILE = path.join(PANEL_DIR, 'panel.config.json');
const RELEASES_URL = 'https://windows.php.net/downloads/releases/';

// Version parcheada minima por rama: CVE-2026-109618 / CVE-2026-109619 ("php2shell").
const PHP_ADVISORY = 'CVE-2026-109618/109619 (php2shell)';
const PHP_PATCHED = { '8.1': '8.1.34', '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12' };

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const opt = args(process.argv.slice(2));
const dryRun = !!opt['dry-run'] || !!opt.dry;
const withElectron = !opt['no-electron'];
const withPhp = !opt['no-php'];
const forcePhpBranch = opt.php && opt.php !== true ? String(opt.php) : '';
const forceConfig = !!opt.force;

const steps = [];
const warn = [];
const note = s => steps.push(s);
const caution = s => warn.push(s);

function normalize(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function isLaragon(dir) {
  return exists(path.join(dir, 'bin', 'apache')) && exists(path.join(dir, 'bin', 'php')) && exists(path.join(dir, 'usr', 'laragon.ini'));
}

function iniValue(root, section, key) {
  try {
    const text = fs.readFileSync(path.join(root, 'usr', 'laragon.ini'), 'utf8');
    let current = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const sec = line.match(/^\[([^\]]+)\]/);
      if (sec) { current = sec[1].toLowerCase(); continue; }
      if (current !== section.toLowerCase()) continue;
      const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
      if (kv && kv[1].trim().toLowerCase() === key.toLowerCase()) return kv[2].trim();
    }
  } catch {}
  return '';
}

function setIniValue(iniPath, section, key, value) {
  let text = '';
  try { text = fs.readFileSync(iniPath, 'utf8'); } catch { return false; }
  const secRe = new RegExp(`\\[${section}\\]`, 'i');
  const secMatch = text.match(secRe);
  if (!secMatch) {
    text += `\n[${section}]\n${key}=${value}\n`;
  } else {
    const start = text.indexOf(secMatch[0]);
    const rest = text.slice(start + secMatch[0].length);
    const nextSec = rest.search(/\r?\n\s*\[/);
    const block = nextSec === -1 ? rest : rest.slice(0, nextSec);
    const kvRe = new RegExp(`^\\s*${key}\\s*=.*$`, 'im');
    const replaced = kvRe.test(block)
      ? block.replace(kvRe, `${key}=${value}`)
      : `${block.replace(/\s*$/, '')}\r\n${key}=${value}\r\n`;
    text = text.slice(0, start + secMatch[0].length) + replaced + (nextSec === -1 ? '' : rest.slice(nextSec));
  }
  fs.writeFileSync(iniPath, text, 'utf8');
  return true;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}

function httpdValue(root, apacheFolder, key) {
  try {
    const conf = path.join(root, 'bin', 'apache', apacheFolder, 'conf', 'httpd.conf');
    const text = fs.readFileSync(conf, 'utf8');
    if (key === 'documentroot') {
      const m = text.match(/^\s*DocumentRoot\s+"?([^"\r\n]+)"?/im);
      return m ? m[1].trim() : '';
    }
    const m = text.match(new RegExp(`^\\s*Define\\s+${key}\\s+"?([^"\\r\\n]+)"?`, 'im'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function countProjects(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).length;
  } catch { return -1; }
}

function pickWww(root, apacheFolder) {
  const iniWww = iniValue(root, 'apache', 'documentroot') || iniValue(root, 'preferences', 'documentroot');
  const candidates = [
    opt.www,
    process.env.LARAGON_WWW,
    httpdValue(root, apacheFolder, 'LARAGON_WWW'),
    httpdValue(root, apacheFolder, 'documentroot'),
    iniWww,
    path.join(root, 'www'),
  ].filter(Boolean).map(normalize);

  const unique = [...new Set(candidates.map(c => c.toLowerCase()))];
  let best = null;
  for (const low of unique) {
    const dir = candidates.find(c => c.toLowerCase() === low);
    const score = exists(dir) ? countProjects(dir) : -2;
    if (!best || score > best.score) best = { dir, score };
  }
  return { www: best ? best.dir : normalize(path.join(root, 'www')), iniWww: iniWww ? normalize(iniWww) : '' };
}

function restartApache(root, apacheFolder, panelPort) {
  const apacheBase = path.join(root, 'bin', 'apache', apacheFolder);
  const pid = path.join(apacheBase, 'logs', 'httpd.pid');
  if (!exists(pid)) {
    note('Apache estaba detenido: arrancalo desde el panel para usar el PHP nuevo');
    return;
  }
  const r = spawnSync(path.join(apacheBase, 'bin', 'httpd.exe'), ['-k', 'restart'], { cwd: apacheBase, windowsHide: true, encoding: 'utf8' });
  if (r.status === 0) {
    note('Apache reiniciado para cargar el PHP nuevo');
    return;
  }
  // Alternativa: pedirselo al panel si ya esta corriendo.
  const port = Number(panelPort) || 9090;
  try {
    const payload = JSON.stringify({ name: 'apache', action: 'restart' });
    const res = spawnSync(process.execPath, ['-e', `
      fetch('http://127.0.0.1:${port}/api/service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(payload)}, signal: AbortSignal.timeout(120000) })
        .then(r => r.json()).then(j => { console.log(j && j.ok ? 'ok' : 'no'); }).catch(() => { console.log('no'); process.exit(1); });
    `], { windowsHide: true, encoding: 'utf8' });
    if ((res.stdout || '').trim() === 'ok') {
      note('Apache reiniciado a traves del panel');
      return;
    }
  } catch {}
  const detail = (r.stderr || r.stdout || '').trim().split(/\r?\n/)[0];
  caution(`No pude reiniciar Apache${detail ? ` (${detail})` : ''}; reinicialo desde el panel.`);
}

function detectLaragon() {
  const candidates = [];
  if (opt.laragon) candidates.push(String(opt.laragon));
  if (process.env.LARAGON_ROOT) candidates.push(process.env.LARAGON_ROOT);
  const home = os.homedir();
  for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
    candidates.push(`${drive}/laragon`, `${drive}/Laragon`, `${drive}/appsDevs/laragon`, `${drive}/dev/laragon`, `${drive}/DEV/laragon`, `${drive}/tools/laragon`);
  }
  candidates.push(path.join(home, 'laragon'));
  try {
    const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    for (const name of fs.readdirSync(startMenu)) {
      if (!/laragon/i.test(name) || !name.endsWith('.lnk')) continue;
      const raw = fs.readFileSync(path.join(startMenu, name)).toString('latin1');
      const m = raw.match(/[A-Za-z]:\\\\?[^\u0000"]*?laragon\.exe/i) || raw.match(/[A-Za-z]:\\[^\u0000"]{3,80}/);
      if (m) candidates.push(path.dirname(m[0].replace(/\\\\/g, '\\')));
    }
  } catch {}

  const seen = new Set();
  for (const c of candidates) {
    if (!c) continue;
    const dir = normalize(c);
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    if (isLaragon(dir)) return dir;
  }
  return '';
}

function comparePatch(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function phpInfo(folder) {
  const m = String(folder).match(/^php-(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const base = path.join(currentRoot, 'bin', 'php', folder);
  return {
    folder,
    base,
    branch: `${m[1]}.${m[2]}`,
    full: `${m[1]}.${m[2]}.${m[3]}`,
    patch: Number(m[3]),
    zts: exists(path.join(base, 'php8ts.dll')),
    modPhp: exists(path.join(base, 'php8apache2_4.dll')),
    hasIni: exists(path.join(base, 'php.ini')),
    patched: PHP_PATCHED[`${m[1]}.${m[2]}`] ? comparePatch(`${m[1]}.${m[2]}.${m[3]}`, PHP_PATCHED[`${m[1]}.${m[2]}`]) >= 0 : false,
  };
}

let currentRoot = '';

async function fetchReleases() {
  const res = await fetch(RELEASES_URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const found = new Map();
  const re = /href="(php-(\d+)\.(\d+)\.(\d+)(?:-\d+)?-Win32-vs1[67]-x64\.zip)"/g;
  let m;
  while ((m = re.exec(html))) {
    const [file, major, minor, patch] = [m[1], Number(m[2]), Number(m[3]), Number(m[4])];
    const branch = `${major}.${minor}`;
    const prev = found.get(branch);
    if (!prev || patch > prev.patch) found.set(branch, { branch, full: `${major}.${minor}.${patch}`, patch, file, url: RELEASES_URL + file });
  }
  return found;
}

function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('tar.exe', ['-xf', zipFile, '-C', destDir], { windowsHide: true });
  if (r.status !== 0) {
    r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`], { windowsHide: true });
  }
  return exists(path.join(destDir, 'php.exe'));
}

function buildIni(templateInfo, targetDir, targetFolder) {
  let text = '';
  try { text = fs.readFileSync(path.join(templateInfo.base, 'php.ini'), 'utf8'); } catch { return false; }
  text = text.split(templateInfo.folder).join(targetFolder);
  text = text.split(templateInfo.base.replace(/\\/g, '/')).join(targetDir.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(targetDir, 'php.ini'), text, 'utf8');
  return true;
}

function copyExtraExtensions(fromInfo, toDir, targetBranch) {
  if (!fromInfo || fromInfo.branch !== targetBranch) return [];
  const copied = [];
  const srcExt = path.join(fromInfo.base, 'ext');
  const dstExt = path.join(toDir, 'ext');
  try {
    for (const f of fs.readdirSync(srcExt)) {
      if (!/^(php_(pdo_)?sqlsrv|php_redis|php_imagick|php_xdebug).*\.dll$/i.test(f)) continue;
      if (exists(path.join(dstExt, f))) continue;
      fs.copyFileSync(path.join(srcExt, f), path.join(dstExt, f));
      copied.push(f);
    }
  } catch {}
  return copied;
}

function activatePhp(info) {
  const apacheFolder = iniValue(currentRoot, 'apache', 'version') || listDirs(path.join(currentRoot, 'bin', 'apache')).sort().pop();
  const apacheBase = path.join(currentRoot, 'bin', 'apache', apacheFolder);
  const dir = info.base.replace(/\\/g, '/');
  let conf = `# PHP ${info.full} (instalado por el panel)\n`;
  for (const lib of ['libcrypto-3-x64.dll', 'libssl-3-x64.dll']) {
    if (exists(path.join(info.base, lib))) conf += `LoadFile "${dir}/${lib}"\n`;
  }
  conf += `LoadModule php_module "${dir}/php8apache2_4.dll"\nPHPIniDir "${dir}"\n<IfModule mime_module>\n    AddType application/x-httpd-php .php\n</IfModule>\n`;
  if (dryRun) {
    note(`(dry-run) mod_php.conf apuntaria a ${info.folder}`);
  } else {
    fs.writeFileSync(path.join(currentRoot, 'etc', 'apache2', 'mod_php.conf'), conf, 'utf8');
    setIniValue(path.join(currentRoot, 'usr', 'laragon.ini'), 'php', 'Version', info.folder);
    note(`PHP activo: ${info.full} (${info.folder})`);
  }

  // Reinicia Apache solo si esta corriendo, para que tome el cambio.
  if (!dryRun) restartApache(currentRoot, apacheFolder, opt.port || 9090);
}

async function ensurePatchedPhp() {
  const phpDir = path.join(currentRoot, 'bin', 'php');
  const installed = listDirs(phpDir).filter(d => /^php-/.test(d)).map(phpInfo).filter(Boolean);
  const activeFolder = iniValue(currentRoot, 'php', 'version');
  const active = installed.find(p => p.folder === activeFolder) || installed.slice().sort((a, b) => comparePatch(b.full, a.full))[0];

  note(`PHP instalados: ${installed.map(p => `${p.full}${p.zts ? '' : ' sin-zts'}${p.patched ? '' : ' (VULNERABLE)'}`).join(', ') || 'ninguno'}`);

  const usable = installed.filter(p => p.patched && p.zts && p.modPhp);
  const currentBranchOk = usable.filter(p => active && p.branch === active.branch).sort((a, b) => comparePatch(b.full, a.full))[0];
  const preferred = forcePhpBranch ? usable.filter(p => p.branch === forcePhpBranch).sort((a, b) => comparePatch(b.full, a.full))[0] : null;

  if (preferred || currentBranchOk || usable.length) {
    const chosen = preferred || currentBranchOk || usable.sort((a, b) => comparePatch(b.full, a.full))[0];
    note(`PHP sin vulnerabilidades ya instalado: ${chosen.full} -> se activa`);
    activatePhp(chosen);
    return;
  }

  if (!withPhp) {
    caution(`Ninguna version PHP instalada esta parcheada contra ${PHP_ADVISORY} (se omitio por --no-php).`);
    return;
  }

  note('Ninguna version PHP instalada esta parcheada: se busca la ultima en windows.php.net');
  let releases;
  try {
    releases = await fetchReleases();
  } catch (e) {
    caution(`No pude consultar windows.php.net (${e.message}). Instala PHP x64 ZTS parcheado a mano.`);
    return;
  }

  const wantedBranch = forcePhpBranch || (active && releases.has(active.branch) ? active.branch : '');
  const minimumFor = b => PHP_PATCHED[b] || '0.0.0';
  const candidates = [...releases.values()].filter(r => comparePatch(r.full, minimumFor(r.branch)) >= 0);
  if (!candidates.length) {
    caution('No encontre builds parcheados en windows.php.net para ninguna rama. Revisa manualmente.');
    return;
  }
  const chosen = (wantedBranch && candidates.find(c => c.branch === wantedBranch))
    || candidates.sort((a, b) => comparePatch(b.full, a.full))[0];

  note(`Elegido PHP ${chosen.full} x64 ZTS: ${chosen.url}`);
  if (dryRun) {
    note('(dry-run) no se descarga nada');
    return;
  }

  const zipFile = path.join(os.tmpdir(), chosen.file);
  try {
    const res = await fetch(chosen.url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fs.writeFileSync(zipFile, Buffer.from(await res.arrayBuffer()));
    note(`Descargado ${(fs.statSync(zipFile).size / 1048576).toFixed(1)} MB`);
  } catch (e) {
    caution(`No pude descargar PHP ${chosen.full} (${e.message}).`);
    return;
  }

  const folder = `php-${chosen.full}-Win32-vs16-x64`;
  const target = path.join(phpDir, folder);
  if (!exists(path.join(target, 'php.exe'))) {
    if (!extractZip(zipFile, target)) {
      caution('No pude extraer el ZIP de PHP.');
      return;
    }
  }
  try { fs.rmSync(zipFile, { force: true }); } catch {}

  const info = phpInfo(folder);
  if (!info || !info.zts || !info.modPhp) {
    caution(`${folder} no trae php8ts.dll/php8apache2_4.dll: no sirve para mod_php.`);
    return;
  }

  const template = installed.filter(p => p.hasIni).sort((a, b) => comparePatch(b.full, a.full))[0];
  if (template) {
    buildIni(template, target, folder);
    note(`php.ini copiado de ${template.full}`);
    const copied = copyExtraExtensions(template, target, info.branch);
    if (copied.length) note(`Extensiones copiadas: ${copied.join(', ')}`);
    if (template.branch !== info.branch) {
      caution(`Cambiaste de rama ${template.branch} a ${info.branch}: revisa sqlsrv/pdo_sqlsrv/redis en el php.ini nuevo.`);
    }
  } else {
    caution('No habia php.ini de referencia: copia php.ini-development a php.ini y ajusta extension_dir.');
  }

  activatePhp(info);
  note(`PHP ${info.full} instalado en ${target}`);
}

async function main() {
  if (opt['check-php']) {
    const releases = await fetchReleases();
    console.log('Builds x64 ZTS disponibles en windows.php.net (parcheados o no):');
    for (const r of [...releases.values()].sort((a, b) => comparePatch(b.full, a.full))) {
      const min = PHP_PATCHED[r.branch];
      const ok = min ? comparePatch(r.full, min) >= 0 : null;
      const mark = ok === null ? '?   ' : (ok ? 'OK  ' : 'VULN');
      console.log(` ${mark} ${r.branch}  ${r.full}  ${r.file}`);
    }
    return;
  }

  const root = detectLaragon();
  if (!root) {
    console.error('No encontre una instalacion de Laragon.');
    console.error('Indica la carpeta a mano: node instalar.js --laragon D:/ruta/de/laragon');
    process.exit(1);
  }
  currentRoot = root;
  note(`Laragon: ${root}`);

  const apacheFolder = iniValue(root, 'apache', 'version') || listDirs(path.join(root, 'bin', 'apache')).sort().pop() || '';
  const mysqlFolder = iniValue(root, 'mysql', 'version') || listDirs(path.join(root, 'bin', 'mysql')).sort().pop() || '';
  const picked = pickWww(root, apacheFolder);
  const www = picked.www;
  note(`Proyectos (www): ${www}${exists(www) ? '' : '  (no existe todavia)'}`);
  if (picked.iniWww && picked.iniWww.toLowerCase() !== www.toLowerCase()) {
    note(`DocumentRoot de laragon.ini apunta a ${picked.iniWww}; el panel usara ${www} (${Math.max(countProjects(www), 0)} carpetas)`);
  }
  note(`Apache: ${apacheFolder || 'no detectado'}`);
  note(`MySQL: ${mysqlFolder || 'no detectado'}`);
  if (!exists(path.join(root, 'bin', 'apache', apacheFolder, 'conf', 'httpd.conf'))) caution('No veo httpd.conf en la version de Apache detectada.');

  const port = Number(opt.port || opt['panel-port'] || 9090);
  const lanPort = Number(opt['lan-port'] || 9091);
  const myPort = Number(opt.mysql || iniValue(root, 'mysql', 'port') || 3306);
  note(`MySQL puerto: ${myPort}`);
  note(`Panel: 127.0.0.1:${port}  |  LAN: 0.0.0.0:${lanPort}`);

  await ensurePatchedPhp();

  const config = {
    laragonRoot: root,
    wwwRoot: www,
    mysqlPort: myPort,
    panelPort: port,
    lanPort,
    codePath: String(opt.code || '').trim(),
    wtPath: String(opt.wt || '').trim(),
    legacyDumps: String(opt['legacy-dumps'] || '').trim(),
  };

  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

  if (dryRun) {
    note('Modo --dry-run: no se escribe panel.config.json.');
  } else if (previous && !forceConfig) {
    let changed = false;
    for (const [k, v] of Object.entries(config)) {
      if (previous[k] === undefined || previous[k] === '') { previous[k] = v; changed = true; }
    }
    if (changed) fs.writeFileSync(CONFIG_FILE, JSON.stringify(previous, null, 2) + '\n', 'utf8');
    note(`panel.config.json ya existia: ${changed ? 'se completaron claves que faltaban' : 'sin cambios'}`);
    note(`Configuracion efectiva: ${JSON.stringify(previous)}`);
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
    note('Configuracion escrita en panel.config.json');
  }

  const lanKey = path.join(PANEL_DIR, 'lan-key.txt');
  if (!exists(lanKey)) {
    if (!dryRun) fs.writeFileSync(lanKey, crypto.randomBytes(5).toString('hex'), 'utf8');
    note('Clave LAN generada en lan-key.txt');
  } else {
    note('Clave LAN ya existente (lan-key.txt)');
  }

  if (withElectron) {
    const installedElectron = exists(path.join(PANEL_DIR, 'electron-app', 'node_modules', 'electron'));
    if (installedElectron) note('App Electron: dependencias ya instaladas');
    else if (dryRun) note('App Electron: faltan dependencias (se instalarian con npm install)');
    else {
      console.log('\nInstalando dependencias de la app Electron (puede tardar unos minutos)...');
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: path.join(PANEL_DIR, 'electron-app'), stdio: 'inherit' });
      note(r.status === 0 ? 'App Electron: dependencias instaladas' : 'App Electron: npm install fallo, ejecutalo a mano dentro de electron-app');
    }
  } else {
    note('App Electron: omitida (--no-electron)');
  }

  console.log('\n=== Resumen ===');
  for (const s of steps) console.log(` - ${s}`);
  if (warn.length) {
    console.log('\n=== Avisos ===');
    for (const w of warn) console.log(` ! ${w}`);
  }
  console.log('\n=== Como arrancar ===');
  console.log(' Panel web:      iniciar-panel.vbs  (o: node server.js)');
  console.log(' App escritorio: electron-app\\node_modules\\electron\\dist\\electron.exe electron-app');
  console.log(` Abrir:          http://127.0.0.1:${port}`);
  console.log(` LAN:            http://<tu-ip>:${lanPort}  (clave en lan-key.txt)`);
  console.log('');
}

main().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
