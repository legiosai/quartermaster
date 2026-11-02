// La salida de qm llega entera aunque el pipe sea chico.
//
// Linux le da 8 KB a cada pipe nuevo cuando el usuario ya tiene muchos abiertos
// (fs.pipe-user-pages-soft), y `process.exit()` tiraba lo que no había entrado:
// `qm --json` salía cortado y el indicador de GNOME anotaba «qm no devolvió
// JSON». El test achica el pipe a propósito —el lector lo pone en 4 KB con
// F_SETPIPE_SZ y tarda en leer— para que el corte pase siempre, no sólo en una
// máquina cargada. Los pipes de child_process son sockets, así que va por sh.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const RAIZ = new URL('..', import.meta.url).pathname;

// El lector: achica su pipe a 4096 (F_SETPIPE_SZ = 1031), espera, y cuenta.
const LECTOR = 'import fcntl,sys,time; fcntl.fcntl(0, 1031, 4096); time.sleep(0.5); print(len(sys.stdin.buffer.read()))';

function casaConVariasCuentas(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'qm-salida-casa-'));
  const ahora = Date.now();
  const lecturas: Record<string, unknown> = {};
  for (const nombre of ['.claude', '.claude-a', '.claude-b', '.claude-c']) {
    mkdirSync(join(dir, nombre));
    writeFileSync(join(nombre === '.claude' ? dir : join(dir, nombre), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: `${nombre.slice(1)}@ejemplo.com` } }));
    lecturas[nombre] = {
      medidoEn: new Date(ahora).toISOString(),
      ventanas: [
        { clave: 'session', grupo: 'session', alcance: null, porcentaje: 30, severidad: 'normal', activa: true, reinicia: new Date(ahora + 3_600_000).toISOString() },
        { clave: 'weekly_all', grupo: 'weekly', alcance: null, porcentaje: 40, severidad: 'normal', activa: false, reinicia: new Date(ahora + 86_400_000).toISOString() },
      ],
    };
  }
  mkdirSync(join(dir, '.cache', 'quartermaster'), { recursive: true });
  writeFileSync(join(dir, '.cache', 'quartermaster', 'statusline.json'), JSON.stringify(lecturas));
  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  return {
    ...env,
    HOME: dir,
    XDG_CACHE_HOME: join(dir, '.cache'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    NO_COLOR: '1',
    QM_IDIOMA: 'es',
  };
}

test('qm --json sale entero por un pipe de 4 KB', { skip: process.platform !== 'linux' }, () => {
  const env = casaConVariasCuentas();
  const qm = `"${process.execPath}" --experimental-strip-types --no-warnings "${join(RAIZ, 'src', 'cli', 'qm.ts')}" --json --breve --sin-codex --sin-antigravity`;
  const completo = execFileSync('sh', ['-c', `${qm} > "$HOME/salida.json"; wc -c < "$HOME/salida.json"`], { env, encoding: 'utf8' });
  const total = Number(completo.trim());
  assert.ok(total > 8192, `el JSON tiene que pasar los 8 KB para que el test diga algo (tiene ${total})`);
  const porPipe = execFileSync('sh', ['-c', `${qm} | python3 -c '${LECTOR}'`], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(Number(porPipe.trim()), total, 'por el pipe tiene que llegar lo mismo que al archivo');
});
