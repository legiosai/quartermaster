import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// El adaptador lee XDG_CACHE_HOME en cada llamada, así que alcanza con
// apuntarlo a un directorio temporal antes de usarlo.
const caja = mkdtempSync(join(tmpdir(), 'qm-hist-'));
process.env['XDG_CACHE_HOME'] = caja;

const { anotar, muestras, claveBarra } = await import('../src/adapters/historial.ts');

test.after(() => rmSync(caja, { recursive: true, force: true }));

const T = new Date('2026-09-09T01:00:00Z');

test('anota una lectura y la devuelve', () => {
  assert.equal(anotar([{ perfil: 'p', barra: 'session', medidoEn: T, porcentaje: 40 }]), 1);
  assert.deepEqual(muestras('p', 'session'), [{ t: T.getTime(), porcentaje: 40 }]);
});

// Lo que hace o rompe la proyección: qm corre cada minuto, pero el cache que
// lee sólo cambia cuando Claude Code lo refresca. Si cada corrida dejara una
// muestra, la serie se llenaría de puntos idénticos y el ritmo saldría plano
// justo cuando más subís.
test('leer diez veces el mismo cache deja UNA muestra', () => {
  for (let i = 0; i < 10; i += 1) {
    anotar([{ perfil: 'q', barra: 'session', medidoEn: T, porcentaje: 40 }]);
  }
  assert.equal(muestras('q', 'session').length, 1);
});

test('un medidoEn distinto sí es una muestra nueva', () => {
  const despues = new Date(T.getTime() + 600_000);
  anotar([{ perfil: 'r', barra: 'session', medidoEn: T, porcentaje: 40 }]);
  anotar([{ perfil: 'r', barra: 'session', medidoEn: despues, porcentaje: 55 }]);
  assert.deepEqual(
    muestras('r', 'session').map((m) => m.porcentaje),
    [40, 55],
  );
});

test('las barras y los perfiles no se mezclan', () => {
  anotar([
    { perfil: 'a', barra: 'session', medidoEn: T, porcentaje: 10 },
    { perfil: 'a', barra: 'weekly_all', medidoEn: T, porcentaje: 90 },
    { perfil: 'b', barra: 'session', medidoEn: T, porcentaje: 50 },
  ]);
  assert.deepEqual(muestras('a', 'session'), [{ t: T.getTime(), porcentaje: 10 }]);
  assert.deepEqual(muestras('a', 'weekly_all'), [{ t: T.getTime(), porcentaje: 90 }]);
  assert.deepEqual(muestras('b', 'session'), [{ t: T.getTime(), porcentaje: 50 }]);
});

test('el alcance forma parte de la identidad de la barra', () => {
  // weekly_scoped de un modelo y de otro son barras distintas y no pueden
  // compartir serie: mezclarlas inventa un ritmo que nadie tuvo.
  assert.notEqual(claveBarra('weekly_scoped', 'Fable'), claveBarra('weekly_scoped', 'Opus'));
  assert.equal(claveBarra('session', null), 'session');
});

test('las muestras salen ordenadas aunque se anoten al revés', () => {
  const t2 = new Date(T.getTime() + 1_200_000);
  anotar([{ perfil: 'z', barra: 's', medidoEn: t2, porcentaje: 70 }]);
  anotar([{ perfil: 'z', barra: 's', medidoEn: T, porcentaje: 30 }]);
  assert.deepEqual(
    muestras('z', 's').map((m) => m.porcentaje),
    [30, 70],
  );
});

test('un archivo con una línea cortada no invalida el resto', async () => {
  const { appendFileSync } = await import('node:fs');
  const { rutaHistorial } = await import('../src/adapters/historial.ts');
  anotar([{ perfil: 'corte', barra: 's', medidoEn: T, porcentaje: 11 }]);
  appendFileSync(rutaHistorial(), '{"p":"corte","b":"s","t":\n');
  assert.deepEqual(muestras('corte', 's'), [{ t: T.getTime(), porcentaje: 11 }]);
});
