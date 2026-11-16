import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Estos tests leen las frases en castellano. El idioma sale del locale, y el
// de CI es C.UTF-8 (inglés): se fija acá. Lo que es del inglés vive en idioma.test.ts.
process.env['QM_IDIOMA'] = 'es';

// El adaptador lee XDG_CACHE_HOME en cada llamada, así que alcanza con
// apuntarlo a un directorio temporal antes de usarlo.
const caja = mkdtempSync(join(tmpdir(), 'qm-hist-'));
process.env['XDG_CACHE_HOME'] = caja;

const { anotar, muestras, claveBarra } = await import('../src/adapters/historial.ts');

test.after(() => rmSync(caja, { recursive: true, force: true }));

const T = new Date('2026-09-09T01:00:00Z');

test('anota una lectura y la devuelve', () => {
  assert.equal(anotar([{ perfil: 'p', barra: 'session', medidoEn: T, porcentaje: 40, origen: 'endpoint' }]), 1);
  assert.deepEqual(muestras('p', 'session', 'endpoint'), [{ t: T.getTime(), porcentaje: 40 }]);
});

// Lo que hace o rompe la proyección: qm corre cada minuto, pero el cache que
// lee sólo cambia cuando Claude Code lo refresca. Si cada corrida dejara una
// muestra, la serie se llenaría de puntos idénticos y el ritmo saldría plano
// justo cuando más subís.
test('leer diez veces el mismo cache deja UNA muestra', () => {
  for (let i = 0; i < 10; i += 1) {
    anotar([{ perfil: 'q', barra: 'session', medidoEn: T, porcentaje: 40, origen: 'endpoint' }]);
  }
  assert.equal(muestras('q', 'session', 'endpoint').length, 1);
});

test('un medidoEn distinto sí es una muestra nueva', () => {
  const despues = new Date(T.getTime() + 600_000);
  anotar([{ perfil: 'r', barra: 'session', medidoEn: T, porcentaje: 40, origen: 'endpoint' }]);
  anotar([{ perfil: 'r', barra: 'session', medidoEn: despues, porcentaje: 55, origen: 'endpoint' }]);
  assert.deepEqual(
    muestras('r', 'session', 'endpoint').map((m) => m.porcentaje),
    [40, 55],
  );
});

test('las barras y los perfiles no se mezclan', () => {
  anotar([
    { perfil: 'a', barra: 'session', medidoEn: T, porcentaje: 10, origen: 'endpoint' },
    { perfil: 'a', barra: 'weekly_all', medidoEn: T, porcentaje: 90, origen: 'endpoint' },
    { perfil: 'b', barra: 'session', medidoEn: T, porcentaje: 50, origen: 'endpoint' },
  ]);
  assert.deepEqual(muestras('a', 'session', 'endpoint'), [{ t: T.getTime(), porcentaje: 10 }]);
  assert.deepEqual(muestras('a', 'weekly_all', 'endpoint'), [{ t: T.getTime(), porcentaje: 90 }]);
  assert.deepEqual(muestras('b', 'session', 'endpoint'), [{ t: T.getTime(), porcentaje: 50 }]);
});

test('el alcance forma parte de la identidad de la barra', () => {
  // weekly_scoped de un modelo y de otro son barras distintas y no pueden
  // compartir serie: mezclarlas inventa un ritmo que nadie tuvo.
  assert.notEqual(claveBarra('weekly_scoped', 'Fable'), claveBarra('weekly_scoped', 'Opus'));
  assert.equal(claveBarra('session', null), 'session');
});

test('las muestras salen ordenadas aunque se anoten al revés', () => {
  const t2 = new Date(T.getTime() + 1_200_000);
  anotar([{ perfil: 'z', barra: 's', medidoEn: t2, porcentaje: 70, origen: 'endpoint' }]);
  anotar([{ perfil: 'z', barra: 's', medidoEn: T, porcentaje: 30, origen: 'endpoint' }]);
  assert.deepEqual(
    muestras('z', 's', 'endpoint').map((m) => m.porcentaje),
    [30, 70],
  );
});

test('un archivo con una línea cortada no invalida el resto', async () => {
  const { appendFileSync } = await import('node:fs');
  const { rutaHistorial } = await import('../src/adapters/historial.ts');
  anotar([{ perfil: 'corte', barra: 's', medidoEn: T, porcentaje: 11, origen: 'endpoint' }]);
  appendFileSync(rutaHistorial(), '{"p":"corte","b":"s","t":\n');
  assert.deepEqual(muestras('corte', 's', 'endpoint'), [{ t: T.getTime(), porcentaje: 11 }]);
});

// El caso que lo motivó, medido en una cuenta Team el 2026-11-16: la semanal
// decía 16 % por el endpoint y 4 % por la statusline, la misma ventana. La
// barra que se muestra alterna entre las dos lecturas según cuál sea más nueva,
// y anotadas en la misma serie eran un serrucho: el presupuesto sumaba cada
// vuelta al 16 como gasto y llegó a «gastaste 802 % hoy».
test('dos instrumentos que no coinciden no comparten serie', async () => {
  const { subidaDeHoy } = await import('../src/core/presupuesto.ts');
  const base = new Date(2026, 10, 16, 0, 1).getTime();
  const lecturas = [];
  for (let i = 0; i < 40; i += 1) {
    const t = base + i * 5 * 60_000;
    lecturas.push({ perfil: 'team', barra: 'weekly_all', medidoEn: new Date(t), porcentaje: 4, origen: 'statusline' });
    lecturas.push({ perfil: 'team', barra: 'weekly_all', medidoEn: new Date(t + 60_000), porcentaje: 16, origen: 'endpoint' });
  }
  anotar(lecturas);
  const ahora = base + 40 * 5 * 60_000;

  const delEndpoint = muestras('team', 'weekly_all', 'endpoint');
  const deLaStatusline = muestras('team', 'weekly_all', 'statusline');
  assert.ok(delEndpoint.every((m) => m.porcentaje === 16));
  assert.ok(deLaStatusline.every((m) => m.porcentaje === 4));
  assert.equal(subidaDeHoy(delEndpoint, ahora)?.puntos, 0, 'una semanal quieta en 16 no gastó nada');
  assert.equal(subidaDeHoy(deLaStatusline, ahora)?.puntos, 0);

  // El serrucho, para que se vea qué se arregla: mezcladas, 40 vueltas × 12 puntos.
  const mezcla = [...delEndpoint, ...deLaStatusline].sort((a, b) => a.t - b.t);
  assert.equal(subidaDeHoy(mezcla, ahora)?.puntos, 40 * 12);
});

test('las líneas de antes, sin origen, no entran en ninguna serie', async () => {
  const { appendFileSync } = await import('node:fs');
  const { rutaHistorial } = await import('../src/adapters/historial.ts');
  appendFileSync(rutaHistorial(), `${JSON.stringify({ p: 'vieja', b: 's', t: T.getTime(), v: 50 })}\n`);
  assert.deepEqual(muestras('vieja', 's', 'endpoint'), []);
  assert.deepEqual(muestras('vieja', 's', 'statusline'), []);
});
