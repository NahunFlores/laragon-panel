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
const laragonStack = require('./laragon-stack');
const STACK_POLICY = require('./stack-policy.json');

const PANEL_DIR = __dirname;
const CONFIG_FILE = path.join(PANEL_DIR, 'panel.config.json');
const RELEASES_URL = 'https://windows.php.net/downloads/releases/';

// Version parcheada minima por rama: CVE-2026-109618 / CVE-2026-109619 ("php2shell").
const PHP_ADVISORY = 'CVE-2026-109618/109619 (php2shell)';
const PHP_PATCHED = STACK_POLICY.components.php.minimumPatched;

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

function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, contents);
  try { fs.renameSync(temp, file); }
  catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function atomicWriteJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isLaragon(dir) {
  return exists(path.join(dir, 'bin', 'apache')) && exists(path.join(dir, 'bin', 'php')) && exists(path.join(dir, 'usr', 'laragon.ini'));
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
  const iniWww = laragonStack.readIniValue(root, 'apache', 'documentroot') || laragonStack.readIniValue(root, 'preferences', 'documentroot');
  const explicit = opt.www || process.env.LARAGON_WWW;
  if (opt.www === true) throw new Error('--www requiere una ruta.');
  if (explicit) return { www: normalize(explicit), iniWww: iniWww ? normalize(iniWww) : '' };

  const candidates = [
    httpdValue(root, apacheFolder, 'LARAGON_WWW'),
    httpdValue(root, apacheFolder, 'documentroot'),
    iniWww,
    path.join(root, 'www'),
  ].filter(Boolean).map(normalize);
  const unique = [...new Map(candidates.map(c => [c.toLowerCase(), c])).values()];
  const selected = unique.find(exists) || unique[0] || normalize(path.join(root, 'www'));
  return { www: selected, iniWww: iniWww ? normalize(iniWww) : '' };
}

function restartApache(root, apacheFolder, panelPort) {
  const apacheBase = path.join(root, 'bin', 'apache', apacheFolder);
  const pid = path.join(apacheBase, 'logs', 'httpd.pid');
  let apachePid = 0;
  try { apachePid = Number(fs.readFileSync(pid, 'utf8').trim()) || 0; } catch {}
  if (!apachePid) {
    note('Apache estaba detenido: arrancalo desde el panel para usar el PHP nuevo');
    return true;
  }
  const processCheck = spawnSync('tasklist.exe', ['/FI', `PID eq ${apachePid}`, '/NH'], { windowsHide: true, encoding: 'utf8' });
  if (processCheck.status !== 0 || !new RegExp(`\\b${apachePid}\\b`).test(processCheck.stdout || '')) {
    note('El PID guardado de Apache estaba obsoleto; no se intentó reiniciar un proceso ajeno');
    return true;
  }
  const httpd = path.join(apacheBase, 'bin', 'httpd.exe');
  const validation = spawnSync(httpd, ['-t', '-d', apacheBase], { cwd: path.join(apacheBase, 'bin'), windowsHide: true, encoding: 'utf8' });
  if (validation.status !== 0) {
    caution(`Apache rechazó la configuración PHP: ${(validation.stderr || validation.stdout || 'httpd -t falló').trim().split(/\r?\n/)[0]}`);
    return false;
  }
  const r = spawnSync(httpd, ['-k', 'restart', '-d', apacheBase], { cwd: path.join(apacheBase, 'bin'), windowsHide: true, encoding: 'utf8' });
  if (r.status === 0) {
    note('Apache reiniciado para cargar el PHP nuevo');
    return true;
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
      return true;
    }
  } catch {}
  const detail = (r.stderr || r.stdout || '').trim().split(/\r?\n/)[0];
  caution(`No pude reiniciar Apache${detail ? ` (${detail})` : ''}; reinicialo desde el panel.`);
  return false;
}

function detectLaragon() {
  const candidates = [];
  const explicit = opt.laragon || process.env.LARAGON_ROOT;
  if (explicit) {
    const dir = normalize(explicit);
    return isLaragon(dir) ? dir : '';
  }
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
  return laragonStack.compareVersions(a, b);
}

