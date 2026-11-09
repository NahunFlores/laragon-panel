'use strict';

const fs = require('fs');
const path = require('path');

let POLICY = {};
try { POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'stack-policy.json'), 'utf8')); } catch {}

function iniFile(root) {
  return path.join(root, 'usr', 'laragon.ini');
}

function readIniValue(root, section, key) {
  let text;
  try { text = fs.readFileSync(iniFile(root), 'utf8'); } catch { return ''; }
  let current = '';
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(/^\[([^\]]+)\]$/);
    if (match) { current = match[1].trim().toLowerCase(); continue; }
    if (current !== String(section).toLowerCase() || !line || /^[;#]/.test(line)) continue;
    const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (pair && pair[1].trim().toLowerCase() === String(key).toLowerCase()) return pair[2].trim();
  }
  return '';
}

function writeIniValue(root, section, key, value) {
  const file = iniFile(root);
  const original = fs.readFileSync(file, 'utf8');
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sectionName = String(section).toLowerCase();
  const keyName = String(key).toLowerCase();
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^\[([^\]]+)\]$/);
    if (!match) continue;
    if (start >= 0) { end = i; break; }
    if (match[1].trim().toLowerCase() === sectionName) start = i;
  }
  if (start < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`, `${key}=${value}`);
  } else {
    let found = -1;
    for (let i = start + 1; i < end; i++) {
      const pair = lines[i].match(/^\s*([^=]+?)\s*=/);
      if (pair && pair[1].trim().toLowerCase() === keyName) { found = i; break; }
    }
    if (found >= 0) lines[found] = `${key}=${value}`;
    else lines.splice(end, 0, `${key}=${value}`);
  }

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${bom}${lines.join(newline)}`, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
  return true;
}

function numericParts(text) {
  return (String(text).match(/\d+/g) || []).map(Number);
}

function compareVersions(a, b) {
  const left = numericParts(a);
  const right = numericParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return String(a).localeCompare(String(b));
}

function compareVersionNames(a, b) {
  const parse = value => {
    const match = String(value).match(/(\d+\.\d+\.\d+)(?:-(\d+))?/);
    return match ? { version: match[1], build: Number(match[2] || 0) } : { version: '', build: 0 };
  };
  const left = parse(a);
  const right = parse(b);
  const byVersion = compareVersions(left.version, right.version);
  if (byVersion) return byVersion;
  if (left.build !== right.build) return left.build - right.build;
  return String(a).localeCompare(String(b));
}

function versionDirs(root, prefix, executable) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map(entry => entry.name)
      .filter(name => !executable || fs.existsSync(path.join(root, name, executable)))
      .sort(compareVersionNames);
  } catch {}
  return dirs;
}

function selectVersionDir(root, prefix, iniVersion, executable) {
  const dirs = versionDirs(root, prefix, executable);
  if (iniVersion) {
    const exact = dirs.find(name => name.toLowerCase() === String(iniVersion).toLowerCase());
    if (exact) return exact;
  }
  return dirs[dirs.length - 1] || '';
}

function apacheFolder(root, override = '') {
  return selectVersionDir(path.join(root, 'bin', 'apache'), 'httpd-', override || readIniValue(root, 'apache', 'version'), path.join('bin', 'httpd.exe'));
}

function mysqlFolder(root, override = '') {
  return selectVersionDir(path.join(root, 'bin', 'mysql'), 'mysql-', override || readIniValue(root, 'mysql', 'version'), path.join('bin', 'mysqld.exe'));
}

function phpFolder(root) {
  return selectVersionDir(path.join(root, 'bin', 'php'), 'php-', readIniValue(root, 'php', 'version'), 'php.exe');
}

