'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const IS_PACKAGED = app.isPackaged;
const APP_DIR = IS_PACKAGED ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const PANEL_DIR = IS_PACKAGED ? path.join(process.resourcesPath, 'panel') : path.resolve(__dirname, '..');
const DATA_DIR = IS_PACKAGED ? path.join(APP_DIR, 'data') : PANEL_DIR;
const CONFIG_FILE = IS_PACKAGED ? path.join(APP_DIR, 'panel.config.json') : path.join(PANEL_DIR, 'panel.config.json');
const BUNDLED_NODE = path.join(process.resourcesPath, 'node', 'node.exe');
const NODE_EXE = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;

if (IS_PACKAGED) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  try { app.setPath('userData', DATA_DIR); } catch {}
}
process.env.PANEL_DATA = DATA_DIR;
process.env.PANEL_CONFIG = CONFIG_FILE;
process.env.PANEL_NODE = NODE_EXE;

let fileConfig = {};
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
const PANEL_PORT = Number(process.env.PANEL_PORT || fileConfig.panelPort || 9090);
const PANEL_URL = `http://127.0.0.1:${PANEL_PORT}`;
const ICON = path.join(__dirname, 'icon.png');
const ICON_ICO = path.join(__dirname, 'icon.ico');
const SETTINGS_FILE = path.join(DATA_DIR, 'desktop-settings.json');
const START_HIDDEN = process.argv.includes('--hidden');

let win = null;
let tray = null;
let serverChild = null;
let quitting = false;
let notificationsEnabled = true;
let autostartInit = false;
let autostartEnabled = false;
let portableDir = '';
let hideNoticeShown = false;
let backupWasRunning = false;

try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (typeof saved.notifications === 'boolean') notificationsEnabled = saved.notifications;
  if (typeof saved.autostartInit === 'boolean') autostartInit = saved.autostartInit;
  if (typeof saved.autostartEnabled === 'boolean') autostartEnabled = saved.autostartEnabled;
  if (typeof saved.portableDir === 'string') portableDir = saved.portableDir;
} catch {}

function saveDesktopSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      notifications: notificationsEnabled,
      autostartInit,
      autostartEnabled,
      portableDir,
    }, null, 2), 'utf8');
  } catch {}
}
let last = { apache: null, mysql: null };

function api(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: PANEL_PORT,
      path: pathname,
      method: options.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      timeout: options.timeout || 8000,
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function ensureServer() {
  try { await api('/api/overview'); return; } catch {}
  serverChild = spawn(NODE_EXE, [path.join(PANEL_DIR, 'server.js')], {
    cwd: PANEL_DIR,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PANEL_NODE: NODE_EXE,
      PANEL_DATA: DATA_DIR,
      PANEL_CONFIG: CONFIG_FILE,
    },
  });
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 300));
    try { await api('/api/overview'); return; } catch {}
  }
}

async function ensureServices() {
  try {
    const o = await api('/api/overview');
    if (o.services && !o.services.apache.up) {
      await api('/api/service', { method: 'POST', body: { name: 'apache', action: 'start' }, timeout: 120000 });
    }
    if (o.services && !o.services.mysql.up) {
      await api('/api/service', { method: 'POST', body: { name: 'mysql', action: 'start' }, timeout: 120000 });
    }
  } catch {}
}

function notify(title, body) {
  if (!notificationsEnabled) return;
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: ICON }).show();
  } else if (tray) {
    tray.displayBalloon({ title, content: body, icon: ICON });
  }
}

async function service(name, action) {
  try {
    const r = await api('/api/service', { method: 'POST', body: { name, action }, timeout: 120000 });
    notify(name === 'apache' ? 'Apache' : 'MySQL', r.ok ? `Acción: ${action}` : (r.error || 'Error'));
    updateTray();
  } catch (e) {
    notify('Error de servicio', e.message);
  }
}

function showWindow(view) {
  if (!win) return;
  win.show();
  win.focus();
  if (view) {
    setTimeout(() => {
      win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]')?.click()`).catch(() => {});
    }, 350);
  }
}

function autostartShortcut() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Laragon Panel.lnk');
}

function isAutostart() {
  return fs.existsSync(autostartShortcut());
}

function setAutostart(enabled, silent = false) {
  const lnk = autostartShortcut();
  try {
    if (enabled) {
      if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
      const args = app.isPackaged ? '--hidden' : `"${app.getAppPath()}" --hidden`;
      shell.writeShortcutLink(lnk, 'create', {
        target: process.execPath,
        args,
        cwd: APP_DIR,
        icon: ICON_ICO,
        iconIndex: 0,
        description: 'Laragon Panel',
      });
      if (!silent) notify('Inicio con Windows', 'Activado');
    } else {
      if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
      if (!silent) notify('Inicio con Windows', 'Desactivado');
    }
    autostartInit = true;
    autostartEnabled = !!enabled;
    portableDir = APP_DIR;
    saveDesktopSettings();
    return { ok: true, enabled: isAutostart() };
  } catch (e) {
    return { ok: false, error: e.message, enabled: isAutostart() };
  }
}