function newestPhpFirst(a, b) {
  return comparePatch(b.full, a.full) || laragonStack.compareVersionNames(b.folder, a.folder);
}

function phpInfo(folder) {
  const m = String(folder).match(/^php-(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const base = path.join(currentRoot, 'bin', 'php', folder);
  const branch = `${m[1]}.${m[2]}`;
  const supportEnd = STACK_POLICY.components.php.supportEnds[branch] || '';
  return {
    folder,
    base,
    branch,
    full: `${m[1]}.${m[2]}.${m[3]}`,
    patch: Number(m[3]),
    zts: exists(path.join(base, 'php8ts.dll')),
    modPhp: exists(path.join(base, 'php8apache2_4.dll')),
    x64: /x64/i.test(folder),
    compiler: (folder.match(/-vs(\d+)/i) || [])[1] || '',
    supportEnd,
    supported: !supportEnd || supportEnd >= new Date().toISOString().slice(0, 10),
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
  const re = /href="(php-(\d+)\.(\d+)\.(\d+)(?:-(\d+))?-Win32-vs(16|17)-x64\.zip)"/g;
  let m;
  while ((m = re.exec(html))) {
    const [file, major, minor, patch, build, compiler] = [m[1], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] || 0), m[6]];
    const branch = `${major}.${minor}`;
    const prev = found.get(branch);
    const release = { branch, full: `${major}.${minor}.${patch}`, patch, build, compiler, file, url: RELEASES_URL + file };
    if (!prev || comparePatch(release.full, prev.full) > 0 || (release.full === prev.full && build > prev.build)) found.set(branch, release);
  }
  return found;
}

async function fetchReleaseChecksum(file) {
  const res = await fetch(`${RELEASES_URL}sha256sum.txt`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`No pude obtener SHA-256 (HTTP ${res.status})`);
  const text = await res.text();
  const entry = text.split(/\r?\n/).map(line => line.trim()).find(line => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+?)\s*$/i);
    return match && match[2].trim() === file;
  });
  if (!entry) throw new Error(`windows.php.net no publicó SHA-256 para ${file}`);
  return entry.match(/^([a-f0-9]{64})/i)[1].toLowerCase();
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function extractZip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('tar.exe', ['-xf', zipFile, '-C', destDir], { windowsHide: true });
  if (r.status !== 0) {
    r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${powershellQuote(zipFile)} -DestinationPath ${powershellQuote(destDir)} -Force`], { windowsHide: true });
  }
  return exists(path.join(destDir, 'php.exe'));
}

function buildIni(templateInfo, targetDir, targetFolder) {
  let text = '';
  try { text = fs.readFileSync(path.join(templateInfo.base, 'php.ini'), 'utf8'); } catch { return false; }
  text = text.split(templateInfo.folder).join(targetFolder);
  for (const oldPath of [templateInfo.base, templateInfo.base.replace(/\\/g, '/')]) {
    for (const newPath of [targetDir, targetDir.replace(/\\/g, '/')]) text = text.split(oldPath).join(newPath);
  }
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
  const apacheFolder = laragonStack.apacheFolder(currentRoot);
  if (!apacheFolder) throw new Error('No encontré una versión de Apache para validar PHP.');
  const apacheBase = path.join(currentRoot, 'bin', 'apache', apacheFolder);
  const httpd = path.join(apacheBase, 'bin', 'httpd.exe');
  if (!exists(httpd)) throw new Error(`No existe Apache en ${apacheBase}`);
  const dir = info.base.replace(/\\/g, '/');
  let conf = `# PHP ${info.full} (instalado por el panel)\n`;
  for (const lib of ['libcrypto-3-x64.dll', 'libssl-3-x64.dll']) {
    if (exists(path.join(info.base, lib))) conf += `LoadFile "${dir}/${lib}"\n`;
  }
  conf += `LoadModule php_module "${dir}/php8apache2_4.dll"\nPHPIniDir "${dir}"\n<IfModule mime_module>\n    AddType application/x-httpd-php .php\n</IfModule>\n`;
  if (dryRun) {
    note(`(dry-run) mod_php.conf apuntaria a ${info.folder}`);
    note(`(dry-run) Apache usaria PHP TS ${info.full}, compilador VS${info.compiler || 'no detectado'}, x64`);
  } else {
    const modPhpFile = path.join(currentRoot, 'etc', 'apache2', 'mod_php.conf');
    const laragonIni = path.join(currentRoot, 'usr', 'laragon.ini');
    const oldModPhp = exists(modPhpFile) ? fs.readFileSync(modPhpFile) : null;
    const oldIni = fs.readFileSync(laragonIni);
    try {
      fs.mkdirSync(path.dirname(modPhpFile), { recursive: true });
      fs.writeFileSync(modPhpFile, conf, 'utf8');
      if (!laragonStack.writeIniValue(currentRoot, 'php', 'Version', info.folder)) throw new Error('No pude actualizar laragon.ini');
      const validation = spawnSync(httpd, ['-t', '-d', apacheBase], { cwd: path.join(apacheBase, 'bin'), windowsHide: true, encoding: 'utf8' });
      if (validation.status !== 0) throw new Error(`Apache rechazó PHP ${info.full}: ${(validation.stderr || validation.stdout || 'httpd -t falló').trim()}`);
      if (!restartApache(currentRoot, apacheFolder, opt.port || 9090)) throw new Error(`La configuración pasó httpd -t, pero Apache no pudo reiniciarse con PHP ${info.full}.`);
      note(`PHP configurado: ${info.full} (${info.folder})`);
    } catch (error) {
      if (oldModPhp) fs.writeFileSync(modPhpFile, oldModPhp);
      else try { fs.rmSync(modPhpFile, { force: true }); } catch {}
      fs.writeFileSync(laragonIni, oldIni);
      // Si Apache alcanzó a cargar el nuevo módulo, intentar volver también al PHP previo.
      restartApache(currentRoot, apacheFolder, opt.port || 9090);
      throw error;
    }
  }
}

