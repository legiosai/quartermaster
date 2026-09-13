// `--json` tiene que devolver JSON SIEMPRE.
//
// El caso que se escapaba es el primero que ve cualquiera: una máquina donde
// todavía no hay ninguna cuenta. Ahí qm imprimía una frase en castellano, con
// --json y todo, así que la statusline o el script que lo parseaba se rompía
// justo en la primera corrida. Se prueba lanzando el binario de verdad con un
// HOME vacío, porque el bug no estaba en ninguna función: estaba en el orden de
// las ramas del comando.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const RAIZ = new URL('..', import.meta.url).pathname;

/** Una máquina sin nada, de verdad.
 *
 * Con sólo HOME no alcanza: qm también lee XDG_DATA_HOME y XDG_CONFIG_HOME —de
 * ahí salen las cuentas que guarda opencode— y en una máquina real esas dos
 * apuntan a la casa del usuario aunque HOME diga otra cosa. El test pasaba por
 * casualidad hasta que opencode empezó a aparecer en más caminos, y entonces
 * encontró las cuentas de verdad de quien lo corría.
 */
function entornoVacio(casa: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  delete env['QM_CODEX'];
  return {
    ...env,
    HOME: casa,
    XDG_CACHE_HOME: join(casa, 'cache'),
    XDG_CONFIG_HOME: join(casa, 'config'),
    XDG_DATA_HOME: join(casa, 'data'),
  };
}

function correr(args: readonly string[]): { salida: string; codigo: number } {
  const casa = mkdtempSync(join(tmpdir(), 'qm-vacio-'));
  try {
    const salida = execFileSync(join(RAIZ, 'bin', 'qm'), [...args], {
      encoding: 'utf8',
      env: entornoVacio(casa),
      timeout: 30_000,
    });
    return { salida, codigo: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { salida: err.stdout ?? '', codigo: err.status ?? -1 };
  }
}

test('sin ninguna cuenta, --json devuelve JSON y no una frase', () => {
  const { salida, codigo } = correr(['--json', '--breve']);
  assert.strictEqual(codigo, 0, `salió ${codigo}: ${salida.slice(0, 200)}`);
  const d = JSON.parse(salida) as { perfiles: unknown[] };
  assert.deepStrictEqual(d.perfiles, [], 'no debería encontrar perfiles en un HOME vacío');
});

test('sin ninguna cuenta y sin --json, lo dice con palabras', () => {
  const { salida, codigo } = correr(['--breve']);
  assert.strictEqual(codigo, 0);
  assert.match(salida, /No se encontró ninguna cuenta/);
});

// ── el contrato, que ahora tiene número ────────────────────────────────
// Este JSON dejó de ser nuestro: lo leen las cuatro superficies del repo, la
// statusline, el módulo de waybar y cualquiera que escriba la suya. Un consumidor
// no tiene forma de enterarse de que cambió algo si no hay un número que mirar.

test('--json declara la versión del esquema y la del paquete', () => {
  const { salida, codigo } = correr(['--json', '--breve']);
  assert.strictEqual(codigo, 0);
  const d = JSON.parse(salida) as { esquema?: unknown; version?: unknown };
  assert.strictEqual(d.esquema, 1, 'el esquema del JSON, que sube cuando un campo cambia de significado');
  assert.strictEqual(typeof d.version, 'string');
  assert.match(d.version as string, /^\d+\.\d+\.\d+/, 'y la del paquete, para un bug report');
});

test('--version contesta y sale 0', () => {
  const { salida, codigo } = correr(['--version']);
  assert.strictEqual(codigo, 0, 'la versión es una respuesta, no un error');
  assert.match(salida.trim(), /^quartermaster \d+\.\d+\.\d+/);
});

test('una opción que no existe sigue saliendo 2, y explica', () => {
  const { salida, codigo } = correr(['--esta-no-existe']);
  assert.strictEqual(codigo, 2);
  assert.match(salida, /opción desconocida/);
});
