// El plan que se muestra de una cuenta de Claude.
//
// `plan` sale de `seatTier ?? organizationType`, y en una cuenta individual
// `seatTier` es null: Max 5x, Max 20x y Ultra quedaban las tres como
// `claude_max`. Una cuenta que había pasado a Ultra se seguía mostrando igual
// que cuando era Max 5x. Las cuentas de acá son inventadas: sólo la FORMA de
// `oauthAccount` es la que escribe Claude Code.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { leerCuenta, nombrePlan, planParaMostrar } from '../src/core/perfiles.ts';

const RAIZ = new URL('..', import.meta.url).pathname;

/** Una cuenta individual en Ultra: así quedó `oauthAccount` después del cambio de plan. */
const ULTRA = {
  emailAddress: 'quien@ejemplo.com',
  organizationName: 'Ejemplo',
  seatTier: null,
  organizationType: 'claude_max',
  organizationRateLimitTier: 'default_claude_max_20x',
  userRateLimitTier: null,
  planDisplayName: 'Ultra',
};

/** Un asiento de Teams: sin nombre de plan, y con el tier en el usuario y no en la organización. */
const TEAMS = {
  emailAddress: 'otra@ejemplo.com',
  organizationName: 'Equipo',
  seatTier: 'team_tier_1',
  organizationType: 'claude_team',
  organizationRateLimitTier: 'default_raven',
  userRateLimitTier: 'default_claude_max_5x',
};

/** La misma cuenta un mes antes, en Max 5x: lo que quedó en el `.claude.json` viejo. */
const MAX5 = {
  emailAddress: 'quien@ejemplo.com',
  organizationName: 'Ejemplo',
  seatTier: null,
  organizationType: 'claude_max',
  organizationRateLimitTier: 'default_claude_max_5x',
  userRateLimitTier: null,
};

/** Un `.claude.json` de antes de que existieran los campos nuevos. */
const VIEJA = {
  emailAddress: 'vieja@ejemplo.com',
  organizationName: 'Vieja',
  organizationType: 'claude_max',
};

test('una cuenta Ultra se muestra Ultra, con el multiplicador, y no claude_max', () => {
  assert.strictEqual(nombrePlan(ULTRA, 'claude_max'), 'Ultra (max_20x)');
});

test('en Teams manda el tier del asiento, no el nombre interno de la organización', () => {
  assert.strictEqual(nombrePlan(TEAMS, 'team_tier_1'), 'team_tier_1 (max_5x)');
});

test('sin campos nuevos, el plan se muestra como siempre', () => {
  assert.strictEqual(nombrePlan(VIEJA, 'claude_max'), 'claude_max');
});

test('un tier sin multiplicador no se muestra: es un nombre interno', () => {
  assert.strictEqual(nombrePlan({ planDisplayName: 'Pro', organizationRateLimitTier: 'default_claude_ai' }, 'claude_pro'), 'Pro');
  assert.strictEqual(nombrePlan({ organizationRateLimitTier: 'default_raven' }, 'claude_team'), 'claude_team');
});

test('si el nombre ya trae el multiplicador, no se repite entre paréntesis', () => {
  assert.strictEqual(nombrePlan({ planDisplayName: 'Max 20x', organizationRateLimitTier: 'default_claude_max_20x' }, 'claude_max'), 'Max 20x');
});

test('un planDisplayName vacío no tapa al plan', () => {
  assert.strictEqual(nombrePlan({ planDisplayName: '  ', organizationRateLimitTier: 'default_claude_max_5x' }, 'claude_max'), 'claude_max (max_5x)');
});

test('sin plan y sin nombre, null: no se inventa un plan a partir del tier', () => {
  assert.strictEqual(nombrePlan({ organizationRateLimitTier: 'default_claude_max_5x' }, null), null);
});

test('leerCuenta deja `plan` como identificador y pone el nombre aparte', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'qm-plan-')), '.claude-ejemplo');
  mkdirSync(dir);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: ULTRA }));
  const c = leerCuenta(dir);
  // `plan` no cambia de significado: relevancia() lo compara contra `free` y
  // el JSON ya lo publicaba así.
  assert.strictEqual(c?.plan, 'claude_max');
  assert.strictEqual(c?.planNombre, 'Ultra (max_20x)');
  assert.strictEqual(planParaMostrar(c), 'Ultra (max_20x)');
});

