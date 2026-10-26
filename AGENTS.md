# Laragon Panel — instrucciones para el agente

Panel de control para Laragon (Node, sin dependencias) + app Electron.
Estas reglas aplican cuando alguien pide **instalar, actualizar o revisar este panel en un Laragon**.

## Instalación en cualquier Laragon

Nunca copies `panel.config.json` a mano ni edites `httpd-vhosts.conf` al azar.
Usa siempre el instalador:

```bash
node instalar.js --laragon "<ruta de Laragon>"
```

Opciones útiles:

| Flag | Efecto |
|---|---|
| `--laragon <ruta>` | Ruta de Laragon. Si falta, se autodetecta (rutas típicas, `LARAGON_ROOT`, menú de inicio). |
| `--www <ruta>` | Carpeta de proyectos cuando no es `<laragon>/www` (lee `DocumentRoot` de `usr/laragon.ini`). |
| `--port <n>` / `--lan-port <n>` | Puertos del panel. Por defecto 9090 / 9091. |
| `--php <rama>` | Fuerza rama de PHP, por ejemplo `8.3`. |
| `--dry-run` | Informa sin escribir nada. Úsalo antes de tocar una máquina nueva. |
| `--check-php` | Lista los builds de PHP en windows.php.net y marca cuáles están parcheados. |
| `--force` | Reescribe `panel.config.json` aunque exista. |
| `--no-electron` / `--no-php` | Omite la app de escritorio / la gestión de PHP. |

### Regla obligatoria: PHP sin vulnerabilidades

El instalador **siempre** busca una versión de PHP sin fallos conocidos
(advisory `CVE-2026-109618` / `CVE-2026-109619`, "php2shell"), mínimo por rama:

`8.1.34`, `8.2.35`, `8.3.36`, `8.4.27`, `8.5.12`

Comportamiento esperado:

1. Lista los PHP instalados y marca cuáles son vulnerables.
2. Si hay uno parcheado, x64 **ZTS** y con `php8apache2_4.dll`, lo activa
   (`etc/apache2/mod_php.conf` + `[php] Version` en `usr/laragon.ini`) y reinicia Apache si está corriendo.
3. Si ninguno sirve, descarga el último build parcheado x64 ZTS desde
   `windows.php.net`, lo extrae en `bin/php`, copia `php.ini` y las extensiones
   (`sqlsrv`, `pdo_sqlsrv`, `redis`) de la versión anterior y lo deja activo.
4. Si no hay red o el build no trae `php8ts.dll`, deja un aviso claro y no rompe nada.

Si el agente detecta PHP vulnerable tras instalar, debe avisar y volver a ejecutar
`node instalar.js --laragon "<ruta>"` (sin `--no-php`).

## Verificación después de instalar

```bash
node --check server.js
node --check instalar.js
node instalar.js --check-php            # confirma que hay build parcheado
node server.js                          # o la app Electron
```

Con el panel arriba (`http://127.0.0.1:9090`), comprobar:

- `GET /api/overview` → servicios, PHP activo, proyectos y bases detectados.
- `GET /api/projects` → puertos reales tomados de `httpd-vhosts.conf` / `puertos.csv`.
- `GET /api/preview?port=<puerto>` → 200 con PNG (sitio arriba) o 204 (sitio apagado).
- `GET /api/project-logs?port=<puerto>` → archivos de log detectados del proyecto.
- `GET /api/logs?service=apache` y `?service=mysql` → ruta real del log y contenido.

## Reglas para no romper nada

- No borrar ni reescribir `panel.config.json`, `lan-key.txt`, `backups.json`, `backups/`, `previews/` de una instalación existente.
- No editar `conf/extra/httpd-vhosts.conf` a mano: los sitios se crean desde el panel (`POST /api/site`), que agrega el vhost y la línea de `puertos.csv`.
- Los respaldos solo se administran desde el equipo local (`/api/backup*` responde 403 por LAN).
- No exponer el panel LAN a Internet sin HTTPS. La clave vive en `lan-key.txt`.
- Trabajar la configuración solo con `node instalar.js`; si un valor debe cambiar, usar `--force` conscientemente.

## Arranque

```bash
# Panel web
iniciar-panel.vbs            # o: node server.js

# App de escritorio (bandeja, notificaciones, inicio con Windows)
electron-app\node_modules\electron\dist\electron.exe electron-app
```

Requisitos: Windows 10/11 x64, Laragon con Apache 2.4 + MySQL 8, PHP 8 x64 ZTS.
Para las miniaturas de proyectos se usa Edge o Chrome en modo headless (autodetectado).