function phpVersions(root) {
  const base = path.join(root, 'bin', 'php');
  return versionDirs(base, 'php-', 'php.exe').map(folder => {
    const match = folder.match(/^php-(\d+\.\d+\.\d+)/i);
    const full = match ? match[1] : folder;
    const branchMatch = full.match(/^(\d+\.\d+)/);
    const dir = path.join(base, folder);
    return {
      folder,
      full,
      branch: branchMatch ? branchMatch[1] : folder,
      base: dir,
      exe: path.join(dir, 'php.exe'),
      ini: path.join(dir, 'php.ini'),
      ts: fs.existsSync(path.join(dir, 'php8ts.dll')),
      apache: fs.existsSync(path.join(dir, 'php8apache2_4.dll')),
      x64: /x64/i.test(folder),
      compiler: (folder.match(/-vs(\d+)/i) || [])[1] || '',
    };
  });
}

function apachePhpFolder(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'etc', 'apache2', 'mod_php.conf'), 'utf8');
    const match = text.match(/[\\/]bin[\\/]php[\\/](php-[^\\/"\s]+)/i);
    return match ? match[1] : '';
  } catch { return ''; }
}

function findRedis(root, configuredPath = '') {
  if (configuredPath && fs.existsSync(configuredPath)) {
    try { if (fs.statSync(configuredPath).isFile()) return configuredPath; } catch {}
  }
  const base = path.join(root, 'bin', 'redis');
  const direct = path.join(base, 'redis-server.exe');
  if (fs.existsSync(direct)) return direct;
  const dirs = versionDirs(base, 'redis-').reverse();
  for (const dir of dirs) {
    const exe = path.join(base, dir, 'redis-server.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

function redisPort(root, configuredPath = '') {
  const exe = findRedis(root, configuredPath);
  if (!exe) return 6379;
  const conf = path.join(path.dirname(exe), 'redis.windows.conf');
  try {
    const text = fs.readFileSync(conf, 'utf8');
    const match = text.match(/^\s*port\s+(\d+)\s*(?:#.*)?$/im);
    const port = match ? Number(match[1]) : 0;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 6379;
  } catch { return 6379; }
}

function readLastLoadedPhp(root, apacheOverride = '') {
  const apache = apacheOverride || apacheFolder(root);
  if (!apache) return '';
  const log = path.join(root, 'bin', 'apache', apache, 'logs', 'error_log');
  try {
    const stat = fs.statSync(log);
    const size = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(log, 'r');
    try { fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size)); }
    finally { fs.closeSync(fd); }
    const text = buffer.toString('utf8');
    const matches = [...text.matchAll(/Apache\/[^\s]+(?:\s+\([^)]*\))?\s+PHP\/(\d+\.\d+\.\d+) configured/g)];
    return matches.length ? matches[matches.length - 1][1] : '';
  } catch { return ''; }
}

function stackSnapshot(root, redisPath = '', runtime = {}) {
  const configuredApache = apacheFolder(root);
  const configuredMysql = mysqlFolder(root);
  const apache = runtime.apacheFolder || configuredApache;
  const mysql = runtime.mysqlFolder || configuredMysql;
  const phpIniFolder = phpFolder(root);
  const phpApacheFolder = apachePhpFolder(root);
  const php = phpVersions(root);
  const selectedPhp = folder => php.find(item => item.folder === folder) || null;
  const loadedPhp = readLastLoadedPhp(root, apache);
  const redis = findRedis(root, redisPath);
  const warnings = [];
  if (phpIniFolder && phpApacheFolder && phpIniFolder.toLowerCase() !== phpApacheFolder.toLowerCase()) {
    warnings.push(`PHP no coincide: laragon.ini usa ${phpIniFolder}, mod_php.conf usa ${phpApacheFolder}.`);
  }
  if (loadedPhp && phpApacheFolder && !phpApacheFolder.includes(loadedPhp)) {
    warnings.push(`El último arranque de Apache registró PHP ${loadedPhp}, pero mod_php.conf apunta a ${phpApacheFolder}.`);
  }
  if (phpIniFolder && !selectedPhp(phpIniFolder)) warnings.push(`El PHP seleccionado en laragon.ini no existe: ${phpIniFolder}.`);
  if (apache && !fs.existsSync(path.join(root, 'bin', 'apache', apache, 'conf', 'httpd.conf'))) warnings.push(`No se encontró httpd.conf para ${apache}.`);
  if (mysql && !fs.existsSync(path.join(root, 'bin', 'mysql', mysql, 'my.ini'))) warnings.push(`No se encontró my.ini para ${mysql}.`);
  if (runtime.apacheFolder && configuredApache && runtime.apacheFolder !== configuredApache) warnings.push(`Apache activo en el panel: ${runtime.apacheFolder}; Laragon ya seleccionó ${configuredApache}. Detén el servicio para aplicar el cambio.`);
  if (runtime.mysqlFolder && configuredMysql && runtime.mysqlFolder !== configuredMysql) warnings.push(`MySQL activo en el panel: ${runtime.mysqlFolder}; Laragon ya seleccionó ${configuredMysql}. Detén el servicio para aplicar el cambio.`);
  const apacheMinimum = POLICY.components && POLICY.components.apache && POLICY.components.apache.minimumRecommended;
  const apacheVersion = apache && apache.match(/\d+\.\d+\.\d+/);
  if (apacheMinimum && apacheVersion && compareVersions(apacheVersion[0], apacheMinimum) < 0) {
    warnings.push(`Apache ${apacheVersion[0]} está por debajo de la versión recomendada ${apacheMinimum}; revisa los avisos de seguridad del proyecto Apache.`);
  }
  const selectedPhpInfo = selectedPhp(phpApacheFolder || phpIniFolder);
  const phpPolicy = POLICY.components && POLICY.components.php;
  if (selectedPhpInfo && phpPolicy) {
    const minimum = phpPolicy.minimumPatched && phpPolicy.minimumPatched[selectedPhpInfo.branch];
    if (minimum && compareVersions(selectedPhpInfo.full, minimum) < 0) warnings.push(`PHP ${selectedPhpInfo.full} está por debajo del mínimo parcheado ${minimum} para la rama ${selectedPhpInfo.branch}.`);
    const supportEnd = phpPolicy.supportEnds && phpPolicy.supportEnds[selectedPhpInfo.branch];
    if (supportEnd && supportEnd < new Date().toISOString().slice(0, 10)) warnings.push(`PHP ${selectedPhpInfo.branch} terminó soporte el ${supportEnd}; migra a una rama mantenida.`);
  }
  const redisVersion = redis && path.basename(path.dirname(redis)).match(/\d+(?:\.\d+)+/);
  if (redisVersion && compareVersions(redisVersion[0], '6.0.0') < 0) warnings.push(`Redis ${redisVersion[0]} es una versión antigua; confirma que la distribución Windows tenga mantenimiento y soporte.`);
  return {
    apache: { selected: configuredApache, runtime: apache, port: runtime.apachePort || Number(readIniValue(root, 'apache', 'Port')) || 80, installed: versionDirs(path.join(root, 'bin', 'apache'), 'httpd-', path.join('bin', 'httpd.exe')) },
    php: {
      laragonIni: phpIniFolder,
      apacheConfig: phpApacheFolder,
      lastLoaded: loadedPhp,
      installed: php.map(({ folder, full, branch, ts, apache: modPhp, x64, compiler }) => ({ folder, full, branch, ts, modPhp, x64, compiler })),
    },
    mysql: { selected: configuredMysql, runtime: mysql, port: runtime.mysqlPort || Number(readIniValue(root, 'mysql', 'Port')) || 3308, installed: versionDirs(path.join(root, 'bin', 'mysql'), 'mysql-', path.join('bin', 'mysqld.exe')) },
    redis: {
      executable: redis ? redis.replace(/\\/g, '/') : '',
      selected: redis ? path.basename(path.dirname(redis)) : '',
      port: redisPort(root, redisPath),
      installed: versionDirs(path.join(root, 'bin', 'redis'), 'redis-'),
    },
    warnings,
  };
}

module.exports = {
  readIniValue,
  writeIniValue,
  compareVersions,
  compareVersionNames,
  versionDirs,
  selectVersionDir,
  apacheFolder,
  mysqlFolder,
  phpFolder,
  phpVersions,
  apachePhpFolder,
  findRedis,
  redisPort,
  stackSnapshot,
};
