'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const stack = require('../laragon-stack');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laragon-stack-test-'));
  fs.mkdirSync(path.join(root, 'usr'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'laragon.ini'), '[apache]\r\nVersion=httpd-2.4.9\r\nPort=8088\r\nDocumentRoot=C:/sites\r\n[php]\r\nVersion=php-8.3.2-Win32-vs16-x64\r\n[mysql]\r\nVersion=mysql-8.4.3-winx64\r\nPort=3308\r\n');
  const mkdirVersion = (dir, version, executable) => {
    const folder = path.join(dir, version);
    fs.mkdirSync(folder, { recursive: true });
    if (executable) {
      const file = path.join(folder, executable);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'test');
    }
  };
  mkdirVersion(path.join(root, 'bin', 'apache'), 'httpd-2.4.9', path.join('bin', 'httpd.exe'));
  mkdirVersion(path.join(root, 'bin', 'apache'), 'httpd-2.4.10', path.join('bin', 'httpd.exe'));
  mkdirVersion(path.join(root, 'bin', 'apache'), 'httpd-2.4.10-260617', path.join('bin', 'httpd.exe'));
  mkdirVersion(path.join(root, 'bin', 'apache'), 'httpd-2.4.10-260827', path.join('bin', 'httpd.exe'));
  mkdirVersion(path.join(root, 'bin', 'mysql'), 'mysql-8.4.3-winx64', path.join('bin', 'mysqld.exe'));
  mkdirVersion(path.join(root, 'bin', 'mysql'), 'mysql-8.4.12-winx64', path.join('bin', 'mysqld.exe'));
  mkdirVersion(path.join(root, 'bin', 'php'), 'php-8.3.2-Win32-vs16-x64', 'php.exe');
  mkdirVersion(path.join(root, 'bin', 'php'), 'php-8.3.10-Win32-vs16-x64', 'php.exe');
  fs.writeFileSync(path.join(root, 'bin', 'php', 'php-8.3.2-Win32-vs16-x64', 'php8ts.dll'), 'test');
  fs.writeFileSync(path.join(root, 'bin', 'php', 'php-8.3.2-Win32-vs16-x64', 'php8apache2_4.dll'), 'test');
  return { root, mkdirVersion };
}

test('honors the active Laragon version but falls back semantically when missing', t => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(stack.apacheFolder(root), 'httpd-2.4.9');
  assert.equal(stack.mysqlFolder(root), 'mysql-8.4.3-winx64');
  assert.equal(stack.phpFolder(root), 'php-8.3.2-Win32-vs16-x64');
  stack.writeIniValue(root, 'apache', 'Version', 'httpd-9.9.9');
  assert.equal(stack.apacheFolder(root), 'httpd-2.4.10-260827');
});

test('version listing is numeric rather than lexical', t => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = stack.versionDirs(path.join(root, 'bin', 'apache'), 'httpd-', path.join('bin', 'httpd.exe'));
  assert.deepEqual(dirs, ['httpd-2.4.9', 'httpd-2.4.10', 'httpd-2.4.10-260617', 'httpd-2.4.10-260827']);
});

test('PHP inventory records full version and correct SAPI capabilities', t => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const php = stack.phpVersions(root);
  assert.equal(php.find(p => p.folder.includes('8.3.2')).full, '8.3.2');
  assert.equal(php.find(p => p.folder.includes('8.3.2')).ts, true);
  assert.equal(php.find(p => p.folder.includes('8.3.2')).apache, true);
  assert.equal(php.find(p => p.folder.includes('8.3.10')).apache, false);
});

test('stack report calls out drift between Laragon PHP and Apache PHP', t => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'etc', 'apache2'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc', 'apache2', 'mod_php.conf'), 'LoadModule php_module "C:/Laragon/bin/php/php-8.3.10-Win32-vs16-x64/php8apache2_4.dll"\n');
  fs.mkdirSync(path.join(root, 'bin', 'apache', 'httpd-2.4.9', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'apache', 'httpd-2.4.9', 'logs', 'error_log'), '[notice] Apache/2.4.9 (Win64) PHP/8.3.2 configured -- resuming normal operations\n');
  const report = stack.stackSnapshot(root);
  assert.equal(report.apache.selected, 'httpd-2.4.9');
  assert.equal(report.mysql.selected, 'mysql-8.4.3-winx64');
  assert.ok(report.warnings.some(warning => warning.includes('PHP no coincide')));
  assert.equal(report.php.lastLoaded, '8.3.2');
  assert.ok(report.warnings.some(warning => warning.includes('último arranque')));
  assert.ok(report.warnings.some(warning => warning.includes('Apache 2.4.9')));
});

test('auto settings inherit ports and DocumentRoot from Laragon rather than stale template values', t => {
  const { root } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'panel.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    laragonRoot: root,
    wwwRoot: 'C:/old-www',
    wwwRootMode: 'auto',
    mysqlPort: 3306,
    mysqlPortMode: 'auto',
    apachePort: 80,
    apachePortMode: 'auto',
  }));
  const script = [
    'process.env.PANEL_CONFIG=process.argv[1];',
    'const c=require(process.argv[2]); const fs=require("node:fs"); const path=require("node:path");',
    'const ini=path.join(c.laragonRoot,"usr","laragon.ini");',
    'fs.writeFileSync(ini,fs.readFileSync(ini,"utf8").replace("Port=8088","Port=8090").replace("Port=3308","Port=3309").replace("DocumentRoot=C:/sites","DocumentRoot=C:/new-sites"));',
    'console.log(JSON.stringify({mysqlPort:c.getMysqlPort(),apachePort:c.getApachePort(),wwwRoot:c.getWwwRoot()}));',
  ].join('');
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script, configPath, path.join(__dirname, '..', 'config.js')], { encoding: 'utf8' }));
  assert.equal(result.mysqlPort, 3309);
  assert.equal(result.apachePort, 8090);
  assert.equal(result.wwwRoot.toLowerCase(), 'c:/new-sites');
});
