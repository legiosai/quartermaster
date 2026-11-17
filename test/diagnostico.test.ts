// `--diagnostico` tiene que contestar SIEMPRE, sobre todo cuando lo demás está
// roto: es lo único que se le pide a alguien que reporta un bug.
//
// Las dos propiedades que importan:
//
//   1. No se cae porque falte un comando. Averigua lo que puede con `pgrep`,
//      `ps`, `gnome-shell`, `gdbus` y `journalctl` — ninguno existe en todas
//      las máquinas, y en un contenedor de CI no hay casi ninguno. Un
//      diagnóstico que muere porque no encontró `gdbus` no diagnostica nada.
//   2. No filtra nada privado. Está hecho para pegarlo en un issue público, así
//      que la ruta de casa sale, y con ella los nombres de usuario.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Estos tests leen las frases en castellano. El idioma sale del locale, y el
// de CI es C.UTF-8 (inglés): se fija acá. Lo que es del inglés vive en idioma.test.ts.
process.env['QM_IDIOMA'] = 'es';

const RAIZ = new URL('..', import.meta.url).pathname;

function correrDiagnostico(env: NodeJS.ProcessEnv): { salida: string; codigo: number } {
  try {
    // --sin-red: `npm test` no sale a la red. La prueba de red tiene sus
    // tests con sondas inyectadas (veredicto.test.ts) y contra puertos locales
    // (red.test.ts).
    const salida = execFileSync(join(RAIZ, 'bin', 'qm'), ['--diagnostico', '--sin-red'], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    return { salida, codigo: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { salida: (err.stdout ?? '') + (err.stderr ?? ''), codigo: err.status ?? -1 };
  }
}

test('ninguna sonda del entorno tira cuando no existe el comando que consulta', async () => {
  // Se prueba el adaptador y no el CLI a través de `bin/qm`: ese lanzador
  // necesita `dirname` para encontrarse a sí mismo, así que con PATH vacío
  // muere ANTES de llegar al diagnóstico y el test mediría otra cosa.
  //
  // Acá PATH se vacía de verdad: ni pgrep, ni ps, ni gdbus, ni journalctl, ni
  // gnome-shell. Es el peor caso, y es parecido al de un contenedor de CI.
  const entorno = await import('../src/adapters/entorno.ts');
  const antes = process.env['PATH'];
  process.env['PATH'] = '';
  try {
    const e = entorno.escritorio();
    assert.ok(e.so.length > 0, 'el sistema operativo sale de node, siempre tiene que estar');
    // Lo que no se pudo averiguar se DICE. Ni se omite ni se inventa.
    assert.match(entorno.texto(e.shell), /^—/);
    assert.match(entorno.texto(e.arrancoLaSesion), /^—/);
    assert.strictEqual(e.arrancoMs, null);

    const x = entorno.extension();
    assert.ok(typeof x.instalada === 'boolean');
    assert.ok(typeof entorno.texto(x.estado) === 'string');

    assert.match(entorno.texto(entorno.indicador()), /^—/);
    assert.match(entorno.texto(entorno.journal()), /^—/);
    assert.ok(Array.isArray(entorno.cache()));
  } finally {
    process.env['PATH'] = antes;
  }
});

test('el diagnóstico completo contesta y trae sus bloques', () => {
  const { salida, codigo } = correrDiagnostico({ ...process.env });
  assert.strictEqual(codigo, 0, `salió ${codigo}: ${salida.slice(0, 400)}`);
  assert.match(salida, /quartermaster .* · diagnóstico/);
  for (const bloque of ['la máquina', 'la extensión de GNOME', 'el indicador', 'la red', 'el cache']) {
    assert.ok(salida.includes(bloque), `falta el bloque «${bloque}»`);
  }
});

test('no imprime la ruta de casa: está hecho para pegarlo en un issue', () => {
  const casa = mkdtempSync(join(tmpdir(), 'qm-diag-'));
  const { salida, codigo } = correrDiagnostico({ ...process.env, HOME: casa });
  assert.strictEqual(codigo, 0, `salió ${codigo}: ${salida.slice(0, 400)}`);
  assert.ok(
    !salida.includes(casa),
    `la ruta de casa (${casa}) aparece tal cual en el diagnóstico; tendría que ser «~»`,
  );
});

test('termina siempre en un veredicto', () => {
  const { salida, codigo } = correrDiagnostico({ ...process.env });
  assert.strictEqual(codigo, 0, `salió ${codigo}: ${salida.slice(0, 400)}`);
  assert.match(salida, /── veredicto[^\n]*\n {2}[⚠ℹ✓]/u, 'el informe tiene que concluir, no sólo listar');
});

test('lo que viene de afuera sale sin mails', async () => {
  const entorno = await import('../src/adapters/entorno.ts');
  // Los logs de las superficies y el journal no los escribe el diagnóstico: el
  // «sin mails» del encabezado se cumple en la salida, no confiando en la fuente.
  assert.equal(
    entorno.redactar('aviso: alguien.de-prueba+x@empresa.com.ar llegó al 90 %'),
    'aviso: <mail> llegó al 90 %',
  );
});

test('lee lo que launchd sabe de la barra: PID y última salida', async () => {
  const entorno = await import('../src/adapters/entorno.ts');
  const salida = [
    '{',
    '\t"LimitLoadToSessionType" = "Aqua";',
    '\t"Label" = "com.legios.quartermaster.barra";',
    '\t"OnDemand" = true;',
    '\t"LastExitStatus" = 19968;',
    '\t"PID" = 812;',
    '};',
  ].join('\n');
  assert.deepEqual(entorno.leerLaunchctl(salida), { pid: 812, ultimaSalida: 19968 });
  assert.deepEqual(entorno.leerLaunchctl('{\n\t"LastExitStatus" = 0;\n};'), { pid: null, ultimaSalida: 0 });
});
