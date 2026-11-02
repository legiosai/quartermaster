// La statusline como sensor: lo que Claude Code le pasa por stdin, guardado y
// superpuesto a la lectura que ya había.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import { perfilDeLaStatusline, sesionDeStatusline, superponer, ventanasDeStatusline } from '../src/adapters/statusline.ts';
import type { ResultadoCuota, VentanaCuota } from '../src/core/tipos.ts';

const RAIZ = new URL('..', import.meta.url).pathname;

/** Lo que manda Claude Code, recortado a lo que importa. Las fechas en segundos, como las manda. */
const RESET_5H = Date.UTC(2026, 10, 1, 23, 0, 0) / 1000;
const RESET_7D = Date.UTC(2026, 10, 5, 12, 0, 0) / 1000;
const ENTRADA = {
  session_id: 'inventada',
  model: { id: 'claude-x', display_name: 'X' },
  // Un `used_percentage` que NO es cuota: el contexto lleno no frena la cuenta.
  context_window: { used_percentage: 97, remaining_percentage: 3 },
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: RESET_5H },
    seven_day: { used_percentage: 41, resets_at: RESET_7D },
  },
};

const v = (clave: string, porcentaje: number, extra: Partial<VentanaCuota> = {}): VentanaCuota => ({
  clave,
  porcentaje,
  reinicia: null,
  severidad: 'normal',
  activa: false,
  alcance: null,
  grupo: null,
  ...extra,
});

const ok = (iso: string, ventanas: VentanaCuota[], origen: 'endpoint' | 'statusline' = 'endpoint'): ResultadoCuota => ({
  estado: 'ok',
  origen,
  medidoEn: new Date(iso),
  ventanas,
});

describe('ventanasDeStatusline · qué se lee de la entrada', () => {
  it('lee sólo rate_limits, y con los nombres del endpoint', () => {
    const vs = ventanasDeStatusline(ENTRADA);
    assert.deepEqual(
      vs.map((w) => [w.clave, w.grupo, w.porcentaje]),
      [
        ['session', 'session', 23],
        ['weekly_all', 'weekly', 41],
      ],
    );
    assert.equal(vs[0]!.reinicia?.getTime(), RESET_5H * 1000, 'resets_at viene en segundos');
  });

  it('sin rate_limits no hay cuota, aunque haya otros used_percentage', () => {
    // Una cuenta con API key, o el primer redibujo antes de hablar con la API.
    const { rate_limits: _, ...sinCuota } = ENTRADA;
    assert.deepEqual(ventanasDeStatusline(sinCuota), []);
    assert.deepEqual(ventanasDeStatusline(null), []);
    assert.deepEqual(ventanasDeStatusline('texto'), []);
  });
});

describe('perfilDeLaStatusline · de qué perfil es este redibujo', () => {
  it('CLAUDE_CONFIG_DIR manda, y el nombre es el último tramo', () => {
    assert.equal(perfilDeLaStatusline({ CLAUDE_CONFIG_DIR: '/casa/.claude-teams/' }), '.claude-teams');
  });
  it('sin la variable es el perfil por defecto', () => {
    assert.equal(perfilDeLaStatusline({}), '.claude');
  });
});

