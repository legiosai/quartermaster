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

const RAIZ = new URL('..', import.meta.url).pathname;

function correrDiagnostico(env: NodeJS.ProcessEnv): { salida: string; codigo: number } {
  try {
    const salida = execFileSync(join(RAIZ, 'bin', 'qm'), ['--diagnostico'], {
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
  for (const bloque of ['la máquina', 'la extensión de GNOME', 'el indicador', 'el cache']) {
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
