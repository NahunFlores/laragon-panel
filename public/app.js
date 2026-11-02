'use strict';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let lastOverview = null;
let lastSystem = null;
const cpuHistory = [];
const ramHistory = [];
let projects = [];
let databases = [];
let siteStatuses = {};
let shareData = null;
let shareIp = '';
let currentView = 'dashboard';
let logService = 'apache';
let lastLogText = '';
let busy = false;
let backupData = { jobs: [], history: [], drives: [], tasks: {}, catalog: { databases: [], projects: [] }, state: {}, running: false };
let backupPoll = null;
let winData = { core: [], queues: [], managed: [], detected: [], nssm: {}, admin: false };
let winQueueFilter = '';

const titles = {
  dashboard: ['Dashboard', 'Estado de tu entorno local'],
  services: ['Servicios', 'Apache, MySQL y aplicaciones Node'],
  windows: ['Servicios Windows', 'Apache, MySQL, Redis y colas como servicios'],
  projects: ['Proyectos', 'Todos los sitios y su puerto'],
  databases: ['Bases de datos', 'Bases, tablas y tamaño'],
  backups: ['Respaldos', 'Copias de bases y proyectos a disco externo'],
  php: ['PHP', 'Versiones instaladas y versión activa'],
  share: ['Compartir', 'Acceso por IP en la red local'],
  logs: ['Logs', 'Últimas líneas de Apache y MySQL'],
  settings: ['Ajustes', 'Rutas y accesos del entorno'],
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(title, msg = '', type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<strong>${esc(title)}</strong>${msg ? `<small>${esc(msg)}</small>` : ''}`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all .25s';
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

function fmtMB(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}

function setView(view) {
  currentView = view;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  const [title, sub] = titles[view] || ['', ''];
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').textContent = sub;
  if (view === 'projects') { loadProjects(); loadProjectStatuses(); }
  if (view === 'databases') loadDatabases();
  if (view === 'backups') loadBackups();
  if (view === 'dashboard') loadSystem();
  if (view === 'windows') loadWindows();
  if (view === 'php') { renderPhp(lastOverview); loadExtensions(); }
  if (view === 'share') loadShare();
  if (view === 'services') loadServices();
  if (view === 'logs') { loadLogServices(); loadLogs(); }
  if (view === 'settings') loadDesktopSettings();
}

function setBadge(el, up) {
  el.classList.toggle('up', !!up);
  el.classList.toggle('down', !up);
  el.innerHTML = `<span class="dot"></span>${up ? 'Activo' : 'Detenido'}`;
}

function renderServices(o) {
  const a = o.services.apache;
  const m = o.services.mysql;

  setBadge($('#apacheBadge'), a.up);
  setBadge($('#mysqlBadge'), m.up);
  $('#apacheMeta').textContent = `Puerto ${a.port}${a.version ? ` · ${a.version}` : ''}`;
  $('#mysqlMeta').textContent = `Puerto ${m.port}${m.version ? ` · ${m.version}` : ''}`;

  $('#apacheCard').querySelectorAll('[data-action]').forEach(btn => {
    if (btn.dataset.action === 'start') btn.disabled = a.up;
    if (btn.dataset.action === 'stop') btn.disabled = !a.up;
  });
  $('#mysqlCard').querySelectorAll('[data-action]').forEach(btn => {
    if (btn.dataset.action === 'start') btn.disabled = m.up;
    if (btn.dataset.action === 'stop') btn.disabled = !m.up;
  });

  $('#apacheDot').className = `dot ${a.up ? 'up' : 'down'}`;
  $('#mysqlDot').className = `dot ${m.up ? 'up' : 'down'}`;
}

function renderOverview(o) {
  lastOverview = o;
  renderServices(o);

  $('#statProjects').textContent = o.projects;
  $('#statDbs').textContent = o.databases;
  $('#statPhp').textContent = o.php.active || '—';
  $('#statDisk').textContent = o.disk ? `${o.disk.freeGB} GB` : '—';
  $('#statDiskHint').textContent = o.disk ? `${o.disk.usedPct}% usado de ${o.disk.totalGB} GB` : 'C:';

  $('#envHost').textContent = o.system.host;
  $('#envSystem').textContent = o.system.platform;
  $('#envCpu').textContent = (o.system.cpu || '').replace(/\(R\)|\(TM\)|CPU|@.*/gi, '').replace(/\s+/g, ' ').trim();
  $('#envRam').textContent = `${o.system.ramGB} GB`;
  $('#envUptime').textContent = `${o.system.uptimeH} h`;

  $('#navProjectCount').textContent = o.projects;
  $('#navDbCount').textContent = o.databases;
  $('#settingsPhp').textContent = o.php.active || '—';
  $('#settingsMysql').textContent = `127.0.0.1:${o.services.mysql.port} · root`;
  $('#settingsPanel').textContent = `127.0.0.1:${location.port || '9090'}`;

  renderPhp(o);
  if (lastSystem) renderResources(lastSystem);
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d ? `${d}d ` : ''}${h}h ${m}m`;
}

function drawSpark(canvas, values, color) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 58;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(148,163,184,.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  if (values.length < 2) return;

  const x = i => (i / (values.length - 1)) * w;
  const y = v => h - (Math.max(0, Math.min(100, v)) / 100) * h;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');

  ctx.beginPath();
  ctx.moveTo(0, h);
  values.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  values.forEach((v, i) => { if (i) ctx.lineTo(x(i), y(v)); else ctx.moveTo(x(i), y(v)); });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

async function loadSystem() {
  try {
    const s = await api('/api/system');
    lastSystem = s;

    $('#sysCpuPct').textContent = `${s.cpu.usage.toFixed(1)}%`;
    $('#sysCpuPct').style.color = s.cpu.usage >= 85 ? 'var(--red)' : s.cpu.usage >= 70 ? 'var(--amber)' : '';
    $('#sysCpuInfo').textContent = `${s.cpu.model} · ${s.cpu.cores} núcleos · ${s.cpu.speedMHz} MHz`;
    $('#sysRamPct').textContent = `${s.memory.usedPct}%`;
    $('#sysRamPct').style.color = s.memory.usedPct >= 90 ? 'var(--red)' : s.memory.usedPct >= 75 ? 'var(--amber)' : '';
    $('#sysRamInfo').textContent = `${s.memory.usedMB} / ${s.memory.totalMB} MB · ${s.memory.freeMB} MB libres`;
    $('#sysDiskPct').textContent = `${s.disk.usedPct}%`;
    $('#sysDiskPct').style.color = s.disk.usedPct >= 92 ? 'var(--red)' : s.disk.usedPct >= 85 ? 'var(--amber)' : '';
    $('#sysDiskBar').style.width = `${s.disk.usedPct}%`;
    $('#sysDiskBar').style.background = s.disk.usedPct >= 92
      ? 'linear-gradient(90deg, #fb7185, #f43f5e)'
      : 'linear-gradient(90deg, var(--accent), var(--accent-2))';
    $('#sysDiskInfo').textContent = `${s.disk.freeGB} GB libres de ${s.disk.totalGB} GB`;
    $('#sysGpu').textContent = s.gpu || '—';
    $('#sysOsInfo').textContent = `${s.host} · ${s.platform} ${s.release} (${s.arch})`;
    $('#sysUptime').textContent = `Encendido hace ${fmtUptime(s.uptimeSec)}`;

    cpuHistory.push(s.cpu.usage);
    ramHistory.push(s.memory.usedPct);
    if (cpuHistory.length > 60) cpuHistory.shift();
    if (ramHistory.length > 60) ramHistory.shift();
    drawSpark($('#cpuChart'), cpuHistory, '#22d3ee');
    drawSpark($('#ramChart'), ramHistory, '#818cf8');

    renderResources(s);
  } catch {}
}

function renderResources(s) {
  const body = $('#resourceBody');
  if (!body || !s) return;
  const ov = lastOverview || { services: {} };
  const rows = [
    { name: 'Apache', up: !!(ov.services && ov.services.apache && ov.services.apache.up), r: s.processes.apache },
    { name: 'MySQL', up: !!(ov.services && ov.services.mysql && ov.services.mysql.up), r: s.processes.mysql },
    { name: 'Node', up: s.processes.node.count > 0, r: s.processes.node },
    { name: 'Panel', up: true, r: s.processes.panel },
  ];
  body.innerHTML = rows.map(row => {
    const pct = Math.min(100, Math.max(0, row.r.cpuPct || 0));
    return `<tr>
      <td class="db-name">${row.name}</td>
      <td><span class="status-badge ${row.up ? 'up' : 'down'}" style="padding:3px 8px;font-size:10.5px"><span class="dot"></span>${row.up ? 'Activo' : 'Detenido'}</span></td>
      <td>${row.r.count}</td>
      <td class="db-size">${row.r.ramMB} MB</td>
      <td>${row.r.cpuPct}%</td>
      <td><div class="resource-bar"><span style="width:${pct}%"></span></div></td>
    </tr>`;
  }).join('');
}

async function refreshOverview(silent = false) {
  if (busy) return;
  try {
    const o = await api('/api/overview');
    renderOverview(o);
  } catch (e) {
    if (!silent) toast('No se pudo actualizar', e.message, 'err');
  }
}

async function serviceAction(name, action) {
  if (busy) return;
  busy = true;
  const card = name === 'apache' ? $('#apacheCard') : $('#mysqlCard');
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const r = await api('/api/service', { method: 'POST', body: JSON.stringify({ name, action }) });
    toast(
      `${name === 'apache' ? 'Apache' : 'MySQL'} ${action === 'start' ? 'iniciado' : action === 'stop' ? 'detenido' : 'reiniciado'}`,
      r.ok ? 'Operación completada' : (r.error || 'Revisa los logs'),
      r.ok ? 'ok' : 'err'
    );
  } catch (e) {
    toast('Error de servicio', e.message, 'err');
  } finally {
    busy = false;
    await refreshOverview(true);
    if (currentView === 'services') await loadServices();
  }
}

async function loadProjects() {
  try {
    const r = await api('/api/projects');
    projects = r.projects || [];
    renderProjects();
    loadProjectStatuses();
  } catch (e) {
    toast('No se pudieron cargar los proyectos', e.message, 'err');
  }
}

async function loadProjectStatuses() {
  try {
    const r = await api('/api/projects/status');
    siteStatuses = r.statuses || {};
    updateSiteDots();
    setupPreviews();
  } catch {}
}

function updateSiteDots() {
  document.querySelectorAll('[data-site]').forEach(el => {
    const s = siteStatuses[el.dataset.site];
    el.className = `site-dot ${s > 0 ? 'up' : 'down'}`;
    el.title = s > 0 ? `HTTP ${s}` : 'Sin respuesta';
  });
}

function renderProjects() {
  const q = ($('#projectSearch').value || '').toLowerCase().trim();
  const list = projects.filter(p => !q || p.name.toLowerCase().includes(q) || String(p.port).includes(q));
  $('#projectCountLabel').textContent = `${list.length} de ${projects.length} proyectos`;
  const grid = $('#projectGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="card panel muted">No hay proyectos que coincidan.</div>`;
    return;
  }
  grid.innerHTML = list.map(p => {
    const letter = esc((p.name || '?').trim().charAt(0).toUpperCase());
    const path = esc((p.root || '').replace(/^C:\/laragon\/www\//i, '~/'));
    return `<article class="project-card">
      <div class="project-preview" data-preview="${p.port}" data-open="${p.port}" title="Abrir ${esc(p.name)}"><span class="pv-hint">cargando vista previa…</span></div>
      <div class="project-top">
        <div class="project-avatar">${letter}</div>
        <div>
          <div class="project-name"><span class="site-dot" data-site="${p.port}"></span>${esc(p.name)}</div>
          <div class="project-path">${path}</div>
        </div>
      </div>
      <div class="project-foot">
        <span class="port-badge">:${p.port}</span>
        <span class="type-badge">${esc(p.type || 'static')}</span>
        <button class="btn primary" data-open="${p.port}">Abrir</button>
      </div>
      <div class="project-tools">
        <button class="btn ghost" data-tool="folder" data-root="${esc(p.root)}">Carpeta</button>
        <button class="btn ghost" data-tool="code" data-root="${esc(p.root)}">Code</button>
        <button class="btn ghost" data-tool="terminal" data-root="${esc(p.root)}">Terminal</button>
        <button class="btn ghost" data-log="${p.port}" data-name="${esc(p.name)}">Logs</button>
      </div>
    </article>`;
  }).join('');
  updateSiteDots();
  setupPreviews();
}

const previewObserver = ('IntersectionObserver' in window)
  ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      previewObserver.unobserve(entry.target);
      loadPreview(entry.target);
    }
  }, { rootMargin: '250px' })
  : null;