describe('superponer · la statusline encima de la lectura guardada', () => {
  const reinicioSemana = new Date(RESET_7D * 1000);
  const base = ok('2026-11-01T18:00:00.000Z', [
    v('session', 10, { grupo: 'session', activa: true, reinicia: new Date(RESET_5H * 1000) }),
    v('weekly_all', 30, { grupo: 'weekly', reinicia: reinicioSemana, severidad: 'warning' }),
    v('weekly_scoped', 75, { grupo: 'weekly', alcance: 'Fable', severidad: 'warning' }),
    v('iguana_necktie', 44),
  ]);
  const sensor = ok('2026-11-01T20:00:00.000Z', ventanasDeStatusline(ENTRADA), 'statusline');

  it('la más nueva gana barra por barra, y no se pierde ninguna', () => {
    const r = superponer(base, sensor);
    assert.equal(r.estado, 'ok');
    if (r.estado !== 'ok') return;
    assert.equal(r.origen, 'statusline');
    assert.equal(r.medidoEn.toISOString(), '2026-11-01T20:00:00.000Z');
    const por = new Map(r.ventanas.map((w) => [w.clave, w]));
    assert.deepEqual([...por.keys()], ['session', 'weekly_all', 'weekly_scoped', 'iguana_necktie']);
    assert.equal(por.get('session')!.porcentaje, 23);
    assert.equal(por.get('session')!.activa, true, 'lo que sólo sabe limits[] se conserva');
    assert.equal(por.get('weekly_all')!.porcentaje, 41);
    // Las que la statusline no conoce siguen ahí, y dicen de cuándo son.
    assert.equal(por.get('weekly_scoped')!.porcentaje, 75);
    assert.equal(por.get('weekly_scoped')!.medidaEn?.toISOString(), '2026-11-01T18:00:00.000Z');
    assert.equal(por.get('iguana_necktie')!.medidaEn?.toISOString(), '2026-11-01T18:00:00.000Z');
    // Y las refrescadas no llevan edad propia: son de `medidoEn`.
    assert.equal(por.get('session')!.medidaEn, undefined);
  });

  it('la severidad se conserva en la misma ventana y se suelta si se reinició', () => {
    const r = superponer(base, sensor);
    if (r.estado !== 'ok') return assert.fail('esperaba ok');
    assert.equal(r.ventanas.find((w) => w.clave === 'weekly_all')!.severidad, 'warning');
    const otraSemana = ok('2026-11-01T20:00:00.000Z', [
      v('weekly_all', 2, { grupo: 'weekly', reinicia: new Date(reinicioSemana.getTime() + 7 * 86_400_000) }),
    ], 'statusline');
    const r2 = superponer(base, otraSemana);
    if (r2.estado !== 'ok') return assert.fail('esperaba ok');
    assert.equal(r2.ventanas.find((w) => w.clave === 'weekly_all')!.severidad, 'normal');
  });

  it('una statusline más vieja no pisa nada, pero suma la barra que la base no tenía', () => {
    // Una cuenta Ultra: el endpoint no manda sesión y la statusline sí.
    const sinSesion = ok('2026-11-01T21:00:00.000Z', [v('weekly_all', 9, { grupo: 'weekly' }), v('iguana_necktie', 44)]);
    const r = superponer(sinSesion, sensor);
    if (r.estado !== 'ok') return assert.fail('esperaba ok');
    assert.equal(r.origen, 'endpoint');
    assert.equal(r.ventanas.find((w) => w.clave === 'weekly_all')!.porcentaje, 9, 'la del endpoint es más nueva');
    const s = r.ventanas[0];
    assert.equal(s?.clave, 'session', 'la sesión agregada va primero, como la manda el servidor');
    assert.equal(s?.porcentaje, 23);
    assert.equal(s?.medidaEn?.toISOString(), '2026-11-01T20:00:00.000Z');
  });

  it('sin base, la statusline sola; sin statusline, la base intacta', () => {
    assert.equal(superponer({ estado: 'sin-cache' }, sensor), sensor);
    assert.equal(superponer(base, null), base);
    assert.equal(superponer(base, { estado: 'sin-cache' }), base);
    assert.equal(superponer(base, ok('2026-11-02T00:00:00.000Z', [], 'statusline')), base);
  });
});

// ── de punta a punta: qm --statusline con una casa de mentira ────────────

function casa(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qm-statusline-casa-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'quien@ejemplo.com' } }));
  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  delete env['QM_CODEX'];
  return {
    dir,
    env: {
      ...env,
      HOME: dir,
      USERPROFILE: dir,
      XDG_CACHE_HOME: join(dir, 'cache'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
      NO_COLOR: '1',
    },
  };
}

// Directo contra src/: `bin/qm` prefiere un dist/ que puede ser viejo.
const qm = (args: string[], env: NodeJS.ProcessEnv, input?: string): string =>
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), ...args], {
    encoding: 'utf8',
    env,
    input,
    timeout: 30_000,
  }).replace(/\x1b\[[0-9;]*m/g, '');

test('una instalación nueva: sin statusline no hay número, y la frase dice cómo conseguirlo', () => {
  const { env } = casa();
  const salida = qm(['--sin-codex', '--sin-antigravity'], env);
  assert.match(salida, /qm --statusline/);
  assert.doesNotMatch(salida, /usalo una vez/);
});

test('qm --statusline guarda lo que llega por stdin y lo dibuja en el mismo renglón', () => {
  const { env, dir } = casa();
  const futuro = Math.floor(Date.now() / 1000) + 3600;
  const entrada = JSON.stringify({
    ...ENTRADA,
    rate_limits: {
      five_hour: { used_percentage: 23, resets_at: futuro },
      seven_day: { used_percentage: 41, resets_at: futuro + 86_400 },
    },
  });
  const renglon = qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, entrada);
  assert.match(renglon, /main 23\/41%/);

  const guardado = JSON.parse(readFileSync(join(dir, '.cache', 'quartermaster', 'statusline.json'), 'utf8'));
  assert.ok(guardado['.claude'], 'se guarda bajo el nombre del perfil');

  // Y la próxima corrida sin stdin lo encuentra: en la terminal y en el JSON.
  const d = JSON.parse(qm(['--json', '--breve', '--sin-codex', '--sin-antigravity'], env)) as {
    perfiles: { perfil: string; cuota: { origen: string; frena: { porcentaje: number } } }[];
  };
  const p = d.perfiles.find((x) => x.perfil === '.claude');
  assert.equal(p?.cuota.origen, 'statusline');
  assert.equal(p?.cuota.frena.porcentaje, 41);
});