async function ensurePatchedPhp() {
  if (!withPhp) {
    note('Gestión de PHP omitida (--no-php): no se cambiará ni reiniciará Apache.');
    return;
  }
  const phpDir = path.join(currentRoot, 'bin', 'php');
  const installed = listDirs(phpDir).filter(d => /^php-/.test(d)).map(phpInfo).filter(Boolean);
  const activeFolder = laragonStack.readIniValue(currentRoot, 'php', 'version');
  const active = installed.find(p => p.folder === activeFolder) || installed.slice().sort(newestPhpFirst)[0];

  note(`PHP instalados: ${installed.map(p => `${p.full}${p.zts ? '' : ' sin-zts'}${p.patched ? '' : ' (sin parche conocido)'}${p.supported ? '' : ' (FUERA DE SOPORTE)'}`).join(', ') || 'ninguno'}`);

  const usable = installed.filter(p => p.patched && p.zts && p.modPhp && p.x64 && p.supported);
  const currentBranchOk = usable.filter(p => active && p.branch === active.branch).sort(newestPhpFirst)[0];
  const preferred = forcePhpBranch ? usable.filter(p => p.branch === forcePhpBranch).sort(newestPhpFirst)[0] : null;

  if (preferred || (!forcePhpBranch && (currentBranchOk || usable.length))) {
    const chosen = preferred || currentBranchOk || usable.sort(newestPhpFirst)[0];
    note(`PHP sin vulnerabilidades ya instalado: ${chosen.full} -> se activa`);
    activatePhp(chosen);
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
  const candidates = [...releases.values()].filter(r => {
    const supportEnd = STACK_POLICY.components.php.supportEnds[r.branch];
    return comparePatch(r.full, minimumFor(r.branch)) >= 0 && (!supportEnd || supportEnd >= new Date().toISOString().slice(0, 10));
  });
  if (!candidates.length) {
    caution('No encontre builds parcheados en windows.php.net para ninguna rama. Revisa manualmente.');
    return;
  }
  const chosenForBranch = wantedBranch && candidates.find(c => c.branch === wantedBranch);
  if (forcePhpBranch && !chosenForBranch) {
    caution(`No encontré un build x64 ZTS compatible y parcheado para la rama solicitada PHP ${forcePhpBranch}; no cambiaré la versión activa.`);
    return;
  }
  const chosen = chosenForBranch || candidates.sort((a, b) => comparePatch(b.full, a.full))[0];

  note(`Elegido PHP ${chosen.full} x64 ZTS: ${chosen.url}`);
  if (dryRun) {
    note('(dry-run) no se descarga nada');
    return;
  }

  const zipFile = path.join(os.tmpdir(), chosen.file);
  try {
    const expectedHash = await fetchReleaseChecksum(chosen.file);
    const res = await fetch(chosen.url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = Buffer.from(await res.arrayBuffer());
    const actualHash = crypto.createHash('sha256').update(archive).digest('hex');
    if (actualHash !== expectedHash) throw new Error(`SHA-256 inválido para ${chosen.file}; no se instalará el archivo`);
    fs.writeFileSync(zipFile, archive);
    note(`Descargado ${(fs.statSync(zipFile).size / 1048576).toFixed(1)} MB`);
  } catch (e) {
    caution(`No pude descargar PHP ${chosen.full} (${e.message}).`);
    return;
  }

  const folder = `php-${chosen.full}${chosen.build ? `-${chosen.build}` : ''}-Win32-vs${chosen.compiler}-x64`;
  const target = path.join(phpDir, folder);
  if (exists(target)) {
    caution(`La carpeta destino ya existe pero no fue reconocida como PHP válido: ${target}. No la sobrescribí.`);
    return;
  }
  fs.mkdirSync(phpDir, { recursive: true });
  const staging = path.join(phpDir, `.install-${folder}-${process.pid}`);
  try {
    if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true });
    if (!extractZip(path.join(os.tmpdir(), chosen.file), staging)) throw new Error('el ZIP no contiene php.exe');
    for (const required of ['php.exe', 'php8ts.dll', 'php8apache2_4.dll']) {
      if (!exists(path.join(staging, required))) throw new Error(`falta ${required}`);
    }
    const smoke = spawnSync(path.join(staging, 'php.exe'), ['-v'], { cwd: staging, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (smoke.status !== 0 || !new RegExp(`PHP ${chosen.full.replace(/\./g, '\\.')}`).test(`${smoke.stdout || ''}${smoke.stderr || ''}`)) {
      throw new Error(`php.exe -v falló: ${(smoke.stderr || smoke.stdout || 'sin salida').trim()}`);
    }
    fs.renameSync(staging, target);
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipFile, { force: true }); } catch {}
    caution(`No pude validar e instalar PHP ${chosen.full}: ${e.message}. La versión activa no se modificó.`);
    return;
  }
  try { fs.rmSync(zipFile, { force: true }); } catch {}

  const info = phpInfo(folder);
  if (!info || !info.zts || !info.modPhp) {
    caution(`${folder} no trae php8ts.dll/php8apache2_4.dll: no sirve para mod_php.`);
    return;
  }

  const template = installed.filter(p => p.hasIni).sort(newestPhpFirst)[0];
  if (template) {
    if (!buildIni(template, target, folder)) {
      caution(`No pude copiar php.ini de referencia (${template.full}); el PHP se dejó instalado, pero no se activó.`);
      return;
    }
    note(`php.ini copiado de ${template.full}`);
    const copied = copyExtraExtensions(template, target, info.branch);
    if (copied.length) note(`Extensiones copiadas: ${copied.join(', ')}`);
    if (template.branch !== info.branch) {
      caution(`Cambiaste de rama ${template.branch} a ${info.branch}: revisa sqlsrv/pdo_sqlsrv/redis en el php.ini nuevo.`);
    }
  } else {
    const developmentIni = path.join(target, 'php.ini-development');
    if (exists(developmentIni)) {
      let text = fs.readFileSync(developmentIni, 'utf8');
      text = text.replace(/^;?\s*extension_dir\s*=\s*"?ext"?\s*$/im, 'extension_dir = "ext"');
      fs.writeFileSync(path.join(target, 'php.ini'), text, 'utf8');
      note('php.ini-development copiado como base; revisa extensiones opcionales.');
    } else {
      caution('No se encontró php.ini-development; PHP se dejó instalado y no se activará.');
      return;
    }
  }

  const phpCheck = spawnSync(path.join(target, 'php.exe'), ['-v'], { cwd: target, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (phpCheck.status !== 0 || !/PHP \d+\.\d+\.\d+/i.test(`${phpCheck.stdout || ''}${phpCheck.stderr || ''}`)) {
    caution(`El PHP descargado no pasó php.exe -v (${(phpCheck.stderr || phpCheck.stdout || 'sin salida').trim()}); no se activará.`);
    return;
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
      const supportEnd = STACK_POLICY.components.php.supportEnds[r.branch];
      const eol = supportEnd && supportEnd < new Date().toISOString().slice(0, 10);
      const mark = eol ? 'EOL ' : ok === null ? '?   ' : (ok ? 'OK  ' : 'VULN');
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

  const apacheFolder = laragonStack.apacheFolder(root);
  const mysqlFolder = laragonStack.mysqlFolder(root);
  const picked = pickWww(root, apacheFolder);
  const www = picked.www;
  note(`Proyectos (www): ${www}${exists(www) ? '' : '  (no existe todavia)'}`);
  if (picked.iniWww && picked.iniWww.toLowerCase() !== www.toLowerCase()) {
    note(`DocumentRoot de laragon.ini apunta a ${picked.iniWww}; el panel usara ${www} (${Math.max(countProjects(www), 0)} carpetas)`);
  }
  note(`Apache: ${apacheFolder || 'no detectado'}`);
  note(`MySQL: ${mysqlFolder || 'no detectado'}`);
  if (!exists(path.join(root, 'bin', 'apache', apacheFolder, 'conf', 'httpd.conf'))) caution('No veo httpd.conf en la version de Apache detectada.');

  const panelPortArg = opt.port !== undefined ? opt.port : opt['panel-port'];
  const lanPortArg = opt['lan-port'];
  if (panelPortArg === true || lanPortArg === true) throw new Error('--port y --lan-port necesitan un número.');
  const port = Number(panelPortArg || 9090);
  const lanPort = Number(lanPortArg || 9091);
  const myPort = Number(opt.mysql && opt.mysql !== true ? opt.mysql : laragonStack.readIniValue(root, 'mysql', 'port') || 3306);
  for (const [label, value] of [['panel', port], ['LAN', lanPort], ['MySQL', myPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Puerto ${label} inválido: ${value}`);
  }
  if (port === lanPort) throw new Error('El puerto local y el puerto LAN del panel deben ser distintos.');
  if (opt.mysql === true) throw new Error('Usa --mysql <puerto>; no se indicó un número de puerto.');
  note(`MySQL puerto: ${myPort}`);
  note(`Panel: 127.0.0.1:${port}  |  LAN: 0.0.0.0:${lanPort}`);

  await ensurePatchedPhp();

  const explicitWww = !!(opt.www || process.env.LARAGON_WWW);
  const config = {
    laragonRoot: root,
    wwwRoot: www,
    wwwRootMode: explicitWww ? 'fixed' : 'auto',
    mysqlPortMode: opt.mysql ? 'fixed' : 'auto',
    apachePortMode: 'auto',
    panelPort: port,
    lanPort,
    codePath: String(opt.code || '').trim(),
    wtPath: String(opt.wt || '').trim(),
    legacyDumps: String(opt['legacy-dumps'] || '').trim(),
  };
  if (opt.mysql) config.mysqlPort = myPort;

  let previous = null;
  let configReadError = null;
  try { previous = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (error) { if (exists(CONFIG_FILE)) configReadError = error; }
  if (configReadError && !forceConfig) {
    throw new Error(`panel.config.json existe pero no es JSON válido (${configReadError.message}). No lo sobrescribí; respáldalo/repara el archivo o usa --force conscientemente.`);
  }

  let migratedConfig = false;
  if (previous) {
    const oldRoot = previous.laragonRoot || root;
    const oldWww = previous.wwwRoot
      ? (path.isAbsolute(String(previous.wwwRoot)) ? normalize(previous.wwwRoot) : normalize(path.join(oldRoot, String(previous.wwwRoot))) )
      : '';
    if (!previous.wwwRootMode) {
      previous.wwwRootMode = !oldWww || oldWww.toLowerCase() === normalize(path.join(oldRoot, 'www')).toLowerCase() ? 'auto' : 'fixed';
      migratedConfig = true;
    }
    if (!previous.mysqlPortMode) {
      const oldIniPort = Number(laragonStack.readIniValue(oldRoot, 'mysql', 'Port')) || 0;
      previous.mysqlPortMode = previous.mysqlPort === undefined || previous.mysqlPort === oldIniPort || [3306, 3308].includes(Number(previous.mysqlPort)) ? 'auto' : 'fixed';
      migratedConfig = true;
    }
    if (!previous.apachePortMode) {
      const oldIniPort = Number(laragonStack.readIniValue(oldRoot, 'apache', 'Port')) || 0;
      previous.apachePortMode = previous.apachePort === undefined || previous.apachePort === oldIniPort || Number(previous.apachePort) === 80 ? 'auto' : 'fixed';
      migratedConfig = true;
    }
  }

  if (dryRun) {
    note('Modo --dry-run: no se escribe panel.config.json.');
  } else if (previous && !forceConfig) {
    let changed = migratedConfig;
    for (const [k, v] of Object.entries(config)) {
      if (previous[k] === undefined || previous[k] === '') { previous[k] = v; changed = true; }
    }
    if (opt.laragon || process.env.LARAGON_ROOT || !isLaragon(previous.laragonRoot || '')) {
      if (previous.laragonRoot !== root) { previous.laragonRoot = root; changed = true; }
    }
    if (explicitWww) { previous.wwwRoot = www; previous.wwwRootMode = 'fixed'; changed = true; }
    else if (previous.wwwRootMode === 'auto' && previous.wwwRoot !== www) { previous.wwwRoot = www; changed = true; }
    if (opt.mysql) { previous.mysqlPort = myPort; previous.mysqlPortMode = 'fixed'; changed = true; }
    else if (previous.mysqlPortMode === 'auto' && previous.mysqlPort !== undefined) { delete previous.mysqlPort; changed = true; }
    if (opt.port !== undefined || opt['panel-port'] !== undefined) { previous.panelPort = port; changed = true; }
    if (opt['lan-port'] !== undefined) { previous.lanPort = lanPort; changed = true; }
    if (previous.apachePortMode === 'auto' && previous.apachePort !== undefined) { delete previous.apachePort; changed = true; }
    if (changed) atomicWriteJson(CONFIG_FILE, previous);
    note(`panel.config.json ya existia: ${changed ? 'se completaron claves que faltaban' : 'sin cambios'}`);
    note(`Configuracion efectiva: ${JSON.stringify(previous)}`);
  } else {
    if (forceConfig && exists(CONFIG_FILE)) {
      const backup = `${CONFIG_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(CONFIG_FILE, backup);
      note(`Configuración anterior respaldada en ${backup}`);
    }
    atomicWriteJson(CONFIG_FILE, config);
    note('Configuracion escrita en panel.config.json');
  }

  const lanKey = path.join(PANEL_DIR, 'lan-key.txt');
  if (!exists(lanKey)) {
    if (!dryRun) atomicWrite(lanKey, crypto.randomBytes(24).toString('hex'));
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
