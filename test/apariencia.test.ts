// `qm --apariencia`: cómo se ve el panel de GNOME (issue #27).
//
// Tres cosas importan. Que quien no toca nada siga viendo lo de siempre. Que
// el valor viaje en `qm --json`, porque el indicador dibuja lo que el CLI
// decide y no lee la config por su cuenta. Y que guardarlo no rompa nada: es
// lo primero que `qm` ESCRIBE en config.json, un archivo que hasta acá sólo se
// editaba a mano.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env['QM_IDIOMA'] = 'es';

const RAIZ = new URL('..', import.meta.url).pathname;

function casaVacia(): { casa: string; env: NodeJS.ProcessEnv; config: string } {
  const casa = mkdtempSync(join(tmpdir(), 'qm-apariencia-'));
  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  return {
    casa,
    config: join(casa, 'config', 'quartermaster', 'config.json'),
    env: {
      ...env,
      HOME: casa,
      USERPROFILE: casa,
      XDG_CACHE_HOME: join(casa, 'cache'),
      XDG_CONFIG_HOME: join(casa, 'config'),
      XDG_DATA_HOME: join(casa, 'data'),
      QM_IDIOMA: 'es',
      NO_COLOR: '1',
    },
  };
}

const qm = (env: NodeJS.ProcessEnv, args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });

test('sin config, la apariencia es la básica, y viaja en el JSON', () => {
  const { env } = casaVacia();
  const r = qm(env, ['--json', '--breve', '--sin-codex', '--sin-antigravity']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).apariencia, 'basica');
  assert.match(qm(env, ['--apariencia']).stdout, /^basica /);
});

test('--apariencia=minimalista se guarda sin tocar el resto de la config', () => {
  const { env, config } = casaVacia();
  mkdirSync(join(config, '..'), { recursive: true });
  writeFileSync(config, JSON.stringify({ ocultar: ['bedrock'], otraCosa: 1 }));
  const r = qm(env, ['--apariencia=minimalista']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /guardada en ~/, 'dice dónde, y sin la casa');
  const guardado = JSON.parse(readFileSync(config, 'utf8'));
  assert.deepEqual(guardado, { ocultar: ['bedrock'], otraCosa: 1, apariencia: 'minimalista' });

  const j = qm(env, ['--json', '--breve', '--sin-codex', '--sin-antigravity']);
  assert.equal(JSON.parse(j.stdout).apariencia, 'minimalista');
  // Y se vuelve atrás igual.
  assert.equal(qm(env, ['--apariencia=basica']).status, 0);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).apariencia, 'basica');
});

test('un valor desconocido no se guarda, y dice cuáles hay', () => {
  const { env, config } = casaVacia();
  const r = qm(env, ['--apariencia=neon']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /basica, minimalista/);
  assert.throws(() => readFileSync(config), 'no tiene que haber escrito nada');
});

test('una config rota no se pisa: se dice por qué y no se escribe', () => {
  const { env, config } = casaVacia();
  mkdirSync(join(config, '..'), { recursive: true });
  const roto = '{ "ocultar": ["bedrock"], }';
  writeFileSync(config, roto);
  const r = qm(env, ['--apariencia=minimalista']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no es un JSON válido y no lo piso/);
  assert.equal(readFileSync(config, 'utf8'), roto, 'el archivo quedó como estaba');
});

test('a mano en config.json, un valor que no existe es la básica', async () => {
  const { config, env } = casaVacia();
  mkdirSync(join(config, '..'), { recursive: true });
  writeFileSync(config, JSON.stringify({ apariencia: 'neon' }));
  const j = qm(env, ['--json', '--breve', '--sin-codex', '--sin-antigravity']);
  assert.equal(JSON.parse(j.stdout).apariencia, 'basica');
});