test('qm --statusline con una entrada sin rate_limits dibuja igual y no pisa la anterior', () => {
  const { env } = casa();
  const futuro = Math.floor(Date.now() / 1000) + 3600;
  qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 12, resets_at: futuro } },
  }));
  const renglon = qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, JSON.stringify({ session_id: 'x' }));
  assert.match(renglon, /main 12%/);
  // Y basura en stdin tampoco la rompe.
  assert.match(qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, 'no es json'), /main 12%/);
});

describe('sesionDeStatusline · contexto y cache de la sesión que dibuja', () => {
  it('lee el contexto y el cache tal cual los manda Claude Code', () => {
    const s = sesionDeStatusline({
      context_window: { total_input_tokens: 182_400, used_percentage: 18 },
      prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: 1_793_580_000, recache_tokens_if_cold: 181_000 },
    });
    assert.equal(s.contexto, 182_400);
    assert.equal(s.cache?.caliente, true);
    assert.equal(s.cache?.venceEn?.getTime(), 1_793_580_000_000);
    assert.equal(s.cache?.recachear, 181_000);
  });

  it('sin total_input_tokens suma el último uso', () => {
    const s = sesionDeStatusline({
      context_window: { current_usage: { input_tokens: 10, cache_creation_input_tokens: 990, cache_read_input_tokens: 9_000 } },
    });
    assert.equal(s.contexto, 10_000);
  });

  it('un proveedor que no cachea no tiene cache que se enfríe', () => {
    // Si no, la statusline diría «caché fría» para siempre.
    const s = sesionDeStatusline({ prompt_cache: { warm: false, caching_observed: false, expires_at: null } });
    assert.equal(s.cache, null);
  });

  it('antes de la primera respuesta no hay nada', () => {
    assert.deepEqual(sesionDeStatusline({ session_id: 'x' }), { contexto: null, cache: null });
    assert.deepEqual(sesionDeStatusline(null), { contexto: null, cache: null });
  });
});

test('qm --statusline antepone el contexto y lo que le queda al cache', () => {
  const { env } = casa();
  const ahora = Math.floor(Date.now() / 1000);
  const base = { rate_limits: { five_hour: { used_percentage: 12, resets_at: ahora + 3600 } } };
  const caliente = qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, JSON.stringify({
    ...base,
    context_window: { total_input_tokens: 182_400 },
    prompt_cache: { warm: true, caching_observed: true, expires_at: ahora + 12 * 60 + 30, recache_tokens_if_cold: 181_000 },
  }));
  assert.match(caliente, /^ctx 182k · caché 12m · main 12%$/m);

  const fria = qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, JSON.stringify({
    ...base,
    context_window: { total_input_tokens: 182_400 },
    prompt_cache: { warm: false, caching_observed: true, expires_at: ahora - 60, recache_tokens_if_cold: 181_000 },
  }));
  assert.match(fria, /^ctx 182k · caché fría \(\+181k\) · main 12%$/m);

  // --breve no lee stdin y no cambia: los scripts que ya lo usan siguen igual.
  assert.match(qm(['--breve', '--sin-codex', '--sin-antigravity'], env), /^main 12%$/m);
});

test('las cuentas dormidas van en un renglón cada una al pie, y --todas las muestra enteras', () => {
  const { env, dir } = casa();
  // Una segunda cuenta que nadie usa: sin transcripciones, sin credencial.
  mkdirSync(join(dir, '.claude-vieja'));
  writeFileSync(join(dir, '.claude-vieja', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'vieja@ejemplo.com' } }));
  const futuro = Math.floor(Date.now() / 1000) + 3600;
  qm(['--statusline', '--sin-codex', '--sin-antigravity'], env, JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 12, resets_at: futuro } },
  }));
  // La cuenta principal tiene que tener actividad para no quedar dormida ella también.
  const proyecto = join(dir, '.claude', 'projects', 'p');
  mkdirSync(proyecto, { recursive: true });
  writeFileSync(join(proyecto, 's.jsonl'), '');

  const tabla = qm(['--sin-codex', '--sin-antigravity'], env);
  assert.match(tabla, /dormidas · `qm --todas` las muestra enteras/);
  const renglones = tabla.split('\n').filter((l) => l.includes('.claude-vieja'));
  assert.equal(renglones.length, 1, `la dormida ocupa un renglón:\n${tabla}`);
  assert.doesNotMatch(tabla, /vieja@ejemplo\.com/);

  const entera = qm(['--todas', '--sin-codex', '--sin-antigravity'], env);
  assert.match(entera, /vieja@ejemplo\.com/);
  assert.doesNotMatch(entera, /dormidas ·/);
});
