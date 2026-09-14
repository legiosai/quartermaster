// Cuándo se le pregunta al endpoint por una cuenta, y cuándo no.
//
// Medido el 2026-09-14 con la 0.1.9: la barra de macOS le preguntaba cada ~2
// minutos por las dos cuentas de Claude en uso —la cadencia la marcaba Codex,
// clavado en 100 %— y el endpoint contestó HTTP 429 durante dos horas y media:
// 36 calentados fallidos. Un endpoint no documentado que Claude Code consulta
// del orden de una vez por sesión no es para eso (ver SOUL.md: el piso de 60 s
// era por pedido, no por cuenta, y no alcanzó).
//
// Dos reglas, las dos en el núcleo para que valgan igual en las cuatro
// pantallas:
//   · una cuenta con lectura propia de hace menos de 5 minutos no se vuelve a
//     preguntar — salvo que una ventana se haya reiniciado desde esa lectura;
//   · una cuenta a la que el endpoint le dijo 429 no se pregunta hasta que pase
//     el freno: lo que pida Retry-After, entre 10 minutos y una hora.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decidirConsulta, frenoPor, FRENO_MINIMO_MS, FRENO_MAXIMO_MS } from '../src/core/pedir.ts';

const AHORA = Date.UTC(2026, 8, 14, 15, 0, 0);
const MIN = 60_000;
const hace = (m: number) => new Date(AHORA - m * MIN);
const en = (m: number) => new Date(AHORA + m * MIN);

test('sin lectura propia se pregunta', () => {
  const d = decidirConsulta({ ultimaLectura: null, reinicios: [], frenadoHasta: null }, AHORA);
  assert.deepStrictEqual(d, { consultar: true });
});

test('una lectura de hace 2 minutos no se repite: es el caso del 429', () => {
  const d = decidirConsulta({ ultimaLectura: hace(2), reinicios: [en(120)], frenadoHasta: null }, AHORA);
  assert.deepStrictEqual(d, { consultar: false, porque: 'fresca' });
});

test('una lectura de hace 6 minutos sí', () => {
  const d = decidirConsulta({ ultimaLectura: hace(6), reinicios: [en(120)], frenadoHasta: null }, AHORA);
  assert.deepStrictEqual(d, { consultar: true });
});

test('fresca pero con una ventana reiniciada después: se pregunta', () => {
  // El número es de una ventana que ya cerró, y «te liberaste» es el aviso más útil.
  const d = decidirConsulta({ ultimaLectura: hace(2), reinicios: [hace(1)], frenadoHasta: null }, AHORA);
  assert.deepStrictEqual(d, { consultar: true });
});

test('un reinicio de ANTES de la lectura no la vuelve vieja', () => {
  const d = decidirConsulta({ ultimaLectura: hace(2), reinicios: [hace(30)], frenadoHasta: null }, AHORA);
  assert.deepStrictEqual(d, { consultar: false, porque: 'fresca' });
});

test('frenada por un 429 no se pregunta aunque la lectura sea vieja', () => {
  const hasta = en(7);
  const d = decidirConsulta({ ultimaLectura: hace(90), reinicios: [], frenadoHasta: hasta }, AHORA);
  assert.deepStrictEqual(d, { consultar: false, porque: 'frenada', hasta });
});

test('un freno vencido ya no frena', () => {
  const d = decidirConsulta({ ultimaLectura: hace(90), reinicios: [], frenadoHasta: hace(1) }, AHORA);
  assert.deepStrictEqual(d, { consultar: true });
});

test('sin Retry-After se frena el mínimo', () => {
  assert.strictEqual(frenoPor(null, AHORA).getTime(), AHORA + FRENO_MINIMO_MS);
});

test('Retry-After en segundos, con piso y techo', () => {
  assert.strictEqual(frenoPor('30', AHORA).getTime(), AHORA + FRENO_MINIMO_MS);
  assert.strictEqual(frenoPor('1500', AHORA).getTime(), AHORA + 1500_000);
  assert.strictEqual(frenoPor('7200', AHORA).getTime(), AHORA + FRENO_MAXIMO_MS);
});

test('Retry-After como fecha HTTP', () => {
  const fecha = new Date(AHORA + 20 * MIN).toUTCString();
  assert.strictEqual(frenoPor(fecha, AHORA).getTime(), AHORA + 20 * MIN);
});

test('un Retry-After ilegible no rompe: frena el mínimo', () => {
  assert.strictEqual(frenoPor('mañana', AHORA).getTime(), AHORA + FRENO_MINIMO_MS);
});
