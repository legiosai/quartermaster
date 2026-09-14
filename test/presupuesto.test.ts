import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presupuestoDiario, frasePresupuesto, gastadoDesdeMedianoche } from '../src/core/presupuesto.ts';
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

// ─── «hoy te queda» prometía una resta que no ocurría ─────────────────────
//
// `quedaHoy` es el reparto a ritmo parejo de las horas que faltan del día. La
// frase decía «hoy te queda X %», que se lee como «de la cuota de hoy queda X».
// No son lo mismo: con la cuota QUIETA el número bajaba de 10,5 a 0,5 a lo
// largo del día sin que nadie gastara nada. Multiplicar por horasHoy/24
// descuenta el rato que ya pasó como si se hubiera gastado, encima de lo que ya
// está reflejado en el porcentaje.

const RESET = new Date('2026-09-20T12:00:00Z');
const semanalDe = (pct: number) => [{
  clave: 'weekly_all', porcentaje: pct, reinicia: RESET,
  severidad: 'normal', activa: true, alcance: null, grupo: 'weekly',
}];
// En hora LOCAL, como AHORA. Iba con `-03:00` fijo y el código corta el día en
// la medianoche local: en Buenos Aires coincidían, en el runner de CI (UTC) la
// primera lectura caía a las 03:00 y gastadoHoy daba null. Tres tests rojos en
// CI y verdes en la máquina de quien los escribió.
const HORA = (h: number) => new Date(2026, 8, 13, h, 0, 0).getTime();

test('sin gastar nada, lo que queda hoy NO baja con el reloj', () => {
  const quieto = [0, 3, 6, 9, 12].map((h) => ({ t: HORA(h), porcentaje: 20 }));
  const manana = presupuestoDiario(semanalDe(20), HORA(6), quieto);
  const noche = presupuestoDiario(semanalDe(20), HORA(12), quieto);
  assert.equal(manana.estado, 'ok');
  assert.equal(noche.estado, 'ok');
  if (manana.estado !== 'ok' || noche.estado !== 'ok') return;
  assert.equal(manana.gastadoHoy, 0);
  assert.equal(noche.gastadoHoy, 0);
  // Lo que queda sigue al presupuesto del día, no a la hora que es.
  assert.equal(manana.restanteHoy, manana.porDia);
  assert.equal(noche.restanteHoy, noche.porDia);
  // Y el viejo `quedaHoy` sigue existiendo, pero se desploma: por eso no se
  // muestra más con esa frase.
  assert.ok(noche.quedaHoy < manana.quedaHoy);
});

test('un reinicio en medio del día no da consumo negativo', () => {
  // El caso real del 2026-09-13: una semanal de 84 % a 6 % en pocas horas.
  // Restar la última menos la primera daría -78 puntos.
  const conReinicio = [
    { t: HORA(0), porcentaje: 84 }, { t: HORA(2), porcentaje: 88 },
    { t: HORA(4), porcentaje: 2 }, { t: HORA(8), porcentaje: 6 },
  ];
  assert.equal(gastadoDesdeMedianoche(conReinicio, HORA(9)), 8);
});

test('sin historial que cubra el arranque del día, gastadoHoy es null', () => {
  // Primera lectura a las 03:10 y nada de ayer: entre la medianoche y esa hora
  // no se sabe qué pasó, y suponer que no pasó nada es inventar.
  const hueco = [{ t: HORA(3) + 600_000, porcentaje: 20 }, { t: HORA(8), porcentaje: 24 }];
  assert.equal(gastadoDesdeMedianoche(hueco, HORA(9)), null);
  const p = presupuestoDiario(semanalDe(24), HORA(9), hueco);
  assert.equal(p.estado, 'ok');
  if (p.estado !== 'ok') return;
  assert.equal(p.gastadoHoy, null);
  assert.equal(p.restanteHoy, null);
  // Y la frase cae al modo honesto, sin prometer una resta.
  assert.match(frasePresupuesto(p), /de acá a medianoche/);
  assert.doesNotMatch(frasePresupuesto(p), /te queda/);
});

test('gastando de más, lo que queda es cero y no negativo', () => {
  const gasta = [
    { t: HORA(0), porcentaje: 10 }, { t: HORA(3), porcentaje: 15 },
    { t: HORA(6), porcentaje: 22 }, { t: HORA(9), porcentaje: 30 },
  ];
  const p = presupuestoDiario(semanalDe(30), HORA(9), gasta);
  assert.equal(p.estado, 'ok');
  if (p.estado !== 'ok') return;
  assert.equal(p.gastadoHoy, 20);
  assert.equal(p.restanteHoy, 0);
  assert.match(frasePresupuesto(p), /gastaste 20\.0 % hoy · te queda 0\.0 %/);
});
