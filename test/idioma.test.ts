// El idioma de qm: de dónde sale, y que el inglés llegue de verdad a la pantalla.
//
// Los demás tests fijan QM_IDIOMA=es porque leen frases en castellano. Éste es
// el único que prueba el inglés, y el único que prueba la regla que decide.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import { idioma, idiomaPedido, tr } from '../src/core/idioma.ts';
import { tokens, reinicio } from '../src/render/barras.ts';

const RAIZ = new URL('..', import.meta.url).pathname;

describe('idioma · de dónde sale', () => {
  it('QM_IDIOMA gana sobre todo el locale', () => {
    assert.equal(idioma({ QM_IDIOMA: 'en', LC_ALL: 'es_AR.UTF-8', LANG: 'es_AR.UTF-8' }), 'en');
    assert.equal(idioma({ QM_IDIOMA: 'es', LC_ALL: 'C.UTF-8', LANG: 'en_US.UTF-8' }), 'es');
    assert.equal(idioma({ QM_IDIOMA: ' EN ' }), 'en', 'sin distinguir mayúsculas ni espacios');
  });

  it('un QM_IDIOMA que no existe no cuenta: decide el locale', () => {
    assert.equal(idioma({ QM_IDIOMA: 'fr', LANG: 'es_AR.UTF-8' }), 'es');
    assert.equal(idiomaPedido({ QM_IDIOMA: 'fr' }), null);
    assert.equal(idiomaPedido({}), null);
  });

  it('LC_ALL, después LC_MESSAGES, después LANG: el orden de POSIX', () => {
    // La máquina donde se escribió esto: LANG en inglés y LC_ALL en C.UTF-8.
    assert.equal(idioma({ LC_ALL: 'C.UTF-8', LANG: 'en_US.UTF-8' }), 'en');
    assert.equal(idioma({ LC_ALL: 'C.UTF-8', LANG: 'es_AR.UTF-8' }), 'en', 'LC_ALL pisa a LANG');
    assert.equal(idioma({ LC_ALL: '', LC_MESSAGES: 'es_AR.UTF-8', LANG: 'en_US.UTF-8' }), 'es');
    assert.equal(idioma({ LANG: 'es_AR.UTF-8' }), 'es');
    assert.equal(idioma({ LANG: 'es' }), 'es');
    assert.equal(idioma({ LANG: 'en_GB.UTF-8' }), 'en');
  });

  it('C y POSIX son inglés, y una palabra que empieza con «es» no es castellano', () => {
    assert.equal(idioma({ LANG: 'C' }), 'en');
    assert.equal(idioma({ LANG: 'POSIX' }), 'en');
    assert.equal(idioma({ LANG: 'estonian' }), 'en');
  });

  it('sin ninguna variable (Windows) decide el locale de Intl', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().locale;
    assert.equal(idioma({}), /^es([_-]|$)/i.test(local) ? 'es' : 'en');
  });

  it('tr elige según el entorno de ese momento, no el del import', () => {
    const antes = process.env['QM_IDIOMA'];
    try {
      process.env['QM_IDIOMA'] = 'es';
      assert.equal(tr('hola', 'hello'), 'hola');
      process.env['QM_IDIOMA'] = 'en';
      assert.equal(tr('hola', 'hello'), 'hello');
    } finally {
      if (antes === undefined) delete process.env['QM_IDIOMA'];
      else process.env['QM_IDIOMA'] = antes;
    }
  });
});

describe('los números y las duraciones, en cada idioma', () => {
  it('la coma decimal es del castellano: en inglés se leería como miles', () => {
    const antes = process.env['QM_IDIOMA'];
    try {
      process.env['QM_IDIOMA'] = 'es';
      assert.equal(tokens(5_890_000_000), '5,9G');
      assert.equal(reinicio(3_600_000), 'reinicia en 1h00m');
      process.env['QM_IDIOMA'] = 'en';
      assert.equal(tokens(5_890_000_000), '5.9G');
      assert.equal(tokens(677_600_000), '677.6M');
      assert.equal(reinicio(3_600_000), 'resets in 1h00m');
      assert.equal(reinicio(-3_600_000), 'reset 1h00m ago');
    } finally {
      if (antes === undefined) delete process.env['QM_IDIOMA'];
      else process.env['QM_IDIOMA'] = antes;
    }
  });
});

// ── de punta a punta, con una casa de mentira ───────────────────────────

/** Una casa con una sola cuenta, en el locale que se pida. HOME y las tres XDG van adentro. */
function casa(locale: Record<string, string>): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qm-idioma-casa-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'quien@ejemplo.com' } }));
  const env = { ...process.env };
  for (const k of ['CLAUDE_CONFIG_DIR', 'QM_CODEX', 'QM_IDIOMA', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) delete env[k];
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
      ...locale,
    },
  };
}