async function updateTray() {
  let data = null;
  try { data = await api('/api/overview'); } catch {}
  const a = !!(data && data.services && data.services.apache && data.services.apache.up);
  const m = !!(data && data.services && data.services.mysql && data.services.mysql.up);

  let backupRunning = false;
  try {
    const b = await api('/api/backup/status');
    backupRunning = !!b.running;
    if (backupWasRunning && !backupRunning) {
      const last = b.state && b.state.last;
      if (last) {
        notify(last.ok ? 'Respaldo completado' : 'Respaldo con errores', `${last.name} · ${last.mb || 0} MB`);
      }
    }
  } catch {}
  backupWasRunning = backupRunning;

  if (last.apache !== null && last.apache !== a) notify('Apache', a ? 'Servicio iniciado' : 'Servicio detenido');
  if (last.mysql !== null && last.mysql !== m) notify('MySQL', m ? 'Servicio iniciado' : 'Servicio detenido');
  last = { apache: a, mysql: m };

  if (!tray) return;
  const template = [
    { label: 'Laragon Panel', enabled: false },
    { label: `Apache: ${a ? 'Activo' : 'Detenido'}`, enabled: false },
    { label: `MySQL: ${m ? 'Activo' : 'Detenido'}`, enabled: false },
    { type: 'separator' },
    { label: 'Abrir panel', click: () => showWindow() },
    { label: 'Servicios', click: () => showWindow('services') },
    { label: 'Respaldos', click: () => showWindow('backups') },
    { label: 'Ver logs', click: () => showWindow('logs') },
    { type: 'separator' },
  ];
  if (a) {
    template.push({ label: 'Reiniciar Apache', click: () => service('apache', 'restart') });
    template.push({ label: 'Detener Apache', click: () => service('apache', 'stop') });
  } else {
    template.push({ label: 'Iniciar Apache', click: () => service('apache', 'start') });
  }
  if (m) {
    template.push({ label: 'Reiniciar MySQL', click: () => service('mysql', 'restart') });
    template.push({ label: 'Detener MySQL', click: () => service('mysql', 'stop') });
  } else {
    template.push({ label: 'Iniciar MySQL', click: () => service('mysql', 'start') });
  }
  template.push(
    { type: 'separator' },
    { label: 'Iniciar con Windows', type: 'checkbox', checked: isAutostart(), click: item => setAutostart(item.checked) },
    { label: 'Notificaciones', type: 'checkbox', checked: notificationsEnabled, click: item => { notificationsEnabled = item.checked; saveDesktopSettings(); } },
    { type: 'separator' },
    {
      label: 'Salir y detener servicios',
      click: async () => {
        try {
          const s = await api('/api/services');
          for (const n of (s.nodes || [])) {
            await api('/api/node', { method: 'POST', body: { name: n.name, action: 'stop' }, timeout: 60000 });
          }
          await api('/api/service', { method: 'POST', body: { name: 'apache', action: 'stop' }, timeout: 120000 });
          await api('/api/service', { method: 'POST', body: { name: 'mysql', action: 'stop' }, timeout: 120000 });
        } catch {}
        quitting = true;
        app.quit();
      }
    },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`Laragon Panel — Apache ${a ? 'OK' : 'X'} · MySQL ${m ? 'OK' : 'X'}`);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#070b14',
    icon: ICON,
    autoHideMenuBar: true,
    title: 'Laragon Panel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL(PANEL_URL);
  win.once('ready-to-show', () => { if (!START_HIDDEN) win.show(); });
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (!hideNoticeShown) {
        hideNoticeShown = true;
        notify('Laragon Panel', 'Sigue ejecutándose en la bandeja del sistema.');
      }
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    app.setAppUserModelId('Laragon.Panel');
    await ensureServer();
    await ensureServices();
    await createWindow();
    tray = new Tray(nativeImage.createFromPath(ICON));
    tray.setToolTip('Laragon Panel');
    tray.on('double-click', () => showWindow());
    await updateTray();
    setInterval(updateTray, 5000);

    // En la versión portable, iniciar con Windows en el primer arranque.
    if (IS_PACKAGED) {
      if (!autostartInit) {
        setAutostart(true, true);
      } else if (autostartEnabled) {
        // Recrear el acceso directo: corrige ruta si la carpeta se movió.
        setAutostart(true, true);
      } else if (portableDir !== APP_DIR) {
        portableDir = APP_DIR;
        saveDesktopSettings();
      }
    }

    setTimeout(() => notify('Laragon Panel', START_HIDDEN ? 'Iniciado en segundo plano.' : 'Aplicación iniciada. Apache y MySQL listos.'), 1500);
  });
}

ipcMain.handle('desktop:status', () => ({ autostart: isAutostart(), notifications: notificationsEnabled }));
ipcMain.handle('desktop:autostart', (e, enabled) => setAutostart(!!enabled));
ipcMain.handle('desktop:notifications', (e, enabled) => {
  notificationsEnabled = !!enabled;
  saveDesktopSettings();
  return { notifications: notificationsEnabled };
});
ipcMain.handle('desktop:notify', (e, { title, body }) => {
  notify(title, body);
  return { ok: true };
});
ipcMain.handle('desktop:logs', () => {
  showWindow('logs');
  return { ok: true };
});

app.on('before-quit', () => {
  quitting = true;
  if (serverChild) {
    try { serverChild.kill(); } catch {}
  }
});

app.on('window-all-closed', () => {});
