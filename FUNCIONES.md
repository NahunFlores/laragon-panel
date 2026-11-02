LARAGON PANEL - FUNCIONES
=========================
Panel propio en C:\laragon-panel (Node.js, sin dependencias).
Abrir: http://127.0.0.1:9090  (iniciar-panel.vbs)

QUE HACE LARAGON.EXE (analizado con REA)
----------------------------------------
laragon.exe es una app Delphi (PE x64, ~19k procedimientos) que:
- Lee usr\laragon.ini.
- Arranca/para httpd.exe y mysqld (taskkill / mysqld --log-error).
- Genera vhosts en etc\apache2\sites-enabled usando usr\tpl\VirtualHost.tpl.
- Auto-vhosts con Node.js bin\laragon\utils\hosts.js y hosts.tmp.
- Maneja SSL (TimerGenSSLTimer), ajustes rapidos de PHP, carpetas de datos,
  menus de Apache/MySQL, dumps con mysqldump, DBeaver, etc.
Conclusion: casi todo se puede replicar con un panel propio; no hace falta
esperar a la UI de Laragon.

QUE TIENE HERD (analizado con REA)
----------------------------------
Herd 2.0.3 es Electron + Vue 3 (app.asar). Usa Express, WebSocket, SQLite,
SMTP/mailparser, chokidar, portscanner, tree-kill, electron-store, etc.
Funciones destacadas:
- Applications: sitios con estado, PHP/Node por sitio, HTTPS, servicios,
  base de datos, queue/cache/broadcasting, workspaces.
- New Application: crear Laravel/blank, enlazar carpeta, prompt IA.
- Dumps, Mail, Log Viewer, Services (MySQL/PostgreSQL/MongoDB/Redis/
  Meilisearch), Restart Services, PHP versions, extensiones, Xdebug.
- CLI herd: link, isolate, use, secure, open, workspace, dumps, mail, tinker.
- System tray, autostart, auto-update, deploy a Laravel Cloud/Forge.

IMPLEMENTADO EN ESTE PANEL
--------------------------
- Estado Apache/MySQL, iniciar/detener/reiniciar.
- 58 proyectos con puerto, estado HTTP, abrir, carpeta, VS Code, terminal,
  logs por proyecto.
- Nuevo sitio: PHP puro, HTML estatico, Laravel con Composer (SQLite +
  migrate), Node.js con proxy Apache y arranque automatico, y enlazar
  carpeta existente (detecta Laravel/PHP/HTML/Node).
- PHP: 4 versiones (8.2.35, 8.3.36, 8.4.27, 8.5.12), cambio de version activa,
  extensiones del php.ini activo (ON/OFF, incluye sqlsrv/pdo_sqlsrv/opcache).
- Bases: listar, tamano, dump, crear, borrar, importar dump, backup total.
- Logs Apache/MySQL/Node con filtro, auto-refresh y descarga.
- App de escritorio Electron: bandeja, notificaciones, inicio con Windows,
  ventana nativa, cierre a bandeja, servicios, logs y respaldos.
- Versión portable: LaragonPanel.exe con Node incluido, datos junto al ejecutable,
  arranque al iniciar sesión y actualización automática del acceso directo si se mueve.
- Actualización desde GitHub Releases con actualizar.bat, conservando configuración y datos.
- Dashboard: CPU, RAM, disco, GPU, uptime y consumo por servicio.
- Respaldos programados a otro disco: ZIP por proyecto con su código y bases,
  retención por copias y por días, máximo mensual, ventana de días/horas,
  historial, ejecución manual y reglas en el Programador de tareas.
- Servicios de Windows con NSSM: Apache, MySQL, Redis, colas Laravel y
  servicios personalizados; estado real, auto-inicio, logs, adoptar y quitar.
- Colas Laravel detectadas por artisan/QUEUE_CONNECTION, con ejecución
  `queue:work`, logs propios y control start/stop/restart.
- Compartir por IP: panel en http://IP:9091 con clave, proyectos en
  http://IP:PUERTO, selector de IP, copiar URLs y abrir firewall.
- SQL Server: ODBC 17 + drivers para las 4 versiones, probado con REA2008.

PENDIENTE / NO IMPLEMENTADO (Herd si lo tiene)
----------------------------------------------
- PHP por sitio (aqui es global con mod_php; requeriria FPM por sitio).
- HTTPS/SSL por sitio.
- Mail catcher (SMTP) y visor de dumps de Laravel.
- Servicios administrados (PostgreSQL, MongoDB, Redis, Meilisearch) con UI.
- Workspaces con clon de base por rama.
- Deploy a Forge/Laravel Cloud y auto-update.
- Xdebug toggle/profiler.
