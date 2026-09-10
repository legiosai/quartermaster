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

function correr(args: readonly string[]): { salida: string; codigo: number } {
  const casa = mkdtempSync(join(tmpdir(), 'qm-vacio-'));
  try {
    const salida = execFileSync(join(RAIZ, 'bin', 'qm'), [...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: casa, XDG_CACHE_HOME: join(casa, 'cache') },
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
