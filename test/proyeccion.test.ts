import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proyectar, type Muestra } from '../src/core/proyeccion.ts';

const H = 3600_000;
const AHORA = Date.UTC(2026, 8, 9, 12, 0, 0);

/** Muestras cada `pasoMin` minutos hacia atrás, subiendo a `ritmo` %/hora. */
function rampa(desdePct: number, ritmo: number, cuantas: number, pasoMin = 20): Muestra[] {
  const m: Muestra[] = [];
  for (let i = cuantas - 1; i >= 0; i -= 1) {
    const t = AHORA - i * pasoMin * 60_000;
    m.push({ t, porcentaje: desdePct + ((cuantas - 1 - i) * pasoMin * ritmo) / 60 });
  }
  return m;
}

test('con una rampa clara calcula el ritmo y cuándo toca el techo', () => {
  // 10 %/h desde 50 %: faltan 50 puntos → 5 horas.
  const p = proyectar(rampa(50, 10, 6), 70, null, AHORA);
  assert.equal(p.estado, 'sube');
  if (p.estado !== 'sube') return;
  assert.ok(Math.abs(p.ritmo - 10) < 0.001, `ritmo ${p.ritmo}`);
  assert.equal(p.techo.getTime(), AHORA + 3 * H, 'desde 70 % a 10 %/h son 3 h');
});

test('chocás si el techo llega antes del reinicio', () => {
  const p = proyectar(rampa(50, 20, 6), 80, new Date(AHORA + 3 * H), AHORA);
  assert.equal(p.estado, 'sube');
  if (p.estado !== 'sube') return;
  // 20 puntos a 20 %/h = 1 h, y la ventana se reinicia recién en 3 h.
  assert.equal(p.chocas, true);
});

test('no chocás si la ventana se reinicia antes', () => {
  const p = proyectar(rampa(50, 5, 6), 60, new Date(AHORA + 1 * H), AHORA);
  assert.equal(p.estado, 'sube');
  if (p.estado !== 'sube') return;
  // 40 puntos a 5 %/h = 8 h, y la ventana se vacía en 1 h.
  assert.equal(p.chocas, false);
});

// ─── Cuándo NO hay que dibujar una recta ──────────────────────────────────

test('dos lecturas no alcanzan para proyectar nada', () => {
  const p = proyectar(rampa(50, 10, 2), 60, null, AHORA);
  assert.equal(p.estado, 'sin-datos');
});

test('tres lecturas apretadas en cinco minutos tampoco', () => {
  const p = proyectar(rampa(50, 10, 3, 2), 55, null, AHORA);
  assert.equal(p.estado, 'sin-datos');
  if (p.estado !== 'sin-datos') return;
  assert.match(p.motivo, /10 minutos/);
});

test('lecturas viejas no cuentan: el ritmo de hace 4 h no predice el de ahora', () => {
  const viejas: Muestra[] = [
    { t: AHORA - 5 * H, porcentaje: 10 },
    { t: AHORA - 4.5 * H, porcentaje: 30 },
    { t: AHORA - 4 * H, porcentaje: 50 },
  ];
  assert.equal(proyectar(viejas, 50, null, AHORA).estado, 'sin-datos');
});

test('una barra que no se mueve es plano, no un techo a tres días', () => {
  const quietas: Muestra[] = [
    { t: AHORA - 90 * 60_000, porcentaje: 40 },
    { t: AHORA - 60 * 60_000, porcentaje: 40 },
    { t: AHORA - 30 * 60_000, porcentaje: 40 },
  ];
  assert.equal(proyectar(quietas, 40, null, AHORA).estado, 'plano');
});

test('una barra que baja no proyecta un techo', () => {
  const bajando: Muestra[] = [
    { t: AHORA - 90 * 60_000, porcentaje: 80 },
    { t: AHORA - 60 * 60_000, porcentaje: 50 },
    { t: AHORA - 30 * 60_000, porcentaje: 20 },
  ];
  assert.equal(proyectar(bajando, 20, null, AHORA).estado, 'plano');
});

test('un punto de movimiento es cuantización, no un ritmo', () => {
  // El servidor manda enteros: subir 1 punto en 2 h no se distingue de un
  // redondeo, y extrapolarlo daría un techo inventado.
  const ruido: Muestra[] = [
    { t: AHORA - 120 * 60_000, porcentaje: 40 },
    { t: AHORA - 60 * 60_000, porcentaje: 41 },
    { t: AHORA - 30 * 60_000, porcentaje: 41 },
  ];
  assert.equal(proyectar(ruido, 41, null, AHORA).estado, 'plano');
});

test('dos puntos de movimiento ya son un ritmo', () => {
  const sube: Muestra[] = [
    { t: AHORA - 120 * 60_000, porcentaje: 40 },
    { t: AHORA - 60 * 60_000, porcentaje: 41 },
    { t: AHORA - 30 * 60_000, porcentaje: 42 },
  ];
  assert.equal(proyectar(sube, 42, null, AHORA).estado, 'sube');
});

test('si ya estás en 100 el techo es ahora y chocaste', () => {
  const p = proyectar(rampa(80, 20, 6), 100, new Date(AHORA + 2 * H), AHORA);
  assert.equal(p.estado, 'sube');
  if (p.estado !== 'sube') return;
  assert.equal(p.chocas, true);
  assert.equal(p.techo.getTime(), AHORA);
});
