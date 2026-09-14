// «te queda X %» restaba lo gastado de un presupuesto que ya lo había descontado.
//
// Visto el 2026-09-14 en el menú de la barra: «podés gastar 14.3 %/día ·
// gastaste 14.0 % desde las 09:27 · te queda 0.3 %». `porDia` se calcula con el
// porcentaje de AHORA, que ya tiene adentro esos 14 puntos; restárselos otra vez
// cuenta cada punto dos veces. El presupuesto de hoy es el que había cuando
// arrancó la medición: a las 09:27 la semanal iba 9 % con 135,5 h al reinicio,
// o sea 91 / 5,65 = 16,1 %/día, y lo que queda es 16,1 − 14,0 = 2,1 %.
//
// El caso que lo delata: gastar EXACTAMENTE el presupuesto del día tiene que
// dejar cero, y con la cuenta vieja te declaraba pasado.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presupuestoDiario, frasePresupuesto } from '../src/core/presupuesto.ts';
import type { VentanaCuota } from '../src/core/tipos.ts';

const H = 3600_000;
const MIN = 60_000;
/** Hora local, como el resto de los tests del presupuesto. */
const A = (h: number, m = 0) => new Date(2026, 8, 14, h, m, 0).getTime();
const semanal = (pct: number, reinicia: Date): VentanaCuota[] => [{
  clave: 'weekly_all', porcentaje: pct, reinicia,
  severidad: 'normal', activa: true, alcance: null, grupo: 'weekly',
}];
const cerca = (real: number | null | undefined, esperado: number, tol = 0.05) =>
  assert.ok(real !== null && real !== undefined && Math.abs(real - esperado) <= tol,
    `esperaba ${esperado} ± ${tol} y dio ${real}`);

test('el caso de la captura: te queda 2.1 %, no 0.3 %', () => {
  const ahora = A(15, 32);
  const reinicia = new Date(ahora + 129.4 * H);
  const lecturas = [
    { t: A(9, 27), porcentaje: 9 },
    { t: A(12), porcentaje: 15 },
    { t: ahora, porcentaje: 23 },
  ];
  const p = presupuestoDiario(semanal(23, reinicia), ahora, lecturas);
  assert.equal(p.estado, 'ok');
  if (p.estado !== 'ok') return;
  const alArrancar = 91 / ((reinicia.getTime() - A(9, 27)) / H / 24);
  cerca(p.porDiaHoy, alArrancar);
  cerca(p.restanteMedido, alArrancar - 14);
  cerca(p.restanteMedido, 2.1, 0.06);
  // `porDia` sigue siendo el de ahora en adelante: es otra pregunta.
  cerca(p.porDia, 77 / (129.4 / 24));
  assert.match(frasePresupuesto(p), /podés gastar 16\.1 %\/día · gastaste 14\.0 % desde las 09:27 · te queda 2\.1 %/);
});

test('gastar exactamente el presupuesto del día deja cero, no te declara pasado', () => {
  const reinicia = new Date(A(0) + 5 * 24 * H);
  const presupuesto = 90 / 5; // 10 % a medianoche, 5 días justos: 18 %/día
  const lecturas = [{ t: A(0), porcentaje: 10 }, { t: A(9), porcentaje: 10 + presupuesto }];
  const p = presupuestoDiario(semanal(10 + presupuesto, reinicia), A(9), lecturas);
  assert.equal(p.estado, 'ok');
  if (p.estado !== 'ok') return;
  cerca(p.porDiaHoy, presupuesto);
  cerca(p.restanteHoy, 0);
  // Y gastar la mitad deja la mitad: la cuenta vieja daba menos.
  const mitad = [{ t: A(0), porcentaje: 10 }, { t: A(9), porcentaje: 10 + presupuesto / 2 }];
  const q = presupuestoDiario(semanal(10 + presupuesto / 2, reinicia), A(9), mitad);
  assert.equal(q.estado, 'ok');
  if (q.estado !== 'ok') return;
  cerca(q.restanteHoy, presupuesto / 2);
  cerca(q.restanteMedido, presupuesto / 2);
});

test('sin gastar, lo que queda es el presupuesto entero a cualquier hora', () => {
  const reinicia = new Date(A(0) + 4 * 24 * H);
  const quieto = [0, 3, 6, 9, 12, 20].map((h) => ({ t: A(h), porcentaje: 20 }));
  const manana = presupuestoDiario(semanal(20, reinicia), A(6), quieto);
  const noche = presupuestoDiario(semanal(20, reinicia), A(20), quieto);
  assert.equal(manana.estado, 'ok');
  assert.equal(noche.estado, 'ok');
  if (manana.estado !== 'ok' || noche.estado !== 'ok') return;
  cerca(manana.restanteHoy, 20);
  cerca(noche.restanteHoy, 20);
});

test('con la ventana reiniciada en el medio, el presupuesto arranca en el reinicio', () => {
  // 84 → 88, se reinicia a las 04:00 (2 %) y sube a 6. El presupuesto de hoy es
  // el de la ventana nueva, contado desde su primera lectura, y lo gastado de
  // esa ventana son 4 puntos: lo de antes del reinicio era de otra cuota.
  const reinicia = new Date(A(4) + 7 * 24 * H);
  const lecturas = [
    { t: A(0), porcentaje: 84 }, { t: A(2), porcentaje: 88 },
    { t: A(4), porcentaje: 2 }, { t: A(8), porcentaje: 6 },
  ];
  const p = presupuestoDiario(semanal(6, reinicia), A(9), lecturas);
  assert.equal(p.estado, 'ok');
  if (p.estado !== 'ok') return;
  cerca(p.porDiaHoy, 98 / 7);
  cerca(p.restanteMedido, 98 / 7 - 4);
});

test('sin medición no hay ancla: porDiaHoy es porDia y no hay restante', () => {
  const reinicia = new Date(A(9) + 3 * 24 * H);
  const p = presupuestoDiario(semanal(40, reinicia), A(9), [{ t: A(8), porcentaje: 40 }]);
  assert.equal(p.estado, 'ok');
  if (p.estado !== 'ok') return;
  assert.equal(p.porDiaHoy, p.porDia);
  assert.equal(p.restanteMedido, null);
  void MIN;
});
