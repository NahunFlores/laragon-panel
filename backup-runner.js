'use strict';

/*
 * Ejecutor de respaldos sin interfaz. Lo usan:
 *  - El panel, al pulsar "Ejecutar ahora" (proceso separado).
 *  - El Programador de tareas de Windows (aunque el panel esté cerrado).
 *
 * Uso: node backup-runner.js --job <id> [--scheduled]
 */

const { runJob } = require('./backup');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const jobId = arg('--job');
const scheduled = process.argv.includes('--scheduled');

if (!jobId) {
  console.error('Falta el parámetro --job');
  process.exit(2);
}

process.on('unhandledRejection', err => {
  console.error('Error no controlado:', err && err.message ? err.message : err);
  process.exit(1);
});

runJob(jobId, { scheduled })
  .then(result => {
    if (!result.ok) {
      console.error(`Respaldo fallido: ${result.error || 'error desconocido'}`);
      process.exit(1);
    }
    console.log(result.skipped ? 'Respaldo omitido (disco no conectado).' : 'Respaldo completado.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Respaldo fallido:', err && err.message ? err.message : err);
    process.exit(1);
  });