function setupPreviews() {
  document.querySelectorAll('[data-preview]').forEach(el => {
    if (el.classList.contains('has-shot')) return;
    if (previewObserver) previewObserver.observe(el);
    else loadPreview(el);
  });
}

function previewTarget(el) {
  const port = Number(el.dataset.preview);
  const up = (siteStatuses[port] || 0) > 0;
  if (!up) {
    el.classList.add('no-shot');
    el.innerHTML = '<span class="pv-hint">sitio apagado</span>';
    return null;
  }
  el.classList.remove('no-shot');
  return port;
}

async function loadPreview(el, attempt = 0) {
  const port = Number(el.dataset.preview);
  if (attempt === 0) {
    if (previewTarget(el) === null) return;
    el.innerHTML = '<span class="pv-hint">cargando vista previa…</span>';
  }
  try {
    const res = await fetch(`/api/preview?port=${port}`, { cache: 'no-store' });
    if (res.status === 200) {
      const blob = await res.blob();
      const img = new Image();
      img.alt = `Vista previa del sitio en el puerto ${port}`;
      img.src = URL.createObjectURL(blob);
      el.innerHTML = '';
      el.appendChild(img);
      el.classList.add('has-shot');
      return;
    }
    if (res.status === 204) {
      el.classList.add('no-shot');
      el.innerHTML = '<span class="pv-hint">sitio apagado</span>';
      return;
    }
    if (res.status === 202 && attempt < 14) {
      setTimeout(() => loadPreview(el, attempt + 1), 2500);
      return;
    }
  } catch {}
  el.classList.add('no-shot');
  el.innerHTML = '<span class="pv-hint">sin vista previa</span>';
}

function serviceCard(name, label, s) {
  const up = !!(s && s.up);
  return `<article class="card service-card">
    <div class="service-head">
      <div class="service-icon ${name}">${name === 'apache' ? 'A' : 'M'}</div>
      <div>
        <div class="service-name">${label}</div>
        <div class="service-meta">Puerto ${s ? s.port : '—'}${s && s.version ? ` · ${esc(s.version)}` : ''}</div>
      </div>
      <span class="status-badge ${up ? 'up' : 'down'}"><span class="dot"></span>${up ? 'Activo' : 'Detenido'}</span>
    </div>
    <div class="service-actions">
      <button class="btn primary" data-svc="${name}" data-action="start" ${up ? 'disabled' : ''}>Iniciar</button>
      <button class="btn ghost" data-svc="${name}" data-action="stop" ${up ? '' : 'disabled'}>Detener</button>
      <button class="btn ghost" data-svc="${name}" data-action="restart">Reiniciar</button>
    </div>
  </article>`;
}

function nodeCard(n) {
  return `<article class="card service-card">
    <div class="service-head">
      <div class="service-icon" style="background:linear-gradient(135deg,#34d399,#22d3ee);color:#04121a">N</div>
      <div>
        <div class="service-name">${esc(n.name)}</div>
        <div class="node-meta">Público :${n.port} · interno :${n.internalPort || '—'}</div>
      </div>
      <span class="status-badge ${n.running ? 'up' : 'down'}"><span class="dot"></span>${n.running ? 'Activo' : 'Detenido'}</span>
    </div>
    <div class="node-foot">
      <button class="btn primary" data-node="${esc(n.name)}" data-node-action="start" ${n.running ? 'disabled' : ''}>Iniciar</button>
      <button class="btn ghost" data-node="${esc(n.name)}" data-node-action="stop" ${n.running ? '' : 'disabled'}>Detener</button>
      <button class="btn ghost" data-node="${esc(n.name)}" data-node-action="restart">Reiniciar</button>
    </div>
  </article>`;
}

async function loadServices() {
  try {
    const r = await api('/api/services');
    const cards = [
      serviceCard('apache', 'Apache', r.apache),
      serviceCard('mysql', 'MySQL', r.mysql),
      ...(r.nodes || []).map(nodeCard),
    ];
    $('#servicesGrid').innerHTML = cards.join('');
  } catch (e) {
    toast('No se pudieron cargar los servicios', e.message, 'err');
  }
}

async function nodeAction(name, action) {
  if (busy) return;
  busy = true;
  try {
    const r = await api('/api/node', { method: 'POST', body: JSON.stringify({ name, action }) });
    toast(`Node · ${name}`, r.ok ? `Acción: ${action}` : (r.error || 'Error'), r.ok ? 'ok' : 'err');
  } catch (e) {
    toast('Error en la app Node', e.message, 'err');
  } finally {
    busy = false;
    await loadServices();
    await refreshOverview(true);
  }
}

/* ---------------- Servicios de Windows ---------------- */

function winRunning(status) {
  return /running/i.test(String(status || ''));
}

function winInstalled(status) {
  return !/not installed/i.test(String(status || ''));
}

function winStateLabel(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'Activo';
  if (s === 'stopped') return 'Detenido';
  if (s.includes('start pending')) return 'Iniciando';
  if (s.includes('stop pending')) return 'Deteniendo';
  if (s === 'paused') return 'Pausado';
  if (s.includes('not installed')) return 'No instalado';
  return status || 'Desconocido';
}

function winStateBadge(status) {
  const installed = winInstalled(status);
  const up = winRunning(status);
  const cls = !installed ? 'gray' : up ? 'ok' : 'err';
  return `<span class="badge ${cls}">${esc(winStateLabel(status))}</span>`;
}

function winButtons(name, status, opts = {}) {
  const installed = winInstalled(status);
  const up = winRunning(status);
  const n = esc(name);
  let html = '';
  if (!installed) {
    html += `<button class="btn primary" data-win-install="${esc(opts.install || name)}">Instalar</button>`;
  } else {
    html += `<button class="btn primary" data-win-act="start" data-win-name="${n}" ${up ? 'disabled' : ''}>Iniciar</button>`;
    html += `<button class="btn ghost" data-win-act="stop" data-win-name="${n}" ${up ? '' : 'disabled'}>Detener</button>`;
    html += `<button class="btn ghost" data-win-act="restart" data-win-name="${n}">Reiniciar</button>`;
  }
  html += `<button class="btn ghost" data-win-logs="${n}">Logs</button>`;
  if (installed && opts.auto !== false) {
    const auto = String(opts.startMode || '').toLowerCase() === 'auto';
    html += `<button class="btn ghost" data-win-act="${auto ? 'manual' : 'autostart'}" data-win-name="${n}" title="${auto ? 'Desactivar auto-inicio' : 'Activar auto-inicio'}">${auto ? 'Manual' : 'Auto'}</button>`;
  }
  if (installed && opts.remove) {
    html += `<button class="btn danger" data-win-act="remove" data-win-name="${n}">Quitar</button>`;
  }
  return html;
}

