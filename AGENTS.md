# Laragon Panel — instrucciones para el agente

Panel de control para Laragon (Node, sin dependencias) + app Electron.
Estas reglas aplican cuando alguien pide **instalar, actualizar o revisar este panel en un Laragon**.

## Instalación en cualquier Laragon

Nunca copies `panel.config.json` a mano ni edites `httpd-vhosts.conf` al azar.
Usa siempre el instalador:

```bash
node instalar.js --dry-run --laragon "<ruta de Laragon>"
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

### Política de versiones y PHP

La fuente versionada de la política es `stack-policy.json`; no dupliques mínimos en README, UI o instalador.
El instalador considera los mínimos de PHP contra los avisos registrados y no activa ramas fuera de soporte.
`--no-php` debe omitir totalmente cambios de PHP/Apache. Los builds aceptables para Apache son x64,
Thread Safe (ZTS) y contienen `php8apache2_4.dll`.

Los binarios descargados deben verificarse contra `sha256sum.txt` oficial antes de extraerlos.
Extrae primero a una carpeta temporal, ejecuta `php.exe -v`, y solo después mueve a `bin/php`.
Antes de activar, valida `httpd -t`; si la activación/reinicio falla, restaura ambos archivos de selección PHP.

Comportamiento esperado:

1. `laragon.ini` es la fuente de selección de Apache, PHP, MySQL y sus puertos si el modo local es `auto`.
2. `stack-policy.json` contiene los mínimos/requisitos; una rama EOL no se etiqueta como segura solo por pasar un CVE específico.
3. PHP debe estar simultáneamente configurado en `mod_php.conf` y `[php] Version`; el panel debe detectar e informar el drift.
4. Si no hay red/checksum/build compatible, deja el entorno intacto y un aviso claro.

Si el agente detecta PHP vulnerable tras instalar, debe avisar y volver a ejecutar
`node instalar.js --laragon "<ruta>"` (sin `--no-php`).

## Verificación después de instalar

```bash
node --check server.js
node --check instalar.js
node --check laragon-stack.js
node --test tests/laragon-stack.test.js
node instalar.js --dry-run --laragon "<ruta>"
```

No arranques `server.js` solo para probar en una Laragon existente: al iniciar puede arrancar
las apps Node de `www`. Usa `--dry-run`, pruebas unitarias y validaciones de configuración.

Con el panel arriba (`http://127.0.0.1:9090`), comprobar:

- `GET /api/overview` → servicios, PHP activo, proyectos y bases detectados.
- `GET /api/projects` → puertos reales tomados de `httpd-vhosts.conf` / `puertos.csv`.
- `GET /api/preview?port=<puerto>` → 200 con PNG (sitio arriba) o 204 (sitio apagado).
- `GET /api/project-logs?port=<puerto>` → archivos de log detectados del proyecto.
- `GET /api/logs?service=apache` y `?service=mysql` → ruta real del log y contenido.

## Reglas para no romper nada

- No borrar ni reescribir `panel.config.json`, `lan-key.txt`, `backups.json`, `backups/`, `previews/` de una instalación existente.
- No editar `conf/extra/httpd-vhosts.conf` a mano: los sitios se crean desde el panel (`POST /api/site`), que agrega el vhost y la línea de `puertos.csv`.
- No terminar `httpd.exe` ni `mysqld.exe` por nombre global. Cierre ordenado, PID/proceso propio y rollback; nunca iniciar una segunda instancia de MySQL mientras otra inicializa.
- No reconstruir directamente encima de una app portable en ejecución. El build debe preservar `data` y `panel.config.json`, y abortar si el exe está activo.
- Los cambios de vhost/puertos se validan con `httpd -t` antes de reiniciar; ante fallo, restaurar los archivos anteriores.
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
