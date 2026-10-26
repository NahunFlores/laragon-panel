# Laragon Panel

Panel de control privado para **Laragon** en Windows. Sustituye la interfaz de Laragon por un panel web y una app de escritorio con servicios, proyectos, PHP, bases de datos, métricas y respaldos comprimidos por proyecto.

> Este repositorio contiene **solo el panel**. No incluye Laragon, Apache, MySQL, PHP, proyectos, bases de datos ni dumps.

## Funciones

- **Dashboard** con CPU, RAM, disco, GPU, uptime y consumo por servicio.
- **Servicios**: iniciar, detener y reiniciar Apache y MySQL por separado.
- **Proyectos**: puerto, estado HTTP, abrir sitio, carpeta, VS Code, terminal y logs.
- **Vista previa**: cada proyecto activo (punto verde) muestra una miniatura real de su portada, capturada con Edge/Chrome headless y cacheada 15 minutos. Los sitios apagados no se capturan.
- **Logs por proyecto**: detecta `storage/logs/*.log`, los `ErrorLog`/`CustomLog` del vhost y el log de Node. Se pueden filtrar por tiempo (15 min, 1 h, 24 h, 7 días, todo) y vaciar (antes guarda una copia `.old`).
- **Nuevo sitio**: PHP, HTML, Laravel, Node.js o enlazar una carpeta existente.
- **PHP**: detecta versiones instaladas, cambia la activa y activa/desactiva extensiones.
- **Bases de datos**: listar, crear, borrar, dump, importar y backup total.
- **Respaldos**: tareas manuales o programadas, a otro disco, con **un ZIP por proyecto** (código + su base) y retención.
- **Programador de Windows**: las tareas corren aunque el panel esté cerrado.
- **App Electron**: bandeja, notificaciones, inicio con Windows e instancia única.
- **LAN**: panel por IP con clave y proyectos por `IP:PUERTO`.
- **SQL Server**: compatible con `sqlsrv`/`pdo_sqlsrv` si las DLL están instaladas en PHP.

## Requisitos

- Windows 10/11 x64.
- Laragon con Apache 2.4, MySQL 8.x y PHP 8.x **x64 ZTS**.
- Node.js 18 o superior (solo para el panel web y para desarrollar; la app Electron ya incluye Node).
- Visual C++ Redistributable 2015–2022 x64 (lo necesitan Apache/PHP/MySQL).
- Opcional: Git, ODBC Driver 17 para SQL Server, VS Code y Windows Terminal.

## Instalación rápida en otro Laragon

La forma recomendada es el instalador, que detecta Laragon, la carpeta de proyectos y PHP:

```bat
node instalar.js --laragon "D:\ruta\de\laragon"
```

Sin `--laragon` se autodetecta (rutas típicas, `LARAGON_ROOT` y el menú de inicio).
El instalador escribe `panel.config.json`, genera `lan-key.txt` y deja activa una
versión de PHP **sin vulnerabilidades conocidas** (ver más abajo). Puedes ver qué haría
antes de tocar nada con `node instalar.js --dry-run`.

Después, instala las dependencias de la app de escritorio si las quieres usar:

```bat
cd electron-app
npm install
cd ..
```

### Instalación asistida desde OpenCode

Este repositorio incluye reglas para el agente (`AGENTS.md`) y el comando `/instalar-panel`.

```bat
cd C:\tools\laragon-panel
opencode
/instalar-panel D:\ruta\de\laragon
```

El agente ejecuta el instalador, verifica que PHP quede parcheado y comprueba la API
(`/api/overview`, `/api/projects`, `/api/logs`, `/api/preview`) antes de dar por terminada la instalación.

## Configuración

`panel.config.json` se lee al arrancar. Las variables de entorno tienen prioridad.

| Clave | Por defecto | Descripción |
|---|---|---|
| `laragonRoot` | `C:/laragon` | Carpeta raíz de Laragon. |
| `wwwRoot` | DocumentRoot de `usr\laragon.ini` o `<laragonRoot>/www` | Carpeta de proyectos. Úsala si tu `www` vive en otro disco, por ejemplo `D:/Laragon/www`. |
| `mysqlPort` | `3308` | Puerto TCP de MySQL. |
| `panelPort` | `9090` | Panel local (solo `127.0.0.1`). |
| `lanPort` | `9091` | Panel para la red local. |
| `codePath` | vacío | Ruta a `code.cmd` de VS Code. Si está vacío se autodetecta. |
| `wtPath` | vacío | Ruta a `wt.exe` de Windows Terminal. Si está vacío se autodetecta. |
| `legacyDumps` | vacío | Carpeta antigua de dumps, opcional. |

