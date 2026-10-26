---
description: Instala o actualiza Laragon Panel sobre un Laragon concreto
---

Instala el Laragon Panel en la instalación de Laragon indicada: $ARGUMENTS

Pasos que debes seguir, sin saltarte ninguno:

1. Si no se indicó ruta, autodetecta Laragon con `node instalar.js --dry-run` y muestra
   al usuario qué encontraste (raíz, `www`, Apache, MySQL, PHP activo).
2. Ejecuta `node instalar.js --laragon "<ruta>"` (agrega `--www "<ruta>"` y `--port` si hace falta).
   Nunca copies `panel.config.json` ni edites `httpd-vhosts.conf` a mano.
3. Revisa la salida completa. Es obligatorio que el resumen incluya una versión de PHP
   parcheada contra `CVE-2026-109618/109619` (mínimos: 8.1.34, 8.2.35, 8.3.36, 8.4.27, 8.5.12)
   y que sea x64 ZTS con `php8apache2_4.dll`. Si el instalador no pudo conseguirla
   (sin red, ZIP sin `php8ts.dll`), avísalo claramente y no digas que quedó listo.
4. Verifica `node --check server.js` y `node --check instalar.js`.
5. Arranca el panel (`node server.js` o la app Electron) y comprueba:
   `/api/overview`, `/api/projects`, `/api/logs?service=apache`, `/api/logs?service=mysql`
   y `/api/preview?port=<un puerto activo>`.
6. Resume en pocas líneas: ruta de Laragon, carpeta de proyectos, PHP activo y si está
   parcheado, puertos del panel y cómo se arranca. Avisa de cualquier cosa que quedó pendiente.