// ── cuál de los dos .claude.json manda ────────────────────────────────
//
// El perfil por defecto tiene dos candidatos: `~/.claude.json`, que es el que
// Claude Code escribe, y `~/.claude/.claude.json`, que apareció una vez y quedó
// quieto. Con los dos trayendo cuenta empataban, y ganaba el viejo por estar
// primero en la lista: la cuenta Ultra se leía como el Max 5x de un mes antes.

const HACE_UN_MES = new Date('2026-10-01T00:00:00Z');

function perfilConDos(adentro: object, alLado: object, viejo: 'adentro' | 'alLado'): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'qm-plan-')), '.claude');
  mkdirSync(dir);
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: adentro }));
  writeFileSync(`${dir}.json`, JSON.stringify({ oauthAccount: alLado }));
  const ruta = viejo === 'adentro' ? join(dir, '.claude.json') : `${dir}.json`;
  utimesSync(ruta, HACE_UN_MES, HACE_UN_MES);
  return dir;
}

test('a igual riqueza manda el .claude.json más nuevo, no el que está primero', () => {
  // El caso medido: el de adentro es el viejo.
  assert.strictEqual(leerCuenta(perfilConDos(MAX5, ULTRA, 'adentro'))?.planNombre, 'Ultra (max_20x)');
  // Y al revés, para que el test no pase por el orden de las rutas.
  assert.strictEqual(leerCuenta(perfilConDos(ULTRA, MAX5, 'alLado'))?.planNombre, 'Ultra (max_20x)');
});

test('planParaMostrar cae en plan cuando la fuente no da un nombre', () => {
  // Codex, opencode y Antigravity arman su Cuenta sin planNombre.
  assert.strictEqual(planParaMostrar({ email: null, organizacion: null, plan: 'plus' }), 'plus');
  assert.strictEqual(planParaMostrar(null), null);
});

// ── de punta a punta: el binario, con una casa de mentira ──────────────
//
// Lo que se rompía no era una función sino lo que llegaba a la pantalla y al
// JSON, así que se corre `bin/qm` de verdad con un HOME que tiene una sola
// cuenta, inventada.

function casaConUltra(): NodeJS.ProcessEnv {
  const casa = mkdtempSync(join(tmpdir(), 'qm-plan-casa-'));
  mkdirSync(join(casa, '.claude'));
  writeFileSync(join(casa, '.claude.json'), JSON.stringify({ oauthAccount: ULTRA }));
  // Como en la máquina donde se encontró: un `.claude.json` viejo adentro del
  // directorio, con la cuenta de cuando era Max 5x.
  writeFileSync(join(casa, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: MAX5 }));
  utimesSync(join(casa, '.claude', '.claude.json'), HACE_UN_MES, HACE_UN_MES);
  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  delete env['QM_CODEX'];
  return {
    ...env,
    HOME: casa,
    XDG_CACHE_HOME: join(casa, 'cache'),
    XDG_CONFIG_HOME: join(casa, 'config'),
    XDG_DATA_HOME: join(casa, 'data'),
    NO_COLOR: '1',
  };
}

test('--json trae plan igual que antes y planNombre con el nombre de verdad', () => {
  const salida = execFileSync(join(RAIZ, 'bin', 'qm'), ['--json', '--breve'], {
    encoding: 'utf8',
    env: casaConUltra(),
    timeout: 30_000,
  });
  const d = JSON.parse(salida) as { esquema: number; perfiles: Record<string, unknown>[] };
  assert.strictEqual(d.esquema, 1, 'agregar un campo no mueve el esquema');
  const p = d.perfiles.find((x) => x['perfil'] === '.claude');
  assert.ok(p !== undefined, 'la cuenta de la casa de mentira tiene que aparecer');
  assert.strictEqual(p['plan'], 'claude_max');
  assert.strictEqual(p['planNombre'], 'Ultra (max_20x)');
});

test('la terminal muestra el mismo nombre que el JSON', () => {
  const salida = execFileSync(join(RAIZ, 'bin', 'qm'), [], {
    encoding: 'utf8',
    env: casaConUltra(),
    timeout: 30_000,
  }).replace(/\x1b\[[0-9;]*m/g, '');
  const fila = salida.split('\n').find((l) => l.includes('quien@ejemplo.com'));
  assert.ok(fila !== undefined, `no está la fila de la cuenta:\n${salida.slice(0, 400)}`);
  assert.match(fila, /· Ultra \(max_20x\)/);
  assert.doesNotMatch(fila, /claude_max/);
});