Variables equivalentes: `LARAGON_ROOT`, `LARAGON_WWW`, `MYSQL_PORT`, `PANEL_PORT`, `PANEL_LAN_PORT`, `VSCODE_PATH`, `WT_PATH`, `LEGACY_BACKUP`.

## Estructura de Laragon que espera el panel

```
C:\laragon\
  bin\
    apache\httpd-2.4.x\        (última versión detectada)
    mysql\mysql-8.x\           (última versión detectada)
    php\php-8.x\               (php8apache2_4.dll)
  www\                         (proyectos)
  data\mysql-8\                (datos de MySQL)
  usr\laragon.ini
  puertos.csv                  (opcional, ver abajo)
  bin\apache\...\conf\extra\httpd-vhosts.conf
```

El panel usa la versión de Apache y MySQL indicada en `usr\laragon.ini` y, si no existe, la carpeta más reciente. Para PHP usa la versión activa de `usr\laragon.ini` o la que se seleccione en la vista PHP.

### Proyectos y puertos

El panel lee `C:\laragon\puertos.csv` con este formato:

```csv
"Puerto","Proyecto","DocumentRoot"
"8001","ABMODEL","C:/laragon/www/ABMODEL/public"
"8002","mi-web","C:/laragon/www/mi-web"
```

Si el archivo no existe, el panel toma los puertos reales de `conf/extra/httpd-vhosts.conf` (resolviendo `${LARAGON_WWW}` y los `Define` de `httpd.conf`) y asigna puertos en memoria solo a las carpetas de `www` que no tengan vhost. **Los vhosts no se crean solos**. Para publicar un proyecto:

- Usa **Proyectos → Nuevo sitio → Enlazar carpeta existente**, que crea el vhost y el puerto; o
- Copia tu `puertos.csv` y tu `httpd-vhosts.conf` ajustando `DocumentRoot` a la nueva ruta.

Asegúrate de que `httpd.conf` incluya:

```apache
Include conf/extra/httpd-vhosts.conf
```

### MySQL

El panel asume el usuario `root` **sin contraseña**, que es el valor por defecto de Laragon. Si tu instalación tiene contraseña, tendrás que adaptar `server.js` y `backup.js` (las llamadas a `mysql.exe` y `mysqldump.exe`).

El panel usa el puerto indicado en `mysqlPort` para todo: estado, arranque, dumps, importación y respaldos.

## Puertos y firewall

| Puerto | Uso |
|---|---|
| `80` | Apache |
| `3308` / `3306` | MySQL |
| `9090` | Panel local |
| `9091` | Panel LAN |
| `8001–8100` | Proyectos |

El botón **Compartir → Abrir puertos en el firewall** crea reglas para 80, 8001–8100 y 9091. Pide permisos de administrador (UAC).

La clave del panel se genera en `lan-key.txt` y **no se sube al repositorio**.

## Respaldos

En **Respaldos → Nueva tarea**:

- Destino: otro disco o USB.
- Origen: todas o algunas bases y proyectos.
- Frecuencia: manual, diaria, semanal o cada N horas.
- **Comprimir por proyecto** (por defecto): cada proyecto queda en un `.zip` con su código y una carpeta `_database` con sus bases.
- Retención: número de copias a conservar.

```
D:\RespaldosLaragon\LaragonBackup\<tarea>\<fecha>\
  projects\<proyecto>.zip
  projects\_bases_sin_proyecto.zip
  manifest.json
  respaldo.log
```

La base de cada proyecto se detecta leyendo `.env`, `wp-config.php`, `config/database.php`, etc. Si no se detecta, la base va a `_bases_sin_proyecto.zip`; no se pierde.

Las tareas se registran en el **Programador de tareas de Windows** con el nombre `LaragonPanel_Backup_<id>`. Si el disco no está conectado, se omiten y se reintentan. Si MySQL está apagado, el respaldo lo arranca.

> `tar.exe` (incluido en Windows 10/11) se usa para crear los ZIP. Si no está disponible, desmarca “Comprimir por proyecto”.

## PHP sin vulnerabilidades

El instalador busca siempre una versión de PHP parcheada contra `CVE-2026-109618` / `CVE-2026-109619`
("php2shell"). Mínimos por rama:

