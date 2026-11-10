// El completado de bash y zsh (paquetes/completions/) contra la ayuda de qm.
//
// Los dos archivos tienen las banderas escritas a mano, y eso es una copia de
// las que documenta `qm --help`. Una copia se queda vieja en silencio: se agrega
// una bandera, el TAB no la ofrece y nadie se entera. Este test es el que se
// entera — y es la razón por la que la copia se puede tener.
//
// Las cuentas no se copian: los dos archivos las sacan de `qm --json --breve`.
// Acá se prueba con un `qm` de mentira en el PATH que devuelve un JSON fijo.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';

const RAIZ = new URL('..', import.meta.url).pathname;
const BASH = join(RAIZ, 'paquetes', 'completions', 'qm.bash');
const ZSH = join(RAIZ, 'paquetes', 'completions', '_qm');

/** Las banderas que documenta la ayuda, sin el `=`: `--dias=N` es `--dias`. */
function deLaAyuda(idioma: 'es' | 'en'): Set<string> {
  const ayuda = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), '--help'],
    { encoding: 'utf8', env: { ...process.env, QM_IDIOMA: idioma }, timeout: 30_000 },
  );
  return new Set([...ayuda.matchAll(/^ {2}qm (--[a-z][a-z-]*)/gm)].map((m) => m[1]!));
}

function deBash(): Set<string> {
  const lista = /banderas='([^']*)'/.exec(readFileSync(BASH, 'utf8'));
  assert.ok(lista, 'qm.bash ya no tiene la lista `banderas=`');
  return new Set(lista[1]!.split(/\s+/).filter(Boolean).map((b) => b.replace(/=$/, '')));
}

function deZsh(): Set<string> {
  const texto = readFileSync(ZSH, 'utf8');
  const specs = texto.slice(texto.indexOf('_arguments'));
  return new Set([...specs.matchAll(/(--[a-z][a-z-]*)(?:=-?)?[\[}]/g)].map((m) => m[1]!));
}

/** Las que el completado ofrece y la ayuda no lista: --help no se lista a sí misma. */
const EXTRA = new Set(['--help']);

function comparar(archivo: string, completado: Set<string>): void {
  const ayuda = deLaAyuda('en');
  const faltan = [...ayuda].filter((b) => !completado.has(b));
  const sobran = [...completado].filter((b) => !ayuda.has(b) && !EXTRA.has(b));
  assert.deepEqual(faltan, [], `${archivo} no completa banderas que la ayuda documenta`);
  assert.deepEqual(sobran, [], `${archivo} completa banderas que la ayuda ya no tiene`);
}

describe('completado · las banderas son las de la ayuda', () => {
  it('la ayuda en castellano y en inglés documentan las mismas', () => {
    assert.deepEqual([...deLaAyuda('es')].sort(), [...deLaAyuda('en')].sort());
    assert.ok(deLaAyuda('en').size > 20, 'la expresión ya no encuentra las banderas en la ayuda');
  });

  it('bash completa todas, y ninguna de más', () => comparar('qm.bash', deBash()));
  it('zsh completa todas, y ninguna de más', () => comparar('_qm', deZsh()));
});

// ── que funcionen, no sólo que digan lo mismo ─────────────────────────────

const hay = (shell: string): boolean => spawnSync(shell, ['-c', 'true']).status === 0;

const falso = mkdtempSync(join(tmpdir(), 'qm-completado-'));
after(() => rmSync(falso, { recursive: true, force: true }));
writeFileSync(
  join(falso, 'qm'),
  `#!/bin/sh
cat <<'FIN'
{
  "esquema": 1,
  "frenaPrimero": { "perfil": "personal", "producto": "claude" },
  "perfiles": [
    { "producto": "claude", "perfil": "personal" },
    { "producto": "claude", "perfil": "teams" },
    { "producto": "codex", "perfil": "codex" }
  ]
}
FIN
`,
);
chmodSync(join(falso, 'qm'), 0o755);

/**
 * Lo que ofrece bash para la línea hasta el cursor. COMP_WORDS se parte como
 * lo parte bash, con el `=` como separador; la función mira COMP_LINE igual.
 */
function tabBash(linea: string): string[] {
  const r = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"
COMP_LINE=$2; COMP_POINT=\${#2}
read -ra COMP_WORDS <<< "\${2//=/ = }"
case $2 in *' '|*=) COMP_WORDS+=('') ;; esac
COMP_CWORD=$(( \${#COMP_WORDS[@]} - 1 ))
_qm
printf '%s\\n' "\${COMPREPLY[@]}"`,
      '_',
      BASH,
      linea,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${falso}${delimiter}${process.env['PATH'] ?? ''}` } },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).sort();
}

describe('completado · bash', { skip: hay('bash') ? false : 'sin bash' }, () => {
  it('las banderas, y las que llevan valor con el `=` puesto', () => {
    assert.deepEqual(tabBash('qm --so'), ['--solo=']);
    assert.deepEqual(tabBash('qm --cuen'), ['--cuenta=', '--cuentas=']);
    assert.deepEqual(tabBash('qm --diag'), ['--diagnostico']);
  });

  it('las cuentas salen de qm --json --breve, sin repetir', () => {
    assert.deepEqual(tabBash('qm --solo='), ['codex', 'personal', 'teams']);
    assert.deepEqual(tabBash('qm --cuentas=te'), ['teams']);
    assert.deepEqual(tabBash('qm --cuenta=co'), ['codex']);
  });

  it('en una lista con comas completa la última y no ofrece las que ya están', () => {
    assert.deepEqual(tabBash('qm --ocultar=personal,'), ['personal,codex', 'personal,teams']);
  });

  it('--idioma ofrece los dos idiomas; después de `--` no se mete', () => {
    assert.deepEqual(tabBash('qm --idioma='), ['en', 'es']);
    assert.deepEqual(tabBash('qm --mejor -- cl'), []);
  });
});

describe('completado · zsh', { skip: hay('zsh') ? false : 'sin zsh' }, () => {
  it('el archivo parsea', () => {
    const r = spawnSync('zsh', ['-n', ZSH], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});