function renderWindows() {
  const admin = !!winData.admin;
  const badge = $('#winAdminBadge');
  if (badge) {
    badge.className = `badge ${admin ? 'ok' : 'gray'}`;
    badge.textContent = admin ? 'Administrador' : 'Sin permisos de administrador';
  }
  const note = $('#winNssmNote');
  if (note) {
    if (!winData.nssm || !winData.nssm.exists) {
      note.hidden = false;
      note.innerHTML = `<strong>NSSM no encontrado.</strong> Configura <code>nssmPath</code> en <code>panel.config.json</code>. Ruta actual: <code>${esc((winData.nssm || {}).path || '—')}</code>`;
    } else {
      note.hidden = true;
    }
  }

  const core = winData.core || [];
  $('#winCore').innerHTML = core.map(c => {
    const up = winRunning(c.status);
    return `<article class="card service-card">
      <div class="service-head">
        <div class="service-icon ${c.key}" style="background:linear-gradient(135deg,#67e8f9,#818cf8);color:#06101d">${c.label.charAt(0)}</div>
        <div>
          <div class="service-name">${esc(c.label)}</div>
          <div class="service-meta">${esc(c.name)} · ${esc(winStateLabel(c.status))}</div>
        </div>
        ${winStateBadge(c.status)}
      </div>
      <div class="backup-dest">${esc(c.exe || 'Ejecutable no encontrado')}</div>
      <div class="service-actions">${winButtons(c.name, c.status, { install: `core:${c.key}`, remove: true, startMode: c.startMode })}</div>
    </article>`;
  }).join('') || '<div class="card note">No se detectaron servicios base.</div>';

  const q = (winQueueFilter || '').toLowerCase();
  const only = $('#winQueueOnly') ? $('#winQueueOnly').checked : true;
  const queues = (winData.queues || []).filter(x =>
    (!only || x.suggested || winInstalled(x.status)) &&
    (!q || `${x.name} ${x.project}`.toLowerCase().includes(q))
  );
  $('#winQueueInfo').textContent = `${queues.length} de ${(winData.queues || []).length}`;
  $('#winQueues').innerHTML = queues.length ? queues.map(x => `<tr>
    <td class="db-name">${esc(x.name)}</td>
    <td>${esc(x.project)}</td>
    <td><code>${esc(x.connection)}</code></td>
    <td>${winStateBadge(x.status)}</td>
    <td class="right">${winButtons(x.name, x.status, { install: `queue:${x.name}`, remove: true, startMode: x.startMode })}</td>
  </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin colas para mostrar.</td></tr>';

  const managed = winData.managed || [];
  $('#winManaged').innerHTML = managed.length ? managed.map(x => `<tr>
    <td class="db-name">${esc(x.label || x.name)}<div class="backup-dest">${esc(x.name)}</div></td>
    <td>${esc(x.kind || 'custom')}</td>
    <td>${esc(x.startMode || '—')}</td>
    <td>${winStateBadge(x.status)}</td>
    <td class="right">${winButtons(x.name, x.status, { install: `existing:${x.name}`, remove: true, auto: false })}
      <button class="btn ghost" data-win-forget="${esc(x.name)}">Ocultar</button></td>
  </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin servicios personalizados o adoptados.</td></tr>';

  renderWinDiscovered(winData.detected || []);
}

function renderWinDiscovered(list) {
  $('#winSearchInfo').textContent = `${list.length} servicio(s)`;
  $('#winDiscovered').innerHTML = list.length ? list.map(s => `<tr>
    <td class="db-name">${esc(s.name)}</td>
    <td>${esc(s.label || '')}</td>
    <td>${esc(s.startMode || '—')}</td>
    <td>${winStateBadge(s.status)}</td>
    <td class="right">
      <button class="btn primary" data-win-adopt="${esc(s.name)}">Adoptar</button>
      ${winInstalled(s.status) ? `<button class="btn ghost" data-win-act="start" data-win-name="${esc(s.name)}">Iniciar</button>
      <button class="btn ghost" data-win-act="stop" data-win-name="${esc(s.name)}">Detener</button>` : ''}
    </td>
  </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin resultados.</td></tr>';
}

async function loadWindows(silent = false) {
  try {
    winData = await api('/api/winservices');
    renderWindows();
  } catch (e) {
    if (!silent) toast('No se pudieron cargar los servicios de Windows', e.message, 'err');
  }
}

async function winAction(name, action) {
  if (action === 'remove' && !confirm(`¿Quitar el servicio ${name}?`)) return;
  try {
    const r = await api('/api/winservices/action', { method: 'POST', body: JSON.stringify({ name, action }) });
    toast('Servicio Windows', r.ok ? `${action}: ${name}` : (r.error || 'Error'), r.ok ? 'ok' : 'err');
    await loadWindows(true);
  } catch (e) {
    toast('No se pudo ejecutar', e.message, 'err');
  }
}

async function winLogs(name) {
  try {
    const r = await api(`/api/winservices/logs?name=${encodeURIComponent(name)}`);
    const body = `<div class="field"><label>Salida (${esc(r.stdoutFile || 'sin archivo')})</label><pre class="log" style="max-height:30vh;margin:0">${esc(r.stdout || '(vacío)')}</pre></div>
      <div class="field"><label>Errores (${esc(r.stderrFile || 'sin archivo')})</label><pre class="log" style="max-height:30vh;margin:0">${esc(r.stderr || '(vacío)')}</pre></div>`;
    showModal(`Logs · ${name}`, body, [{ label: 'Cerrar', onClick: closeModal }]);
  } catch (e) {
    toast('No se pudieron leer los logs', e.message, 'err');
  }
}

async function winSearch() {
  const q = ($('#winSearch').value || '').trim();
  try {
    const r = await api(`/api/winservices/discover?q=${encodeURIComponent(q)}`);
    renderWinDiscovered(r.services || []);
  } catch (e) {
    toast('No se pudo buscar', e.message, 'err');
  }
}

async function winAdopt(name) {
  try {
    await api('/api/winservices/adopt', { method: 'POST', body: JSON.stringify({ name }) });
    toast('Servicio adoptado', name, 'ok');
    await loadWindows(true);
  } catch (e) { toast('No se pudo adoptar', e.message, 'err'); }
}

async function winForget(name) {
  try {
    await api('/api/winservices/forget', { method: 'POST', body: JSON.stringify({ name }) });
    toast('Oculto del panel', name, 'ok');
    await loadWindows(true);
  } catch (e) { toast('No se pudo ocultar', e.message, 'err'); }
}

function winInstallModal(preset = null) {
  const cores = winData.core || [];
  const queues = winData.queues || [];
  const kind = preset && preset.kind ? preset.kind : 'core';
  const coreOptions = cores.map(c => `<option value="${esc(c.key)}" ${preset && preset.key === c.key ? 'selected' : ''}>${esc(c.label)} — ${esc(c.exe || 'no encontrado')}</option>`).join('');
  const queueOptions = queues.map(q => `<option value="${esc(q.name)}" ${preset && preset.name === q.name ? 'selected' : ''}>${esc(q.project)} · ${esc(q.connection)} · ${esc(winStateLabel(q.status))}</option>`).join('');

  showModal('Agregar servicio de Windows', `
    <div class="field">
      <label>Tipo de servicio</label>
      <select id="winKind">
        <option value="core" ${kind === 'core' ? 'selected' : ''}>Servicio base (Apache / MySQL / Redis)</option>
        <option value="queue" ${kind === 'queue' ? 'selected' : ''}>Cola Laravel</option>
        <option value="custom" ${kind === 'custom' ? 'selected' : ''}>Personalizado</option>
      </select>
    </div>
    <div id="winCoreFields" class="field">
      <label>Servicio</label>
      <select id="winCoreKey">${coreOptions}</select>
      <small>Se usa la ruta detectada automáticamente.</small>
    </div>
    <div id="winQueueFields" class="field" hidden>
      <label>Proyecto / cola</label>
      <select id="winQueueName">${queueOptions || '<option value="">Sin colas detectadas</option>'}</select>
      <small>Se ejecuta <code>php artisan queue:work</code> con la conexión del proyecto.</small>
    </div>
    <div id="winCustomFields" hidden>
      <div class="field"><label>Nombre del servicio</label><input id="winName" placeholder="MiServicio"></div>
      <div class="field"><label>Nombre visible</label><input id="winLabel" placeholder="Mi servicio"></div>
      <div class="field"><label>Ejecutable</label><input id="winExe" placeholder="C:\\ruta\\app.exe"></div>
      <div class="field"><label>Argumentos</label><input id="winArgs" placeholder="--puerto 3000"></div>
      <div class="field"><label>Carpeta de trabajo</label><input id="winCwd" placeholder="C:\\ruta"></div>
      <div class="field"><label>Carpeta de logs</label><input id="winLogDir" placeholder="C:\\laragon\\tmp\\logs"></div>
    </div>
    <label class="check-label" style="margin-top:6px"><input type="checkbox" id="winAuto" checked> Iniciar automáticamente con Windows</label>
    <label class="check-label"><input type="checkbox" id="winOverwrite"> Reemplazar si ya existe</label>
    <p class="muted small" style="margin:4px 0 0;line-height:1.5">Instalar y controlar servicios requiere que el panel se ejecute como administrador.</p>
  `, [
    { label: 'Cancelar', onClick: closeModal },
    { label: 'Agregar', class: 'primary', onClick: async () => {
      const kindNow = $('#winKind').value;
      const payload = {
        kind: kindNow,
        autoStart: $('#winAuto').checked,
        overwrite: $('#winOverwrite').checked,
      };
      if (kindNow === 'core') payload.key = $('#winCoreKey').value;
      else if (kindNow === 'queue') payload.name = $('#winQueueName').value;
      else {
        payload.name = $('#winName').value.trim();
        payload.label = $('#winLabel').value.trim();
        payload.exe = $('#winExe').value.trim();
        payload.args = $('#winArgs').value.trim();
        payload.cwd = $('#winCwd').value.trim();
        payload.logDir = $('#winLogDir').value.trim();
      }
      if (kindNow === 'custom' && (!payload.name || !payload.exe)) {
        toast('Faltan datos', 'Nombre y ejecutable son obligatorios', 'err');
        return;
      }
      if (kindNow === 'queue' && !payload.name) {
        toast('Sin cola', 'No hay proyectos de cola detectados', 'err');
        return;
      }
      const btn = document.querySelector('#modalFoot .btn.primary');
      if (btn) { btn.disabled = true; btn.textContent = 'Instalando…'; }
      try {
        const r = await api('/api/winservices/install', { method: 'POST', body: JSON.stringify(payload) });
        closeModal();
        toast('Servicio instalado', r.service || 'Correcto', 'ok');
        await loadWindows(true);
      } catch (e) {
        toast('No se pudo instalar', e.message, 'err');
        if (btn) { btn.disabled = false; btn.textContent = 'Agregar'; }
      }
    } },
  ]);

  const sync = () => {
    const k = $('#winKind').value;
    $('#winCoreFields').hidden = k !== 'core';
    $('#winQueueFields').hidden = k !== 'queue';
    $('#winCustomFields').hidden = k !== 'custom';
  };
  $('#winKind').addEventListener('change', sync);
  sync();
}

function winInstallFrom(value) {
  if (value.startsWith('core:')) winInstallModal({ kind: 'core', key: value.slice(5) });
  else if (value.startsWith('queue:')) winInstallModal({ kind: 'queue', name: value.slice(6) });
  else winInstallModal({ kind: 'custom', name: value });
}

function bindWindows() {
  $('#winRefresh').addEventListener('click', () => loadWindows());
  $('#winAddBtn').addEventListener('click', () => winInstallModal());
  $('#winSearchBtn').addEventListener('click', winSearch);
  $('#winSearch').addEventListener('keydown', e => { if (e.key === 'Enter') winSearch(); });
  $('#winQueueSearch').addEventListener('input', e => { winQueueFilter = e.target.value; renderWindows(); });
  $('#winQueueOnly').addEventListener('change', renderWindows);
  const click = e => {
    const install = e.target.closest('[data-win-install]');
    if (install) { winInstallFrom(install.dataset.winInstall); return; }
    const act = e.target.closest('[data-win-act]');
    if (act) { winAction(act.dataset.winName, act.dataset.winAct); return; }
    const logs = e.target.closest('[data-win-logs]');
    if (logs) { winLogs(logs.dataset.winLogs); return; }
    const adopt = e.target.closest('[data-win-adopt]');
    if (adopt) { winAdopt(adopt.dataset.winAdopt); return; }
    const forget = e.target.closest('[data-win-forget]');
    if (forget) { winForget(forget.dataset.winForget); }
  };
  ['winCore', 'winQueues', 'winManaged', 'winDiscovered'].forEach(id => $('#' + id).addEventListener('click', click));
}


async function loadDatabases(refresh = false) {
  try {
    const r = await api(`/api/databases${refresh ? '?refresh=1' : ''}`);
    databases = r.databases || [];
    renderDatabases();
  } catch (e) {
    toast('No se pudieron cargar las bases', e.message, 'err');
  }
}

function renderDatabases() {
  const q = ($('#dbSearch').value || '').toLowerCase().trim();
  const list = databases.filter(d => !q || d.name.toLowerCase().includes(q));
  const body = $('#dbBody');
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">Sin resultados.</td></tr>`;
    return;
  }
  body.innerHTML = list.map(d => `<tr>
    <td class="db-name">${esc(d.name)}</td>
    <td>${d.tables}</td>
    <td class="db-size">${fmtMB(d.mb)}</td>
    <td class="right"><button class="btn ghost" data-dump="${esc(d.name)}">Dump</button> <button class="btn danger" data-drop="${esc(d.name)}">Borrar</button></td>
  </tr>`).join('');
}

function renderPhp(o) {
  if (!o || !o.php) return;
  const active = o.php.active;
  const grid = $('#phpGrid');
  grid.innerHTML = o.php.versions.map(p => {
    const isActive = p.short === active;
    return `<article class="php-card ${isActive ? 'active' : ''}">
      <div class="php-head">
        <div>
          <div class="php-version">${esc(p.short)}</div>
          <div class="php-branch">PHP ${esc(p.branch)} · ZTS x64</div>
        </div>
        <span class="badge ${isActive ? '' : 'gray'}">${isActive ? 'Activo' : 'Disponible'}</span>
      </div>
      <div class="php-ext">
        <span class="chip">sqlsrv</span>
        <span class="chip">pdo_sqlsrv</span>
        <span class="chip">OPcache</span>
        ${p.branch === '8.2' ? '<span class="chip">driver 5.12.0</span>' : '<span class="chip">driver 5.13.3</span>'}
      </div>
      ${isActive
        ? '<button class="btn ghost" disabled>En uso</button>'
        : `<button class="btn primary" data-php="${esc(p.branch)}">Activar</button>`}
    </article>`;
  }).join('');
}

async function switchPhp(branch) {
  if (busy) return;
  busy = true;
  try {
    const r = await api('/api/php', { method: 'POST', body: JSON.stringify({ branch }) });
    toast(`PHP ${r.active} activado`, 'Apache se reinició con la nueva versión', 'ok');
  } catch (e) {
    toast('No se pudo cambiar PHP', e.message, 'err');
  } finally {
    busy = false;
    await refreshOverview(true);
  }
}

async function loadLogServices() {
  try {
    const r = await api('/api/services');
    const sel = $('#logService');
    const current = logService;
    const opts = [
      '<option value="apache">Apache</option>',
      '<option value="mysql">MySQL</option>',
    ];
    for (const n of (r.nodes || [])) opts.push(`<option value="node:${esc(n.name)}">Node · ${esc(n.name)}</option>`);
    sel.innerHTML = opts.join('');
    if (Array.from(sel.options).some(o => o.value === current)) sel.value = current;
    else { logService = 'apache'; sel.value = 'apache'; }
  } catch {}
}

async function loadLogs() {
  try {
    const r = await api(`/api/logs?service=${encodeURIComponent(logService)}`);
    lastLogText = r.text || '';
    const meta = $('#logPath');
    if (meta) meta.innerHTML = r.file ? `<span class="mono">${esc(r.file)}</span>` : '<span>sin archivo de log para este servicio</span>';
    renderLogText();
  } catch (e) {
    lastLogText = '';
    $('#logBox').innerHTML = `<span class="log-line error">Error: ${esc(e.message)}</span>`;
  }
}

function renderLogText() {
  const box = $('#logBox');
  const q = ($('#logSearch').value || '').toLowerCase().trim();
  const lines = (lastLogText || '').split(/\r?\n/);
  const filtered = q ? lines.filter(l => l.toLowerCase().includes(q)) : lines;
  if (!filtered.length || (filtered.length === 1 && !filtered[0].trim())) {
    box.innerHTML = '<span class="muted">(sin registros)</span>';
    return;
  }
  box.innerHTML = filtered.map(line => {
    const cls = /error|exception|fatal|failed|denied|no se pudo/i.test(line) ? 'error'
      : /warn|deprecated/i.test(line) ? 'warn' : '';
    return `<div class="log-line ${cls}">${esc(line) || '&nbsp;'}</div>`;
  }).join('');
  if ($('#logAuto').checked) box.scrollTop = box.scrollHeight;
}

function downloadLog() {
  const blob = new Blob([lastLogText || ''], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `laragon-${logService.replace(':', '-')}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function dumpDb(name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await api('/api/dump', { method: 'POST', body: JSON.stringify({ db: name }) });
    toast(`Dump de ${name}`, `${r.mb} MB · ${r.file}`, 'ok');
  } catch (e) {
    toast('Error al generar dump', e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Dump'; }
  }
}

async function openPort(port) {
  try {
    await api('/api/open', { method: 'POST', body: JSON.stringify({ port }) });
  } catch (e) {
    toast('No se pudo abrir', e.message, 'err');
  }
}

async function openPath(path) {
  try {
    await api('/api/open-path', { method: 'POST', body: JSON.stringify({ path }) });
  } catch (e) {
    toast('No se pudo abrir la ruta', e.message, 'err');
  }
}

async function openTool(path, tool) {
  try {
    await api('/api/open-tool', { method: 'POST', body: JSON.stringify({ path, tool }) });
  } catch (e) {
    toast('No se pudo abrir', e.message, 'err');
  }
}

const LOG_RANGES = [
  ['15m', 'Últimos 15 min', 15 * 60 * 1000],
  ['1h', 'Última hora', 60 * 60 * 1000],
  ['24h', 'Últimas 24 h', 24 * 60 * 60 * 1000],
  ['7d', 'Últimos 7 días', 7 * 24 * 60 * 60 * 1000],
  ['all', 'Todo', 0],
];
async function openDir(kind) {
  try {
    const r = await api('/api/open-dir', { method: 'POST', body: JSON.stringify({ kind }) });
    if (!r.ok) throw new Error(r.error || 'No se pudo abrir');
  } catch (e) {
    toast('No se pudo abrir', e.message, 'err');
  }
}

async function openPortsModal() {
  let list = projects;
  if (!list.length) {
    try { const r = await api('/api/projects'); list = r.projects || []; } catch { list = []; }
  }
  const rows = list.slice().sort((a, b) => a.port - b.port).map(p => `<tr>
      <td class="mono">:${p.port}</td>
      <td>${esc(p.name)}</td>
      <td class="mono small">${esc(p.root || '')}</td>
      <td>${esc(p.type || '')}</td>
    </tr>`).join('');
  const body = `<div class="muted" style="margin-bottom:12px">Mapeo real de puertos: se toma de <code>httpd-vhosts.conf</code> y se completa con las carpetas de <code>www</code> que no tienen vhost.</div>
    <div class="ports-table">
      <table>
        <thead><tr><th>Puerto</th><th>Proyecto</th><th>Carpeta</th><th>Tipo</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Sin proyectos</td></tr>'}</tbody>
      </table>
    </div>`;
  showModal('Puertos y proyectos', body, [
    { label: 'puertos.csv', class: 'ghost', onClick: () => openDir('ports') },
    { label: 'httpd-vhosts.conf', class: 'ghost', onClick: () => openDir('vhosts') },
    { label: 'Cerrar', onClick: closeModal },
  ], true);
}

let logCtx = { port: 0, name: '', file: '', range: '24h' };

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

async function showProjectLog(port, name) {
  logCtx = { port, name, file: '', range: '24h' };
  showModal(`Logs · ${name}`, '<div class="muted">Buscando archivos de log…</div>', [{ label: 'Cerrar', onClick: closeModal }], true);
  await renderLogPanel();
}

async function renderLogPanel() {
  const { port, name } = logCtx;
  let files = [];
  try {
    const r = await api(`/api/project-logs?port=${port}`);
    files = r.files || [];
  } catch (e) {
    toast('No se pudieron leer los logs', e.message, 'err');
  }
  if (!files.length) {
    $('#modalBody').innerHTML = `<div class="muted">Este proyecto no tiene archivos de log todavía.<br>
      Se buscan en <code>storage/logs/*.log</code>, en los <code>ErrorLog</code>/<code>CustomLog</code> del vhost y en el log de Node.</div>`;
    return;
  }
  if (!logCtx.file || !files.some(f => f.id === logCtx.file)) logCtx.file = files[0].id;
  const options = files.map(f => `<option value="${esc(f.id)}" ${f.id === logCtx.file ? 'selected' : ''}>${esc(f.label)} · ${fmtBytes(f.size)}</option>`).join('');
  const ranges = LOG_RANGES.map(([value, label]) => `<option value="${value}" ${value === logCtx.range ? 'selected' : ''}>${label}</option>`).join('');
  $('#modalBody').innerHTML = `
    <div class="log-tools">
      <select id="logFile" class="search">${options}</select>
      <select id="logRange" class="search">${ranges}</select>
      <button class="btn ghost" id="logRefresh">Actualizar</button>
      <button class="btn ghost danger" id="logClear">Vaciar</button>
    </div>
    <div class="log-meta" id="logMeta"></div>
    <pre class="log" id="logPre">cargando…</pre>`;
  $('#logFile').onchange = e => { logCtx.file = e.target.value; loadLogText(); };
  $('#logRange').onchange = e => { logCtx.range = e.target.value; loadLogText(); };
  $('#logRefresh').onclick = () => renderLogPanel();
  $('#logClear').onclick = () => clearProjectLog();
  loadLogText();
}

async function loadLogText() {
  const pre = $('#logPre');
  if (!pre) return;
  const meta = $('#logMeta');
  const range = LOG_RANGES.find(r => r[0] === logCtx.range) || LOG_RANGES[4];
  const since = range[2] ? Date.now() - range[2] : 0;
  pre.textContent = 'cargando…';
  try {
    let r = await api(`/api/project-log?port=${logCtx.port}&file=${encodeURIComponent(logCtx.file)}&since=${since}&lines=800`);
    let fallback = false;
    if (since && !r.lines) {
      r = await api(`/api/project-log?port=${logCtx.port}&file=${encodeURIComponent(logCtx.file)}&since=0&lines=800`);
      fallback = true;
    }
    const lines = r.text ? r.text.split('\n').filter(l => l.length) : [];
    pre.textContent = lines.length ? r.text : '(el archivo está vacío)';
    if (meta) {
      const extra = [];
      if (r.entries) extra.push(`${r.entries} eventos`);
      extra.push(`${lines.length} líneas`);
      extra.push(fallback ? 'sin actividad en el rango, mostrando lo último' : range[1]);
      if (r.cut) extra.push('recortado al final');
      if (r.truncated) extra.push('leyendo el final del archivo');
      meta.innerHTML = `<span>${esc(r.label || 'log')}</span><span class="mono">${esc(r.file || '')}</span>
        <span>${fmtBytes(r.size)} · ${esc(extra.join(' · '))}</span>`;
    }
  } catch (e) {
    pre.textContent = `No se pudo leer el log: ${e.message}`;
  }
}

async function clearProjectLog() {
  const file = logCtx.file;
  if (!file) return;
  if (!confirm('¿Vaciar este log? Se guarda una copia del contenido anterior en el mismo archivo con extensión .old.')) return;
  try {
    const r = await api('/api/project-log/clear', { method: 'POST', body: JSON.stringify({ port: logCtx.port, file }) });
    toast('Log vaciado', `${fmtBytes(r.freed)} liberados`, 'ok');
    await renderLogPanel();
  } catch (e) {
    toast('No se pudo vaciar el log', e.message, 'err');
  }
}

function closeModal() {
  $('#modal').classList.remove('open');
  const box = $('#modal').querySelector('.modal');
  if (box) box.classList.remove('wide');
  $('#modalBody').innerHTML = '';
  $('#modalFoot').innerHTML = '';
}

function showModal(title, body, actions = [], wide = false) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const box = $('#modal').querySelector('.modal');
  if (box) box.classList.toggle('wide', !!wide);
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.class || 'ghost'}`;
    b.textContent = a.label;
    b.onclick = a.onClick;
    foot.appendChild(b);
  }
  $('#modal').classList.add('open');
}

function newSiteModal() {
  showModal('Nuevo sitio', `
    <div class="field"><label>Nombre</label><input id="siteName" placeholder="mi-proyecto"></div>
    <div class="field"><label>Tipo</label><select id="siteType">
      <option value="php">PHP puro</option>
      <option value="html">HTML estático</option>
      <option value="laravel">Laravel (Composer)</option>
      <option value="node">Node.js (servidor propio)</option>
      <option value="link">Enlazar carpeta existente</option>
    </select><small>Node.js se publica por Apache como proxy en el puerto asignado.</small></div>
    <div class="field" id="sitePathWrap" style="display:none">
      <label>Carpeta existente</label>
      <input id="sitePath" placeholder="C:\\ruta\\proyecto">
      <small>Se usará el nombre de la carpeta.</small>
    </div>
  `, [
    { label: 'Cancelar', onClick: closeModal },
    { label: 'Crear', class: 'primary', onClick: async () => {
      const name = $('#siteName').value.trim();
      const type = $('#siteType').value;
      const path = $('#sitePath').value.trim();
      if (!name && type !== 'link') { toast('Falta el nombre', '', 'err'); return; }
      const btn = document.querySelector('#modalFoot .btn.primary');
      if (btn) { btn.disabled = true; btn.textContent = 'Creando…'; }
      try {
        const r = await api('/api/site', { method: 'POST', body: JSON.stringify({ name, type, path }) });
        closeModal();
        toast('Sitio creado', `${r.project.name} → ${r.project.url}`, 'ok');
        await loadProjects();
        await refreshOverview(true);
      } catch (e) {
        toast('No se pudo crear', e.message, 'err');
        if (btn) { btn.disabled = false; btn.textContent = 'Crear'; }
      }
    } },
  ]);
  $('#siteType').onchange = () => {
    $('#sitePathWrap').style.display = $('#siteType').value === 'link' ? '' : 'none';
  };
}

function newDbModal() {
  showModal('Nueva base de datos', `
    <div class="field"><label>Nombre</label><input id="dbName" placeholder="mi_base"></div>
    <p class="muted small">Se crea en MySQL 8.4 (puerto 3308) con utf8mb4.</p>
  `, [
    { label: 'Cancelar', onClick: closeModal },
    { label: 'Crear', class: 'primary', onClick: async () => {
      const name = $('#dbName').value.trim();
      if (!name) return;
      try {
        await api('/api/db', { method: 'POST', body: JSON.stringify({ action: 'create', name }) });
        closeModal();
        toast('Base creada', name, 'ok');
        loadDatabases(true);
      } catch (e) { toast('No se pudo crear', e.message, 'err'); }
    } },
  ]);
}

async function importModal() {
  try {
    const r = await api('/api/backups');
    const list = r.backups || [];
    if (!list.length) { toast('No hay dumps', 'Copia un .sql a C:\\laragon\\backups\\db', 'err'); return; }
    const opts = list.map(b => `<option value="${esc(b.file)}">${esc(b.name)} (${b.mb} MB)</option>`).join('');
    showModal('Importar dump', `
      <div class="field"><label>Archivo .sql</label><select id="impFile">${opts}</select></div>
      <p class="muted small">El dump crea o usa su propia base de datos.</p>
    `, [
      { label: 'Cancelar', onClick: closeModal },
      { label: 'Importar', class: 'primary', onClick: async () => {
        const file = $('#impFile').value;
        const btn = document.querySelector('#modalFoot .btn.primary');
        if (btn) { btn.disabled = true; btn.textContent = 'Importando…'; }
        try {
          await api('/api/import', { method: 'POST', body: JSON.stringify({ file }) });
          closeModal();
          toast('Dump importado', '', 'ok');
          loadDatabases(true);
        } catch (e) {
          toast('Error al importar', e.message, 'err');
          if (btn) { btn.disabled = false; btn.textContent = 'Importar'; }
        }
      } },
    ]);
  } catch (e) { toast('No se pudieron listar los dumps', e.message, 'err'); }
}

async function backupAll() {
  if (busy) return;
  busy = true;
  toast('Generando backup total…', 'Puede tardar unos segundos');
  try {
    const r = await api('/api/backup-all', { method: 'POST' });
    toast('Backup total listo', `${r.mb} MB · ${r.file}`, 'ok');
  } catch (e) {
    toast('Error en el backup', e.message, 'err');
  } finally { busy = false; }
}

function dropDb(name) {
  showModal('Borrar base de datos', `
    <p>¿Seguro que quieres borrar <strong>${esc(name)}</strong>?</p>
    <p class="muted small">Esta acción no se puede deshacer.</p>
  `, [
    { label: 'Cancelar', onClick: closeModal },
    { label: 'Borrar', class: 'danger', onClick: async () => {
      try {
        await api('/api/db', { method: 'POST', body: JSON.stringify({ action: 'drop', name }) });
        closeModal();
        toast('Base borrada', name, 'ok');
        loadDatabases(true);
      } catch (e) { toast('No se pudo borrar', e.message, 'err'); }
    } },
  ]);
}

async function loadExtensions() {
  try {
    const r = await api('/api/extensions');
    renderExtensions(r.extensions || []);
  } catch (e) {
    toast('No se pudieron leer las extensiones', e.message, 'err');
  }
}

function renderExtensions(list) {
  const grid = $('#extGrid');
  if (!grid) return;
  $('#extPhp').textContent = lastOverview?.php?.active || '—';
  grid.innerHTML = list.map(e => `<div class="ext-item">
    <div>
      <div class="ext-name">${esc(e.name)}</div>
      <div class="ext-state">${e.enabled ? 'activa' : 'desactivada'}</div>
    </div>
    <button class="toggle ${e.enabled ? 'on' : ''}" data-ext="${esc(e.name)}" data-enabled="${e.enabled ? 1 : 0}">
      ${e.enabled ? 'ON' : 'OFF'}
    </button>
  </div>`).join('');
}

async function toggleExt(name, enabled) {
  try {
    const r = await api('/api/extensions', { method: 'POST', body: JSON.stringify({ name, enabled }) });
    renderExtensions(r.extensions || []);
    toast(`Extensión ${name}`, enabled ? 'activada' : 'desactivada', 'ok');
    await refreshOverview(true);
  } catch (e) {
    toast('No se pudo cambiar', e.message, 'err');
  }
}

function copyText(text, label = '') {
  const done = () => toast('Copiado', label, 'ok');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch { toast('No se pudo copiar', text, 'err'); }
    ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

async function loadShare() {
  try {
    shareData = await api('/api/network');
    if (!shareIp) shareIp = shareData.primary;
    renderShare();
  } catch (e) {
    toast('No se pudo leer la red', e.message, 'err');
  }
}

function renderShare() {
  if (!shareData) return;
  const ips = shareData.ips.length ? shareData.ips : [{ name: 'Local', address: '127.0.0.1' }];
  if (!shareIp || !ips.some(i => i.address === shareIp)) shareIp = shareData.primary || ips[0].address;
  const sel = $('#shareIp');
  sel.innerHTML = ips.map(i => `<option value="${esc(i.address)}">${esc(i.address)} · ${esc(i.name)}</option>`).join('');
  sel.value = shareIp;

  const base = `http://${shareIp}:${shareData.lanPort}`;
  $('#shareLanUrl').value = `${base}/?key=${shareData.key}`;
  $('#shareKey').value = shareData.key;
  $('#shareLocalUrl').textContent = shareData.localUrl || `http://127.0.0.1:${location.port || '9090'}`;
  $('#shareLanPort').textContent = `puerto ${shareData.lanPort}`;
  $('#shareCount').textContent = `${shareData.projects.length} proyectos`;
  $('#shareProjects').innerHTML = shareData.projects.map(p => `<div class="share-item">
    <div>
      <div class="project-name">${esc(p.name)}</div>
      <code>http://${shareIp}:${p.port}</code>
    </div>
    <div class="share-actions">
      <button class="btn ghost" data-copy-url="http://${shareIp}:${p.port}">Copiar</button>
      <button class="btn primary" data-open-url="http://${shareIp}:${p.port}">Abrir</button>
    </div>
  </div>`).join('');
}

async function openFirewall() {
  try {
    const r = await api('/api/firewall', { method: 'POST' });
    toast('Firewall', r.message || 'Acepta el aviso de UAC', 'ok');
  } catch (e) {
    toast('No se pudo configurar', e.message, 'err');
  }
}

async function loadDesktopSettings() {
  const box = $('#desktopSettings');
  if (!box) return;
  if (!window.desktop) {
    box.innerHTML = '<div class="muted">Abre <strong>Laragon Panel Desktop</strong> para controlar notificaciones y el inicio con Windows.</div>';
    return;
  }
  try {
    const s = await window.desktop.status();
    box.innerHTML = `
      <div>
        <span>Iniciar con Windows</span>
        <label class="check-label"><input type="checkbox" id="deskAuto" ${s.autostart ? 'checked' : ''}> ${s.autostart ? 'Activado' : 'Desactivado'}</label>
      </div>
      <div>
        <span>Notificaciones</span>
        <label class="check-label"><input type="checkbox" id="deskNotif" ${s.notifications ? 'checked' : ''}> ${s.notifications ? 'Activadas' : 'Desactivadas'}</label>
      </div>
      <div><span>Bandeja del sistema</span><strong>Activa</strong></div>
      <div><span>Aplicación</span><strong>Electron</strong></div>
    `;
    $('#deskAuto').addEventListener('change', async e => {
      const r = await window.desktop.setAutostart(e.target.checked);
      toast('Inicio con Windows', r.enabled ? 'Activado' : 'Desactivado', r.ok ? 'ok' : 'err');
      loadDesktopSettings();
    });
    $('#deskNotif').addEventListener('change', async e => {
      await window.desktop.setNotifications(e.target.checked);
      toast('Notificaciones', e.target.checked ? 'Activadas' : 'Desactivadas', 'ok');
      loadDesktopSettings();
    });
  } catch (e) {
    box.innerHTML = `<div class="muted">No disponible: ${esc(e.message)}</div>`;
  }
}

/* ---------------- Respaldos ---------------- */

const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function scheduleText(job) {
  const s = job.schedule || {};
  if (s.type === 'manual') return 'Solo manual';
  if (s.type === 'daily') return `Diaria · ${s.time}`;
  if (s.type === 'weekly') {
    const days = (s.days || []).map(d => DAY_LABELS[d]).join(', ');
    return `Semanal · ${days || 'sin días'} · ${s.time}`;
  }
  if (s.type === 'window') {
    const days = (s.days || []).map(d => DAY_LABELS[d]).join(', ');
    const start = String(Number(s.startHour) || 0).padStart(2, '0');
    const end = String(Number(s.endHour) || 24).padStart(2, '0');
    return `${days || 'sin días'} · ${start}:00–${end}:00 · cada ${s.every || 2} h`;
  }
  return `Cada ${s.every || 24} h`;
}

function taskStateLabel(state) {
  const map = {
    Ready: 'Lista', Running: 'Ejecutando', Disabled: 'Deshabilitada',
    Queued: 'En cola', Unknown: 'Desconocida',
  };
  return map[state] || state || 'Desconocida';
}

function renderBackupStatus() {
  const box = $('#backupProgress');
  if (!box) return;
  const st = backupData.state || {};
  const running = !!(backupData.running || st.running);
  box.hidden = !running;
  if (!running) return;
  $('#backupProgressTitle').textContent = st.jobName ? `Respaldando «${st.jobName}»` : 'Respaldando…';
  const total = Number(st.total) || 0;
  const done = Number(st.done) || 0;
  $('#backupProgressText').textContent = `${st.step || 'Preparando'}${total ? ` · ${done}/${total}` : ''}`;
  $('#backupProgressBar').style.width = `${Math.min(100, Math.max(0, Number(st.pct) || 0))}%`;
}

function renderBackupJobs() {
  const wrap = $('#backupJobs');
  if (!wrap) return;
  const jobs = backupData.jobs || [];
  if (!jobs.length) {
    wrap.innerHTML = `<div class="card panel backup-empty">
      <div class="backup-empty-icon">⛁</div>
      <h3>Sin tareas de respaldo</h3>
      <p>Crea una tarea para copiar tus bases de datos y los archivos de tus proyectos a otro disco.
      Puedes programarla para que Windows la ejecute aunque el panel esté cerrado.</p>
      <button class="btn primary" id="emptyNewBackup">Crear primera tarea</button>
    </div>`;
    return;
  }

  const catalogDbs = (backupData.catalog && backupData.catalog.databases) || [];
  const catalogPrjs = (backupData.catalog && backupData.catalog.projects) || [];

  wrap.innerHTML = jobs.map(job => {
    const task = (backupData.tasks || {})[`LaragonPanel_Backup_${job.id}`];
    const last = job.last;
    const manual = job.schedule.type === 'manual';
    const taskBadge = manual
      ? '<span class="badge gray">Solo manual</span>'
      : !job.enabled
        ? '<span class="badge gray">Pausada</span>'
        : task
          ? `<span class="badge">${esc(taskStateLabel(task))}</span>`
          : '<span class="badge err">No registrada</span>';
    const dbs = job.databases.mode === 'all' ? (catalogDbs.length || 'Todas') : job.databases.list.length;
    const prjs = job.projects.mode === 'all' ? (catalogPrjs.length || 'Todos') : job.projects.list.length;
    const lastLine = last
      ? `<span class="dot ${last.ok ? 'up' : 'down'}"></span> Último: ${esc(fmtDate(last.at))} · ${last.ok ? 'correcto' : 'con errores'} · ${fmtMB(Number(last.mb) || 0)}`
      : `<span class="dot"></span> Sin ejecuciones todavía`;
    const skipLine = job.lastSkipAt && !last
      ? `<span class="muted small">· Último intento omitido (disco no conectado)</span>`
      : '';
    return `<article class="card backup-card">
      <div class="backup-card-head">
        <div style="min-width:0">
          <div class="backup-job-name">${esc(job.name)}</div>
          <div class="backup-dest">${esc(job.destination)}</div>
        </div>
        <span class="badge ${job.enabled ? '' : 'gray'}">${job.enabled ? 'Activa' : 'Pausada'}</span>
      </div>
      <div class="backup-meta">
        <div><span>Frecuencia</span><strong>${esc(scheduleText(job))}</strong></div>
        <div><span>Retención</span><strong>${job.retention ? `${job.retention} copias` : 'Sin límite'}${job.retentionDays ? ` · ${job.retentionDays} días` : ''}</strong></div>
        <div><span>Este mes</span><strong>${job.monthlyRuns || 0}${job.maxPerMonth ? ` / ${job.maxPerMonth}` : ''}</strong></div>
        <div><span>Bases</span><strong>${dbs}</strong></div>
        <div><span>Proyectos</span><strong>${prjs}</strong></div>
        <div><span>Formato</span><strong>${job.compress !== false ? 'ZIP por proyecto' : 'Carpetas + SQL'}</strong></div>
      </div>
      <div class="backup-last">${lastLine} ${skipLine}</div>
      <div class="backup-taskline">
        <span>Programador de Windows:</span>
        ${taskBadge}
      </div>
      <div class="backup-actions">
        <button class="btn primary" data-brun="${job.id}" ${backupData.running ? 'disabled' : ''}>Ejecutar ahora</button>
        <button class="btn ghost" data-bedit="${job.id}">Editar</button>
        <button class="btn ghost" data-btoggle="${job.id}">${job.enabled ? 'Pausar' : 'Activar'}</button>
        <button class="btn ghost" data-bfolder="${job.id}">Abrir carpeta</button>
        <button class="btn danger" data-bdel="${job.id}">Eliminar</button>
      </div>
    </article>`;
  }).join('');
}

function renderBackupHistory() {
  const body = $('#backupHistoryBody');
  if (!body) return;
  const list = (backupData.history || []).slice(0, 25);
  $('#backupHistoryInfo').textContent = list.length ? `${list.length} ejecuciones recientes` : 'sin ejecuciones';
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">Todavía no hay respaldos registrados.</td></tr>';
    return;
  }
  body.innerHTML = list.map(h => {
    const status = h.skipped
      ? '<span class="badge gray">Omitido</span>'
      : h.ok ? '<span class="badge ok">Correcto</span>' : '<span class="badge err">Error</span>';
    const detail = h.skipped
      ? (h.message || 'Disco no conectado')
      : h.ok
        ? `${h.databases || 0} bases · ${h.projects || 0} proyectos${h.compress ? ' · ZIP' : ''}`
        : ((h.errors && h.errors.length) ? h.errors[0] : (h.error || 'Error'));
    return `<tr>
      <td class="db-size">${esc(fmtDate(h.at))}</td>
      <td class="db-name">${esc(h.name || '—')}</td>
      <td>${h.trigger === 'programado' ? 'Programado' : 'Manual'}</td>
      <td class="db-size">${h.durationSec || 0} s</td>
      <td class="db-size">${fmtMB(Number(h.mb) || 0)}</td>
      <td>${status}</td>
      <td class="db-size" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(detail)}">${esc(detail)}</td>
    </tr>`;
  }).join('');
}

async function loadBackups(silent = false) {
  try {
    const r = await api('/api/backup/jobs');
    backupData = r;
    renderBackupJobs();
    renderBackupHistory();
    renderBackupStatus();
    if (r.running) startBackupPolling();
  } catch (e) {
    if (!silent) toast('No se pudieron cargar los respaldos', e.message, 'err');
  }
}

function startBackupPolling() {
  if (backupPoll) return;
  const started = Date.now();
  backupPoll = setInterval(async () => {
    if (currentView !== 'backups') {
      clearInterval(backupPoll);
      backupPoll = null;
      return;
    }
    try {
      const s = await api('/api/backup/status');
      if (!s.running && Date.now() - started < 8000) return;
      backupData.running = !!s.running;
      backupData.state = s.state || {};
      renderBackupStatus();
      renderBackupJobs();
      if (!s.running) {
        clearInterval(backupPoll);
        backupPoll = null;
        const last = s.state && s.state.last;
        await loadBackups(true);
        if (last) {
          toast(
            last.ok ? 'Respaldo completado' : 'Respaldo con errores',
            `${fmtMB(Number(last.mb) || 0)} · ${last.durationSec || 0} s${last.ok ? '' : ' · revisa el historial'}`,
            last.ok ? 'ok' : 'err'
          );
        }
      }
    } catch {}
  }, 2000);
}

async function runBackupJob(id) {
  if (busy) return;
  busy = true;
  try {
    await api('/api/backup/run', { method: 'POST', body: JSON.stringify({ id }) });
    backupData.running = true;
    backupData.state = { running: true, jobName: (backupData.jobs.find(j => j.id === id) || {}).name, step: 'Iniciando', pct: 0 };
    renderBackupStatus();
    renderBackupJobs();
    toast('Respaldo iniciado', 'Se ejecuta en segundo plano; puedes seguir usando el panel', 'ok');
    startBackupPolling();
  } catch (e) {
    toast('No se pudo iniciar el respaldo', e.message, 'err');
  } finally {
    busy = false;
  }
}

async function applyBackupTasks() {
  const btn = $('#backupApply');
  if (btn) { btn.disabled = true; btn.textContent = 'Aplicando…'; }
  try {
    const r = await api('/api/backup/apply', { method: 'POST' });
    toast('Reglas aplicadas', `${r.count || 0} tarea(s) registradas en el Programador de Windows`, 'ok');
    await loadBackups(true);
  } catch (e) {
    toast('No se pudieron aplicar las reglas', e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Aplicar reglas al sistema'; }
  }
}

async function toggleBackupJob(id) {
  const job = (backupData.jobs || []).find(j => j.id === id);
  if (!job) return;
  try {
    const r = await api('/api/backup/job', {
      method: 'POST',
      body: JSON.stringify({ ...job, enabled: !job.enabled }),
    });
    toast(r.job.enabled ? 'Tarea activada' : 'Tarea pausada', job.name, 'ok');
    await loadBackups(true);
  } catch (e) {
    toast('No se pudo cambiar el estado', e.message, 'err');
  }
}

function deleteBackupJobModal(id) {
  const job = (backupData.jobs || []).find(j => j.id === id);
  if (!job) return;
  showModal('Eliminar tarea de respaldo', `
    <p>¿Eliminar <strong>${esc(job.name)}</strong>?</p>
    <p class="muted small">Se quita la tarea y su regla de Windows, pero <strong>no se borran las copias</strong> que ya existen en el disco.</p>
  `, [
    { label: 'Cancelar', onClick: closeModal },
    { label: 'Eliminar', class: 'danger', onClick: async () => {
      try {
        await api('/api/backup/delete', { method: 'POST', body: JSON.stringify({ id }) });
        closeModal();
        toast('Tarea eliminada', job.name, 'ok');
        await loadBackups(true);
      } catch (e) {
        toast('No se pudo eliminar', e.message, 'err');
      }
    } },
  ]);
}

async function openBackupFolder(id) {
  try {
    const r = await api('/api/backup/open', { method: 'POST', body: JSON.stringify({ id }) });
    toast('Carpeta abierta', r.path, 'ok');
  } catch (e) {
    toast('Todavía no hay copias', e.message, 'err');
  }
}

function backupJobModal(job = null) {
  const drives = (backupData.drives || []).slice().sort((a, b) =>
    (a.root.toUpperCase() === 'C:\\' ? 1 : 0) - (b.root.toUpperCase() === 'C:\\' ? 1 : 0));
  const catalog = backupData.catalog || { databases: [], projects: [] };
  const dbs = catalog.databases || [];
  const prjs = catalog.projects || [];

  const parsed = /^([A-Za-z]:\\)(.*)$/.exec(job ? job.destination : '');
  const preferred = drives.find(d => d.root.toUpperCase() !== 'C:\\') || drives[0];
  const drive = parsed ? parsed[1].toUpperCase() : (preferred ? preferred.root : 'D:\\');
  const sub = parsed ? parsed[2] : 'RespaldosLaragon';

  const s = job ? job.schedule : { type: 'daily', time: '02:00', days: [1, 2, 3, 4, 5], every: 24, startHour: 4, endHour: 18 };
  const dbSel = new Set(job ? job.databases.list : []);
  const prjSel = new Set(job ? job.projects.list : []);
  const dbMode = job ? job.databases.mode : 'all';
  const prjMode = job ? job.projects.mode : 'all';

  const driveOptions = drives.length
    ? drives.map(d => `<option value="${esc(d.root)}" ${d.root.toUpperCase() === drive.toUpperCase() ? 'selected' : ''}>${esc(d.label)} — ${d.freeGB} GB libres${d.removable ? ' (extraíble)' : ''}</option>`).join('')
    : `<option value="D:\\">D:\\</option>`;

  const dbRows = dbs.length
    ? dbs.map(d => `<label class="check-row">
        <input type="checkbox" class="bjDb" value="${esc(d.name)}" ${dbSel.has(d.name) ? 'checked' : ''}>
        <span>${esc(d.name)}</span><em>${fmtMB(Number(d.mb) || 0)} · ${Number(d.tables) || 0} tablas</em>
      </label>`).join('')
    : '<div class="muted small" style="padding:8px">No se pudieron leer las bases. Inicia MySQL y vuelve a abrir esta ventana.</div>';

  const prjRows = prjs.length
    ? prjs.map(p => {
        const dbLabel = (p.databases && p.databases.length) ? p.databases.join(', ') : 'sin base detectada';
        return `<label class="check-row">
          <input type="checkbox" class="bjPrj" value="${esc(p.name)}" ${prjSel.has(p.name) ? 'checked' : ''}>
          <span>${esc(p.name)}</span><em title="${esc(dbLabel)}">${esc(dbLabel)}</em>
        </label>`;
      }).join('')
    : '<div class="muted small" style="padding:8px">No se encontraron proyectos.</div>';

  const dayChecks = DAY_LABELS.map((label, i) =>
    `<label><input type="checkbox" class="bjDay" value="${i}" ${(s.days || []).includes(i) ? 'checked' : ''}> ${label}</label>`).join('');

  const linkedProjects = prjs.filter(p => (p.databases || []).length).length;
  const linkedDbs = new Set(prjs.flatMap(p => p.databases || [])).size;
  const mappingInfo = linkedDbs
    ? `Detección: ${linkedProjects} proyectos con base · ${linkedDbs} bases vinculadas.`
    : 'No se detectaron bases dentro de los proyectos; las bases elegidas irán a _bases_sin_proyecto.zip.';

  showModal(job ? 'Editar tarea de respaldo' : 'Nueva tarea de respaldo', `
    <div class="form-grid">
      <div class="field full">
        <label>Nombre de la tarea</label>
        <input id="bjName" maxlength="80" value="${esc(job ? job.name : 'Respaldo de Laragon')}" placeholder="Respaldo diario">
      </div>
      <div class="field">
        <label>Disco de destino</label>
        <select id="bjDrive">${driveOptions}</select>
      </div>
      <div class="field">
        <label>Carpeta en el disco</label>
        <input id="bjSub" value="${esc(sub)}" placeholder="RespaldosLaragon">
      </div>
      <div class="dest-preview full" id="bjDestPreview">—</div>
    </div>

    <div class="form-section">
      <h4>Programación</h4>
      <div class="form-grid">
        <div class="field">
          <label>Frecuencia</label>
          <select id="bjFreq">
            <option value="manual" ${s.type === 'manual' ? 'selected' : ''}>Solo manual</option>
            <option value="daily" ${s.type === 'daily' ? 'selected' : ''}>Diaria</option>
            <option value="weekly" ${s.type === 'weekly' ? 'selected' : ''}>Semanal</option>
            <option value="hourly" ${s.type === 'hourly' ? 'selected' : ''}>Cada N horas</option>
            <option value="window" ${s.type === 'window' ? 'selected' : ''}>Por ventana (días y horas)</option>
          </select>
        </div>
        <div class="field" id="bjTimeWrap">
          <label>Hora de inicio</label>
          <input type="time" id="bjTime" value="${esc(s.time || '02:00')}">
        </div>
        <div class="field" id="bjEveryWrap">
          <label>Cada cuántas horas</label>
          <input type="number" min="1" max="168" id="bjEvery" value="${Number(s.every) || 24}">
        </div>
        <div class="field" id="bjStartWrap">
          <label>Desde la hora</label>
          <input type="number" min="0" max="23" id="bjStartHour" value="${Number(s.startHour) || 4}">
        </div>
        <div class="field" id="bjEndWrap">
          <label>Hasta la hora</label>
          <input type="number" min="1" max="24" id="bjEndHour" value="${Number(s.endHour) || 18}">
        </div>
        <div class="field full" id="bjDaysWrap">
          <label>Días de la semana</label>
          <div class="days-row">${dayChecks}</div>
        </div>
        <div class="field">
          <label>Copias a conservar (0 = solo por días)</label>
          <input type="number" min="0" max="1000" id="bjRetention" value="${Number(job ? job.retention : 5)}">
        </div>
        <div class="field">
          <label>Días de retención (0 = sin límite)</label>
          <input type="number" min="0" max="3650" id="bjRetDays" value="${Number(job && job.retentionDays) || 0}">
        </div>
        <div class="field">
          <label>Máximo por mes (0 = sin límite)</label>
          <input type="number" min="0" max="1000" id="bjMaxMonth" value="${Number(job && job.maxPerMonth) || 0}">
        </div>
        <div class="field">
          <label>Estado</label>
          <select id="bjEnabled">
            <option value="1" ${!job || job.enabled ? 'selected' : ''}>Activa</option>
            <option value="0" ${job && !job.enabled ? 'selected' : ''}>Pausada</option>
          </select>
        </div>
      </div>
      <p class="muted small" style="margin:10px 0 0;line-height:1.55">
        Para conservar todas las copias de un mes: <strong>Copias = 0</strong> y
        <strong>Días = 31</strong>. Se borra la más antigua cuando supera ese tiempo.
      </p>
    </div>

    <div class="form-section">
      <h4>Bases de datos</h4>
      <div class="radio-row">
        <label><input type="radio" name="bjDbMode" value="all" ${dbMode === 'all' ? 'checked' : ''}> Todas (${dbs.length})</label>
        <label><input type="radio" name="bjDbMode" value="selected" ${dbMode === 'selected' ? 'checked' : ''}> Seleccionadas</label>
      </div>
      <div class="check-actions">
        <button type="button" class="linkbtn" data-checkall="bjDb">Marcar todas</button>
        <button type="button" class="linkbtn" data-checknone="bjDb">Quitar selección</button>
      </div>
      <div class="check-list" id="bjDbList">${dbRows}</div>
    </div>

    <div class="form-section">
      <h4>Proyectos</h4>
      <div class="radio-row">
        <label><input type="radio" name="bjPrjMode" value="all" ${prjMode === 'all' ? 'checked' : ''}> Todos (${prjs.length})</label>
        <label><input type="radio" name="bjPrjMode" value="selected" ${prjMode === 'selected' ? 'checked' : ''}> Seleccionados</label>
      </div>
      <div class="check-actions">
        <button type="button" class="linkbtn" data-checkall="bjPrj">Marcar todos</button>
        <button type="button" class="linkbtn" data-checknone="bjPrj">Quitar selección</button>
      </div>
      <div class="check-list" id="bjPrjList">${prjRows}</div>
      <p class="muted small" style="margin:8px 0 0" id="bjMappingInfo">${esc(mappingInfo)}</p>
    </div>

    <div class="form-section">
      <h4>Opciones</h4>
      <label class="check-label" style="font-size:12.5px">
        <input type="checkbox" id="bjCompress" ${!job || job.compress !== false ? 'checked' : ''}>
        Comprimir por proyecto: un <strong>ZIP</strong> con el código y sus bases de datos
      </label>
      <p class="muted small" style="margin:8px 0 12px;line-height:1.5">
        Cada proyecto queda en un <code>.zip</code> con su carpeta <code>_database</code> dentro.
        Las bases que no se detecten en ningún proyecto se guardan en <code>_bases_sin_proyecto.zip</code>.
        Si desmarcas esta opción se guardan carpetas y archivos <code>.sql</code> por separado.
      </p>
      <label class="check-label" style="font-size:12.5px">
        <input type="checkbox" id="bjExclude" ${!job || job.excludeDeps ? 'checked' : ''}>
        Omitir <code>node_modules</code>, <code>vendor</code>, <code>.git</code> y carpetas de IDE (más rápido y ocupa menos)
      </label>
      <p class="muted small" style="margin:8px 0 0;line-height:1.5">
        Si las omites, al restaurar necesitarás ejecutar <code>composer install</code> o <code>npm install</code>.
        Desmárcala para una copia idéntica de cada proyecto.
      </p>
    </div>
  `, [
    { label: 'Cancelar', onClick: closeModal },
    { label: job ? 'Guardar cambios' : 'Crear tarea', class: 'primary', onClick: async () => {
      const name = $('#bjName').value.trim();
      const destSub = $('#bjSub').value.trim().replace(/^[\\/]+/, '');
      if (!name) { toast('Falta el nombre', '', 'err'); return; }
      if (!destSub) { toast('Falta la carpeta de destino', 'Ejemplo: RespaldosLaragon', 'err'); return; }
      const dbModeNow = document.querySelector('input[name="bjDbMode"]:checked').value;
      const prjModeNow = document.querySelector('input[name="bjPrjMode"]:checked').value;
      const dbList = $$('.bjDb:checked').map(c => c.value);
      const prjList = $$('.bjPrj:checked').map(c => c.value);
      if (dbModeNow === 'selected' && !dbList.length && prjModeNow === 'selected' && !prjList.length) {
        toast('Selección vacía', 'Marca al menos una base o un proyecto', 'err');
        return;
      }
      const payload = {
        id: job ? job.id : undefined,
        name,
        destination: $('#bjDrive').value + destSub,
        schedule: {
          type: $('#bjFreq').value,
          time: $('#bjTime').value || '02:00',
          every: Number($('#bjEvery').value) || 24,
          days: $$('.bjDay:checked').map(c => Number(c.value)),
          startHour: Number($('#bjStartHour').value) || 0,
          endHour: Number($('#bjEndHour').value) || 24,
        },
        databases: { mode: dbModeNow, list: dbList },
        projects: { mode: prjModeNow, list: prjList },
        excludeDeps: $('#bjExclude').checked,
        compress: $('#bjCompress').checked,
        retention: Number($('#bjRetention').value || 5),
        retentionDays: Number($('#bjRetDays').value) || 0,
        maxPerMonth: Number($('#bjMaxMonth').value) || 0,
        enabled: $('#bjEnabled').value === '1',
      };
      const btn = document.querySelector('#modalFoot .btn.primary');
      if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
      try {
        const r = await api('/api/backup/job', { method: 'POST', body: JSON.stringify(payload) });
        closeModal();
        if (r.taskError) {
          toast('Tarea guardada, pero Windows no registró la regla', r.taskError, 'err');
        } else if (payload.enabled && payload.schedule.type !== 'manual') {
          toast(job ? 'Tarea actualizada' : 'Tarea creada', 'Regla aplicada en el Programador de Windows', 'ok');
        } else {
          toast(job ? 'Tarea actualizada' : 'Tarea creada', 'Se ejecutará solo de forma manual', 'ok');
        }
        await loadBackups(true);
      } catch (e) {
        toast('No se pudo guardar', e.message, 'err');
        if (btn) { btn.disabled = false; btn.textContent = job ? 'Guardar cambios' : 'Crear tarea'; }
      }
    } },
  ]);

  const modalEl = $('#modal').querySelector('.modal');
  if (modalEl) modalEl.classList.add('wide');

  const updateDest = () => {
    const d = $('#bjDrive').value;
    const sub2 = $('#bjSub').value.trim().replace(/^[\\/]+/, '');
    const info = (backupData.drives || []).find(x => x.root.toUpperCase() === d.toUpperCase());
    $('#bjDestPreview').textContent = `${d}${sub2}` + (info ? `  ·  ${info.freeGB} GB libres` : '');
  };
  const syncSchedule = () => {
    const type = $('#bjFreq').value;
    $('#bjTimeWrap').hidden = !['daily', 'weekly'].includes(type);
    $('#bjEveryWrap').hidden = !['hourly', 'window'].includes(type);
    $('#bjDaysWrap').hidden = !['weekly', 'window'].includes(type);
    $('#bjStartWrap').hidden = type !== 'window';
    $('#bjEndWrap').hidden = type !== 'window';
  };
  const syncLists = () => {
    const dm = document.querySelector('input[name="bjDbMode"]:checked').value;
    const pm = document.querySelector('input[name="bjPrjMode"]:checked').value;
    $('#bjDbList').hidden = dm !== 'selected';
    $('#bjPrjList').hidden = pm !== 'selected';
  };

  $('#bjDrive').addEventListener('change', updateDest);
  $('#bjSub').addEventListener('input', updateDest);
  $('#bjFreq').addEventListener('change', syncSchedule);
  $$('input[name="bjDbMode"]').forEach(r => r.addEventListener('change', syncLists));
  $$('input[name="bjPrjMode"]').forEach(r => r.addEventListener('change', syncLists));
  $$('[data-checkall]').forEach(b => b.addEventListener('click', () => {
    $$(`.${b.dataset.checkall}:not(:checked)`).forEach(c => { c.checked = true; });
  }));
  $$('[data-checknone]').forEach(b => b.addEventListener('click', () => {
    $$(`.${b.dataset.checknone}:checked`).forEach(c => { c.checked = false; });
  }));

  updateDest();
  syncSchedule();
  syncLists();
}

function bind() {
  $$('.nav-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#refreshBtn').addEventListener('click', async () => {
    await refreshOverview();
    if (currentView === 'projects') await loadProjects();
    if (currentView === 'databases') await loadDatabases(true);
    if (currentView === 'windows') await loadWindows(true);
    if (currentView === 'backups') await loadBackups(true);
    if (currentView === 'php') await loadExtensions();
    if (currentView === 'logs') await loadLogs();
    toast('Actualizado', '', 'ok');
  });

  $$('[data-service]').forEach(b => b.addEventListener('click', () => serviceAction(b.dataset.service, b.dataset.action)));

  $('#projectGrid').addEventListener('click', e => {
    const tool = e.target.closest('[data-tool]');
    if (tool) { openTool(tool.dataset.root, tool.dataset.tool); return; }
    const log = e.target.closest('[data-log]');
    if (log) { showProjectLog(Number(log.dataset.log), log.dataset.name); return; }
    const b = e.target.closest('[data-open]');
    if (b) openPort(Number(b.dataset.open));
  });
  $('#projectSearch').addEventListener('input', renderProjects);
  $('#newSiteBtn').addEventListener('click', newSiteModal);

  $('#dbBody').addEventListener('click', e => {
    const dump = e.target.closest('[data-dump]');
    if (dump) { dumpDb(dump.dataset.dump, dump); return; }
    const drop = e.target.closest('[data-drop]');
    if (drop) dropDb(drop.dataset.drop);
  });
  $('#dbSearch').addEventListener('input', renderDatabases);
  $('#dbRefresh').addEventListener('click', () => loadDatabases(true));
  $('#newDbBtn').addEventListener('click', newDbModal);
  $('#importBtn').addEventListener('click', importModal);
  $('#backupAllBtn').addEventListener('click', backupAll);

  $('#backupRefresh').addEventListener('click', () => loadBackups());
  $('#newBackupBtn').addEventListener('click', () => backupJobModal());
  $('#backupApply').addEventListener('click', applyBackupTasks);
  $('#backupJobs').addEventListener('click', e => {
    if (e.target.closest('#emptyNewBackup')) { backupJobModal(); return; }
    const run = e.target.closest('[data-brun]');
    if (run) { runBackupJob(run.dataset.brun); return; }
    const edit = e.target.closest('[data-bedit]');
    if (edit) {
      const j = (backupData.jobs || []).find(x => x.id === edit.dataset.bedit);
      if (j) backupJobModal(j);
      return;
    }
    const tog = e.target.closest('[data-btoggle]');
    if (tog) { toggleBackupJob(tog.dataset.btoggle); return; }
    const folder = e.target.closest('[data-bfolder]');
    if (folder) { openBackupFolder(folder.dataset.bfolder); return; }
    const del = e.target.closest('[data-bdel]');
    if (del) deleteBackupJobModal(del.dataset.bdel);
  });

  $('#phpGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-php]');
    if (b) switchPhp(b.dataset.php);
  });
  $('#extGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-ext]');
    if (b) toggleExt(b.dataset.ext, b.dataset.enabled !== '1');
  });

  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  $('#shareIp').addEventListener('change', e => { shareIp = e.target.value; renderShare(); });
  $('#copyLan').addEventListener('click', () => copyText($('#shareLanUrl').value, 'URL del panel'));
  $('#copyKey').addEventListener('click', () => copyText($('#shareKey').value, 'clave'));
  $('#firewallBtn').addEventListener('click', openFirewall);
  $('#shareProjects').addEventListener('click', e => {
    const c = e.target.closest('[data-copy-url]');
    if (c) { copyText(c.dataset.copyUrl, 'URL del proyecto'); return; }
    const o = e.target.closest('[data-open-url]');
    if (o) window.open(o.dataset.openUrl, '_blank');
  });

  $('#servicesGrid').addEventListener('click', e => {
    const svc = e.target.closest('[data-svc]');
    if (svc) { serviceAction(svc.dataset.svc, svc.dataset.action); return; }
    const node = e.target.closest('[data-node]');
    if (node) nodeAction(node.dataset.node, node.dataset.nodeAction);
  });

  $('#logService').addEventListener('change', e => { logService = e.target.value; loadLogs(); });
  $('#logSearch').addEventListener('input', renderLogText);
  $('#logDownload').addEventListener('click', downloadLog);
  $('#logRefresh').addEventListener('click', loadLogs);

  $('#openWww').addEventListener('click', () => openPort(80));
  $('#openPhpInfo').addEventListener('click', () => setView('php'));
  $('#openDumps').addEventListener('click', () => openDir('dumps'));
  $('#openPorts').addEventListener('click', () => openPortsModal());
  bindWindows();
}

function clock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

bind();
clock();
setInterval(clock, 1000);
refreshOverview();
loadSystem();
setInterval(() => { if (currentView === 'dashboard') refreshOverview(true); }, 6000);
setInterval(() => { if (currentView === 'dashboard') loadSystem(); }, 2500);
setInterval(() => {
  if (currentView === 'logs' && $('#logAuto') && $('#logAuto').checked) loadLogs();
}, 6000);