const INGLES = { LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8' };
const CASTELLANO = { LANG: 'es_AR.UTF-8' };
const SIN = ['--sin-codex', '--sin-antigravity'];

// Directo contra src/: `bin/qm` puede preferir un dist/ viejo.
const qm = (args: string[], env: NodeJS.ProcessEnv, input?: string): string =>
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), ...args], {
    encoding: 'utf8',
    env,
    input,
    timeout: 30_000,
  }).replace(/\x1b\[[0-9;]*m/g, '');

test('con un locale en inglés, la tabla está en inglés', () => {
  const { env } = casa(INGLES);
  const tabla = qm(SIN, env);
  assert.match(tabla, /usage over 7d/);
  assert.match(tabla, /credential: no credential/);
  // La frase de una instalación nueva: es lo primero que lee quien llega del README.
  assert.match(tabla, /quota: no stored quota for this profile — set `qm --statusline`/);
  assert.doesNotMatch(tabla, /credencial|cuota guardada|consumo de/);
});

test('con un locale en castellano, la tabla sigue en castellano', () => {
  const { env } = casa(CASTELLANO);
  const tabla = qm(SIN, env);
  assert.match(tabla, /consumo de 7d/);
  assert.match(tabla, /credencial: sin credencial/);
  assert.match(tabla, /no hay cuota guardada para este perfil/);
});

test('--statusline en inglés, con el contexto y el cache', () => {
  const { env } = casa(INGLES);
  const ahora = Math.floor(Date.now() / 1000);
  const base = { rate_limits: { five_hour: { used_percentage: 12, resets_at: ahora + 3600 } } };
  const caliente = qm(['--statusline', ...SIN], env, JSON.stringify({
    ...base,
    context_window: { total_input_tokens: 182_400 },
    prompt_cache: { warm: true, caching_observed: true, expires_at: ahora + 12 * 60 + 30, recache_tokens_if_cold: 181_000 },
  }));
  assert.match(caliente, /^ctx 182k · cache 12m · main 12%$/m);
  const fria = qm(['--statusline', ...SIN], env, JSON.stringify({
    ...base,
    context_window: { total_input_tokens: 182_400 },
    prompt_cache: { warm: false, caching_observed: true, expires_at: ahora - 60, recache_tokens_if_cold: 181_000 },
  }));
  assert.match(fria, /^ctx 182k · cold cache \(\+181k\) · main 12%$/m);

  // Y la tabla con la cuota de la statusline: reinicio, edad y quién frena, en inglés.
  const tabla = qm(SIN, env);
  assert.match(tabla, /statusline · now/);
  assert.match(tabla, /resets in 59m|resets in 1h00m/);
  assert.match(tabla, /first to stop you: \.claude · session 12%/);
});

test('--help en inglés lista --idioma', () => {
  const { env } = casa(INGLES);
  const ayuda = qm(['--help'], env);
  assert.match(ayuda, /how much quota you have left, in every Claude Code profile/);
  assert.match(ayuda, /--idioma=es\|en/);
  assert.doesNotMatch(ayuda, /cuánta cuota/);
});

test('--idioma= pisa al locale, en las dos direcciones', () => {
  const ingles = casa(INGLES);
  assert.match(qm(['--idioma=es', ...SIN], ingles.env), /consumo de 7d/);
  const castellano = casa(CASTELLANO);
  assert.match(qm(['--idioma=en', ...SIN], castellano.env), /usage over 7d/);
  // QM_IDIOMA hace lo mismo, para siempre.
  assert.match(qm(SIN, { ...castellano.env, QM_IDIOMA: 'en' }), /usage over 7d/);
});

test('--idioma con un idioma que no existe sale 2 y lo dice', () => {
  const { env } = casa(INGLES);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), '--idioma=fr'], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--idioma expects es or en, not "fr"/);
});

test('una opción que no existe lo dice en inglés y sale 2', () => {
  const { env } = casa(INGLES);
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), '--nada'], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^unknown option: --nada/);
});

test('--json sigue en castellano aunque el locale sea inglés: lo leen los paneles', () => {
  const { env } = casa(INGLES);
  type Json = { perfiles: { perfil: string; credencial: string; cuota: { frase?: string } }[] };
  const fila = (j: string) => (JSON.parse(j) as Json).perfiles.find((p) => p.perfil === '.claude')!;

  const porDefecto = fila(qm(['--json', '--breve', ...SIN], env));
  assert.equal(porDefecto.credencial, 'sin credencial');
  assert.match(porDefecto.cuota.frase!, /^no hay cuota guardada/);

  // Pedido a propósito, sí cambia. Las claves no, nunca.
  const pedido = fila(qm(['--json', '--breve', '--idioma=en', ...SIN], env));
  assert.equal(pedido.credencial, 'no credential');
  assert.match(pedido.cuota.frase!, /^no stored quota/);
  const conVariable = fila(qm(['--json', '--breve', ...SIN], { ...env, QM_IDIOMA: 'en' }));
  assert.equal(conVariable.credencial, 'no credential');
});
