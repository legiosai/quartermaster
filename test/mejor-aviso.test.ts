// qm --mejor y qm --aviso de punta a punta, con una casa de mentira de dos
// perfiles. Directo contra src/: `bin/qm` prefiere un dist/ que puede ser viejo.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const RAIZ = new URL('..', import.meta.url).pathname;
// En macOS la credencial vive en el llavero y una casa de mentira no la tiene.
const sinLlavero = { skip: process.platform === 'darwin' ? 'la credencial de macOS está en el llavero' : false };

interface Casa {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** Dos perfiles con cuota guardada: `main` al `pctMain` %, `teams` al `pctTeams` %. */
function casa(pctMain: number, pctTeams: number, conCredencial = true): Casa {
  const dir = mkdtempSync(join(tmpdir(), 'qm-mejor-casa-'));
  const ahora = Date.now();
  const reinicia = new Date(ahora + 2 * 3600_000).toISOString();
  const cuota = (pct: number) => ({
    fetchedAtMs: ahora - 60_000,
    utilization: {
      limits: [
        { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: reinicia, scope: null, is_active: false },
        { kind: 'weekly_all', group: 'weekly', percent: pct, severity: 'normal', resets_at: reinicia, scope: null, is_active: false },
      ],
    },
  });
  const cred = JSON.stringify({ claudeAiOauth: { accessToken: 'inventado', expiresAt: ahora + 3600_000 } });

  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@ejemplo.com' }, cachedUsageUtilization: cuota(pctMain) }));
  mkdirSync(join(dir, '.claude-teams'));
  writeFileSync(
    join(dir, '.claude-teams', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'b@ejemplo.com' }, cachedUsageUtilization: cuota(pctTeams) }),
  );
  if (conCredencial) {
    writeFileSync(join(dir, '.claude', '.credentials.json'), cred);
    writeFileSync(join(dir, '.claude-teams', '.credentials.json'), cred);
  }

  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  delete env['QM_CODEX'];
  return {
    dir,
    env: {
      ...env,
      HOME: dir,
      USERPROFILE: dir,
      // Las tres: la shell de Valen las exporta, y con sólo HOME el historial
      // de verdad recibe lecturas inventadas.
      XDG_CACHE_HOME: join(dir, 'cache'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
      NO_COLOR: '1',
      // Las frases que se comparan son las castellanas, sea cual sea el locale.
      QM_IDIOMA: 'es',
    },
  };
}

function qm(c: Casa, args: string[], extra: NodeJS.ProcessEnv = {}, input = '') {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src', 'cli', 'qm.ts'), ...args], {
    encoding: 'utf8',
    env: { ...c.env, ...extra },
    input,
    timeout: 30_000,
  });
}

test('--mejor imprime el directorio del que tiene más lugar, y nada más', sinLlavero, () => {
  const c = casa(92, 6);
  const r = qm(c, ['--mejor']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${join(c.dir, '.claude-teams')}\n`);
});

test('--mejor --json trae el orden y por qué', sinLlavero, () => {
  const c = casa(92, 6);
  const r = qm(c, ['--mejor', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout) as { elegida: { perfil: string; libre: number; nivel: string }; orden: { perfil: string }[] };
  assert.equal(d.elegida.perfil, '.claude-teams');
  assert.equal(d.elegida.libre, 94);
  assert.equal(d.elegida.nivel, 'libre');
  assert.deepEqual(d.orden.map((x) => x.perfil), ['.claude-teams', '.claude']);
});

test('--mejor -- comando: pone CLAUDE_CONFIG_DIR, o la saca para el perfil por defecto', sinLlavero, () => {
  const muestra = ['--', process.execPath, '-e', "console.log(process.env.CLAUDE_CONFIG_DIR ?? 'SIN')"];
  const a = casa(92, 6);
  assert.equal(qm(a, ['--mejor', ...muestra]).stdout.trim(), join(a.dir, '.claude-teams'));
  // El perfil por defecto gana: la variable se SACA, aunque viniera puesta.
  const b = casa(3, 80);
  const r = qm(b, ['--mejor', ...muestra], { CLAUDE_CONFIG_DIR: join(b.dir, '.claude-teams') });
  assert.equal(r.stdout.trim(), 'SIN');
  // La que frena en main es la sesión al 5 %, no la semanal al 3 %.
  assert.match(r.stderr, /qm · main \(95 % libre\)/);
});

test('--mejor -- comando devuelve el código del comando', sinLlavero, () => {
  const c = casa(10, 20);
  assert.equal(qm(c, ['--mejor', '--', process.execPath, '-e', 'process.exit(7)']).status, 7);
});

test('--mejor sin ninguna cuenta comparable: stdout vacío, frase en stderr, código 1', () => {
  const c = casa(10, 20, false);
  const r = qm(c, ['--mejor']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /ninguna cuenta de Claude tiene un número/);
});

test('--aviso avisa una vez, con a dónde pasarse, y no frena el prompt', sinLlavero, () => {
  const c = casa(92, 6);
  const hook = JSON.stringify({ session_id: 'x', hook_event_name: 'UserPromptSubmit', prompt: 'hola' });
  const r = qm(c, ['--aviso'], {}, hook);
  assert.equal(r.status, 0, r.stderr);
  const salida = JSON.parse(r.stdout) as { systemMessage: string; suppressOutput: boolean };
  assert.match(salida.systemMessage, /^qm · main: weekly_all al 92 %/);
  assert.match(salida.systemMessage, /teams tiene 94 % libre: CLAUDE_CONFIG_DIR=~\/\.claude-teams claude$/);
  assert.equal(salida.suppressOutput, true);
  assert.ok(!('continue' in salida) && !('decision' in salida), 'nunca bloquea');
  assert.ok(existsSync(join(c.dir, 'cache', 'quartermaster', 'avisos-claude-code.json')), 'la memoria va al XDG_CACHE_HOME');

  // El mismo escalón no vuelve a sonar en el prompt siguiente.
  const otra = qm(c, ['--aviso'], {}, hook);
  assert.equal(otra.status, 0);
  assert.equal(otra.stdout, '');
});

test('--aviso no dice nada cuando hay lugar, ni con un umbral más alto que la barra', sinLlavero, () => {
  const c = casa(92, 6);
  const teams = qm(c, ['--aviso'], { CLAUDE_CONFIG_DIR: join(c.dir, '.claude-teams') }, '{}');
  assert.equal(teams.status, 0);
  assert.equal(teams.stdout, '');
  const alto = qm(c, ['--aviso', '--umbral=95'], {}, '{}');
  assert.equal(alto.stdout, '');
  assert.equal(readFileSync(join(c.dir, '.claude.json'), 'utf8').includes('cachedUsageUtilization'), true, 'no toca la config de Claude Code');
});

test('--aviso con basura en stdin o sin cuota sale 0 y callado', () => {
  const c = casa(92, 6);
  const r = qm(c, ['--aviso'], {}, 'no es json');
  assert.equal(r.status, 0);
  const vacia = mkdtempSync(join(tmpdir(), 'qm-aviso-vacia-'));
  const s = qm({ dir: vacia, env: { ...c.env, HOME: vacia, USERPROFILE: vacia, XDG_CACHE_HOME: join(vacia, 'cache') } }, ['--aviso'], {}, '{}');
  assert.equal(s.status, 0);
  assert.equal(s.stdout, '');
});