| Rama | Versión mínima |
|---|---|
| 8.1 | 8.1.34 |
| 8.2 | 8.2.35 |
| 8.3 | 8.3.36 |
| 8.4 | 8.4.27 |
| 8.5 | 8.5.12 |

- Si ya hay una instalada, la activa (debe ser x64 **ZTS** con `php8apache2_4.dll`).
- Si no hay ninguna, descarga el último build x64 ZTS de `windows.php.net`, lo instala en `bin\php`,
  copia `php.ini` y las extensiones de la versión anterior (`sqlsrv`, `pdo_sqlsrv`, `redis`) y lo deja activo.
- `node instalar.js --check-php` muestra los builds disponibles y cuáles están parcheados.

El panel muestra la versión activa en **PHP** y el instalador marca en el resumen cuáles quedaron vulnerables.

## App de escritorio

- Bandeja del sistema, notificaciones y cierre a bandeja.
- Instancia única: una segunda apertura enfoca la ventana existente.
- Arranca Apache/MySQL si están detenidos.
- **Iniciar con Windows** crea el acceso directo en Startup.
- **Salir** deja los servicios; **Salir y detener servicios** apaga Apache, MySQL y las apps Node.

La app usa el Node incluido en Electron para lanzar `server.js`; no necesita un Node global instalado.

## Seguridad

- El panel local escucha solo en `127.0.0.1`.
- El panel LAN escucha en `0.0.0.0:9091` y exige clave.
- La clave del LAN se valida en el servidor y se canjea por una cookie de sesión aleatoria (`laragon_sess`, `HttpOnly`, 12 h). La clave nunca se guarda en la cookie.
- Tras 5 intentos fallidos, la IP queda bloqueada 5 minutos.
- Los respaldos solo se administran desde el equipo local.
- No se versionan: `panel.config.json`, `lan-key.txt`, `backups.json`, `backups/`, logs, dumps ni bases.
- No expongas el panel a Internet sin HTTPS y una autenticación adicional.

## Desarrollo

```bat
node server.js
```

```bat
cd electron-app
npm start
```

Las miniaturas de la vista previa se capturan con Edge o Chrome en modo headless (se autodetectan; se puede fijar `PREVIEW_BROWSER` con la ruta al `.exe`). Se guardan en `previews/` (no versionado) y solo se generan para proyectos que responden.

No hay paso de compilación: el panel es HTML/CSS/JS y el servidor usa solo módulos de Node.

## Solución de problemas

**El panel no abre / puerto ocupado**  
Cambia `panelPort` en `panel.config.json` o cierra el proceso que usa 9090:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9090
```

**MySQL no vuelve después de reiniciar**  
El panel espera a que terminen el proceso padre y el hijo de `mysqld` antes de arrancar de nuevo. Si persiste, revisa `data\mysql-8\*.err`.

**Las tareas de Windows no aparecen**  

```powershell
Get-ScheduledTask -TaskName 'LaragonPanel_Backup_*'
```

**Los proyectos no cargan por IP:PUERTO**  
Revisa el vhost, que Apache esté escuchando y las reglas de firewall.

**PHP no carga en Apache**  
La versión debe ser x64 ZTS e incluir `php8apache2_4.dll`. Revisa `etc\apache2\mod_php.conf`.

**No hay ZIP en los respaldos**  
Comprueba que `C:\Windows\System32\tar.exe` exista; si no, usa el modo sin comprimir.

## Contenido del repositorio

```
server.js                 API y servidor web
config.js                 configuración (panel.config.json / variables de entorno)
instalar.js               instalador: detecta Laragon, escribe config y deja PHP parcheado
AGENTS.md                 reglas para el agente (instalación/verificación)
backup.js                 motor de respaldos y tareas de Windows
backup-runner.js          ejecutor sin interfaz (Programador de tareas)
public/                   interfaz web
electron-app/             app de escritorio (main, preload, iconos)
iniciar-panel.vbs/.bat    lanzadores del panel web
panel.config.example.json plantilla de configuración
LEEME.txt                 notas de uso
FUNCIONES.md              funciones implementadas y hallazgos de REA
```

## No incluido

- Binarios de Laragon, Apache, MySQL o PHP.
- Proyectos de `www`.
- Bases de datos, dumps o `data\mysql-8`.
- `node_modules`, `lan-key.txt`, `backups.json` ni configuraciones locales.
