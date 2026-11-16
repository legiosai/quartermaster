// Una sola carpeta de cache para todo el programa, la que dice XDG_CACHE_HOME.
//
// Antes la mitad de los archivos la respetaba y la otra mitad escribía en
// ~/.cache a mano: con la variable puesta, el cache quedaba partido y el
// diagnóstico buscaba el latido de la extensión donde no estaba.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env['QM_IDIOMA'] = 'es';
const casa = mkdtempSync(join(tmpdir(), 'qm-xdg-'));
const xdg = join(casa, 'xdg-cache');
process.env['HOME'] = casa;
process.env['USERPROFILE'] = casa;
process.env['XDG_CACHE_HOME'] = xdg;

const dir = await import('../src/adapters/directorio-cache.ts');
const endpoint = await import('../src/adapters/cache-endpoint.ts');
const statusline = await import('../src/adapters/statusline.ts');
const entorno = await import('../src/adapters/entorno.ts');

const VIEJA = join(casa, '.cache', 'quartermaster');
const NUEVA = join(xdg, 'quartermaster');

test('la carpeta es la de XDG_CACHE_HOME, y sin la variable la de siempre', () => {
  assert.equal(dir.directorioCache(), NUEVA);
  const antes = process.env['XDG_CACHE_HOME'];
  delete process.env['XDG_CACHE_HOME'];
  try {
    assert.equal(dir.directorioCache(), VIEJA);
  } finally {
    process.env['XDG_CACHE_HOME'] = antes;
  }
});

test('actualizar no pierde la última lectura: se lee la carpeta vieja hasta la primera escritura', () => {
  mkdirSync(VIEJA, { recursive: true });
  writeFileSync(join(VIEJA, 'endpoint.json'), JSON.stringify({
    '.claude': { medidoEn: '2026-11-16T10:00:00.000Z', ventanas: [] },
    '.claude-trabajo': { medidoEn: '2026-11-16T09:00:00.000Z', ventanas: [] },
  }));
  const leida = endpoint.endpointEnCache('.claude');
  assert.ok(leida !== null && leida.estado === 'ok', 'la lectura vieja tiene que seguir apareciendo');
  assert.equal(leida.medidoEn.toISOString(), '2026-11-16T10:00:00.000Z');

  // La primera escritura va a la carpeta nueva, y se lleva lo que había.
  endpoint.guardarEndpoint('.claude', { estado: 'ok', origen: 'endpoint', medidoEn: new Date('2026-11-16T11:00:00Z'), ventanas: [] });
  assert.ok(existsSync(join(NUEVA, 'endpoint.json')));
  assert.equal(endpoint.endpointEnCache('.claude')?.estado, 'ok');
  const otra = endpoint.endpointEnCache('.claude-trabajo');
  assert.ok(otra !== null && otra.estado === 'ok', 'el otro perfil de la carpeta vieja no se pierde en la mudanza');
  assert.equal(otra.medidoEn.toISOString(), '2026-11-16T09:00:00.000Z');
});

test('la statusline escribe en la carpeta de XDG', () => {
  const entrada = { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_800_000_000 } } };
  assert.equal(statusline.guardarStatusline('.claude', entrada), true);
  assert.ok(existsSync(join(NUEVA, 'statusline.json')));
  assert.ok(!existsSync(join(VIEJA, 'statusline.json')));
});

test('el diagnóstico encuentra el latido donde lo escribe GLib, y lista las dos carpetas', () => {
  mkdirSync(NUEVA, { recursive: true });
  writeFileSync(join(NUEVA, 'extension-viva'), '');
  const carpetas = entorno.cache();
  assert.equal(carpetas[0]!.ruta, '~/xdg-cache/quartermaster');
  assert.ok(carpetas[0]!.archivos.some((a) => a.nombre === 'extension-viva'));
  assert.ok(carpetas.some((c) => c.ruta === '~/.cache/quartermaster' && c.nota !== null), 'la vieja sale, con su nota');
});
