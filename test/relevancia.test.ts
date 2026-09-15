// Qué cuenta importa ahora: una dormida baja, pero no desaparece.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIAS_DORMIDA, elQueFrena, ordenarPorRelevancia, relevancia, type Señales } from '../src/core/relevancia.ts';

const AHORA = new Date('2026-09-14T21:00:00Z');
const haceDias = (d: number) => new Date(AHORA.getTime() - d * 86_400_000);

const señales = (s: Partial<Señales>): Señales => ({
  plan: null,
  ultimoUso: null,
  requests: null,
  ventanaDias: 7,
  credencialVencida: false,
  ...s,
});

// ── el caso que originó todo ────────────────────────────────────────────

test('el Codex free sin usar hace semanas queda dormido', () => {
  const r = relevancia(señales({ plan: 'free', requests: 0 }), DIAS_DORMIDA, AHORA);
  assert.strictEqual(r.dormida, true);
  assert.deepStrictEqual(r.porque, ['0 requests en 7 días', 'plan free']);
});

test('la cuenta paga que estás usando no se mueve, aunque esté en 100 %', () => {
  // El nivel NO entra en esta decisión, a propósito: una cuenta agotada que sí
  // usás es justo la que hay que señalar.
  const r = relevancia(
    señales({ plan: 'team_tier_1', ultimoUso: haceDias(0), requests: 173 }),
    DIAS_DORMIDA,
    AHORA,
  );
  assert.strictEqual(r.dormida, false);
});

// ── el falso positivo que haría daño ────────────────────────────────────

test('una cuenta PAGA sin usar hace un mes NO se duerme', () => {
  // Es la que estás esperando que se libere. Bajarla sería el choque contra el
  // límite que el programa promete evitar.
  const r = relevancia(señales({ plan: 'max', ultimoUso: haceDias(30), requests: 0 }), DIAS_DORMIDA, AHORA);
  assert.strictEqual(r.dormida, false);
});

test('una ventana más corta que el corte no alcanza como evidencia', () => {
  // `qm --dias=1` mide un día. Cero requests ahí quiere decir «hoy todavía no»,
  // no «abandonada»: mandarla al fondo sería un falso positivo diario.
  const r = relevancia(señales({ plan: 'free', requests: 0, ventanaDias: 1 }), DIAS_DORMIDA, AHORA);
  assert.strictEqual(r.dormida, false);
});

test('sin medición local NO se asume que no se usa', () => {
  // En --breve `requests` llega en null. Tomarlo por cero mandaría todas las
  // cuentas al fondo cada vez que la barra sondea.
  const r = relevancia(señales({ plan: 'free', requests: null }), DIAS_DORMIDA, AHORA);
  assert.strictEqual(r.dormida, false);
});

test('haberla usado gana sobre cualquier otra señal', () => {
  const r = relevancia(
    señales({ plan: 'free', ultimoUso: haceDias(40), requests: 5, credencialVencida: true }),
    DIAS_DORMIDA,
    AHORA,
  );
  assert.strictEqual(r.dormida, false);
});

// ── los bordes del corte ────────────────────────────────────────────────

test('justo en el día del corte ya cuenta como dormida', () => {
  assert.strictEqual(relevancia(señales({ plan: 'free', ultimoUso: haceDias(7) }), 7, AHORA).dormida, true);
  assert.strictEqual(relevancia(señales({ plan: 'free', ultimoUso: haceDias(6) }), 7, AHORA).dormida, false);
});

test('una credencial vencida también es «nada en juego», aunque el plan sea pago', () => {
  const r = relevancia(
    señales({ plan: 'team_tier_1', ultimoUso: haceDias(20), credencialVencida: true }),
    DIAS_DORMIDA,
    AHORA,
  );
  assert.strictEqual(r.dormida, true);
  assert.ok(r.porque.includes('credencial vencida'));
});

// ── el orden ────────────────────────────────────────────────────────────

const fila = (nombre: string, dormida: boolean) => ({ nombre, dormida });
const nombres = (xs: { nombre: string }[]) => xs.map((x) => x.nombre);

test('las dormidas van al final y NINGUNA se pierde', () => {
  const filas = [fila('codex', true), fila('main', false), fila('vieja', true), fila('teams', false)];
  const r = ordenarPorRelevancia(filas, (f) => ({ dormida: f.dormida, porque: [] }));
  assert.deepStrictEqual(nombres(r), ['main', 'teams', 'codex', 'vieja']);
  assert.strictEqual(r.length, filas.length);
});

test('entre las despiertas el orden de descubrimiento no se toca', () => {
  const filas = [fila('main', false), fila('personal', false), fila('teams', false)];
  const r = ordenarPorRelevancia(filas, (f) => ({ dormida: f.dormida, porque: [] }));
  assert.deepStrictEqual(nombres(r), ['main', 'personal', 'teams']);
});

// ── quién encabeza ──────────────────────────────────────────────────────

const conPct = (nombre: string, pct: number | null, dormida: boolean) => ({ nombre, pct, dormida });
const pct = (f: { pct: number | null }) => f.pct;
const dorm = (f: { dormida: boolean }) => f.dormida;

test('una dormida en 100 % no le gana a una despierta en 35 %', () => {
  const r = elQueFrena([conPct('codex', 100, true), conPct('main', 35, false)], pct, dorm);
  assert.strictEqual(r?.nombre, 'main');
});

test('entre despiertas gana la más alta, como siempre', () => {
  const r = elQueFrena([conPct('main', 35, false), conPct('teams', 82, false)], pct, dorm);
  assert.strictEqual(r?.nombre, 'teams');
});

test('si TODAS están dormidas igual se devuelve una', () => {
  // Quedarse sin encabezado no es una respuesta: la pantalla en blanco es el
  // bug que este repo existe para no cometer.
  const r = elQueFrena([conPct('codex', 100, true), conPct('vieja', 40, true)], pct, dorm);
  assert.strictEqual(r?.nombre, 'codex');
});

test('las cuentas sin número no encabezan', () => {
  const r = elQueFrena([conPct('rota', null, false), conPct('main', 12, false)], pct, dorm);
  assert.strictEqual(r?.nombre, 'main');
});

test('sin ninguna cuenta con número, no hay encabezado', () => {
  assert.strictEqual(elQueFrena([conPct('rota', null, false)], pct, dorm), null);
});
