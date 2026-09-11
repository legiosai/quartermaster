import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presupuestoDiario } from '../src/core/presupuesto.ts';
import type { VentanaCuota } from '../src/core/tipos.ts';

const H = 3600_000;
/** Mediodía local, para que «lo que queda del día» sean 12 h en cualquier zona. */
const AHORA = new Date(2026, 8, 9, 12, 0, 0).getTime();

function v(p: Partial<VentanaCuota> & { porcentaje: number }): VentanaCuota {
  return {
    clave: 'weekly_all',
    reinicia: new Date(AHORA + 48 * H),
    severidad: 'normal',
    activa: false,
    alcance: null,
    grupo: 'weekly',
    ...p,
  };
}

test('reparte lo que queda entre los días que faltan', () => {
  // 40 puntos libres y 2 días exactos: 20 por día.
  const r = presupuestoDiario([v({ porcentaje: 60 })], AHORA);
  assert.equal(r.estado, 'ok');
  if (r.estado !== 'ok') return;
  assert.ok(Math.abs(r.porDia - 20) < 1e-9, `porDia ${r.porDia}`);
  // Medio día por delante: la mitad del presupuesto del día.
  assert.ok(Math.abs(r.quedaHoy - 10) < 1e-9, `quedaHoy ${r.quedaHoy}`);
});

test('reparte la ventana larga y no la que frena', () => {
  // La sesión está más alta y se reinicia antes: es la que frena, y NO es la
  // que se reparte — «cuánto por día» en una ventana de 5 h no quiere decir nada.
  const r = presupuestoDiario(
    [
      v({ clave: 'session', grupo: 'session', porcentaje: 90, reinicia: new Date(AHORA + 3 * H) }),
      v({ porcentaje: 50 }),
    ],
    AHORA,
  );
  assert.equal(r.estado, 'ok');
  if (r.estado !== 'ok') return;
  assert.equal(r.ventana.clave, 'weekly_all');
  assert.ok(Math.abs(r.porDia - 25) < 1e-9, `porDia ${r.porDia}`);
});

test('con dos semanales se reparte la que frena antes', () => {
  const r = presupuestoDiario(
    [v({ porcentaje: 40 }), v({ clave: 'weekly_scoped', alcance: 'Fable', porcentaje: 88 })],
    AHORA,
  );
  assert.equal(r.estado, 'ok');
  if (r.estado !== 'ok') return;
  assert.equal(r.ventana.alcance, 'Fable', 'la más alta es la que manda');
  assert.ok(Math.abs(r.porDia - 6) < 1e-9, `porDia ${r.porDia}`);
});

test('al 100 % el presupuesto es cero y no un número negativo', () => {
  const r = presupuestoDiario([v({ porcentaje: 100 })], AHORA);
  assert.equal(r.estado, 'ok');
  if (r.estado !== 'ok') return;
  assert.equal(r.porDia, 0);
  assert.equal(r.quedaHoy, 0);
});

test('sin ventana larga hay frase y no un número inventado', () => {
  const r = presupuestoDiario(
    [v({ clave: 'session', grupo: 'session', porcentaje: 30, reinicia: new Date(AHORA + 3 * H) })],
    AHORA,
  );
  assert.equal(r.estado, 'sin-datos');
  if (r.estado !== 'sin-datos') return;
  assert.match(r.motivo, /ventana larga/);
});

test('una ventana sin reinicio no se reparte', () => {
  const r = presupuestoDiario([v({ porcentaje: 50, reinicia: null })], AHORA);
  assert.equal(r.estado, 'sin-datos');
});

test('una ventana ya reiniciada lo dice en vez de dividir por un negativo', () => {
  const r = presupuestoDiario([v({ porcentaje: 50, reinicia: new Date(AHORA - H) })], AHORA);
  assert.equal(r.estado, 'sin-datos');
  if (r.estado !== 'sin-datos') return;
  assert.match(r.motivo, /ya se reinició/);
});

test('a menos de una hora del reinicio no se extrapola un %/día absurdo', () => {
  // 4 puntos en 20 minutos serían «288 %/día»: cierto y de nada sirve.
  const r = presupuestoDiario([v({ porcentaje: 96, reinicia: new Date(AHORA + 20 * 60_000) })], AHORA);
  assert.equal(r.estado, 'sin-datos');
  if (r.estado !== 'sin-datos') return;
  assert.match(r.motivo, /menos de una hora/);
});

test('lo de hoy se corta en el reinicio cuando el reinicio llega antes que la medianoche', () => {
  // Son las 12 y la ventana se reinicia a las 16: quedan 4 h de «hoy», no 12.
  const r = presupuestoDiario([v({ porcentaje: 50, reinicia: new Date(AHORA + 4 * H) })], AHORA);
  assert.equal(r.estado, 'ok');
  if (r.estado !== 'ok') return;
  assert.ok(Math.abs(r.horasHoy - 4) < 1e-9, `horasHoy ${r.horasHoy}`);
  // Y ahí «lo que queda hoy» es todo lo que queda: no hay un día después.
  assert.ok(Math.abs(r.quedaHoy - r.restante) < 1e-9, `quedaHoy ${r.quedaHoy}`);
});

test('el presupuesto de hoy nunca es más que lo que queda en la ventana', () => {
  for (const pct of [0, 17, 50, 83, 99]) {
    for (const h of [1.5, 6, 25, 70, 168]) {
      const r = presupuestoDiario([v({ porcentaje: pct, reinicia: new Date(AHORA + h * H) })], AHORA);
      if (r.estado !== 'ok') continue;
      assert.ok(r.quedaHoy <= r.restante + 1e-9, `${pct} % a ${h} h: ${r.quedaHoy} > ${r.restante}`);
      assert.ok(r.quedaHoy >= 0);
    }
  }
});
