import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsearUtilizacion, aFecha } from '../src/adapters/utilizacion.ts';
import { frase, peor, paraMostrar, nombreVentana, esPreocupante, type ResultadoCuota } from '../src/core/tipos.ts';
import { anchoVisible, relleno, tenue } from '../src/render/barras.ts';

// Las fixtures son respuestas REALES de dos cuentas de distinto tipo, sacadas
// de `cachedUsageUtilization` en .claude.json y redactadas sólo en accountUuid.
const max = JSON.parse(readFileSync(new URL('./fixtures/cached-usage-max.json', import.meta.url), 'utf8'));
const team = JSON.parse(readFileSync(new URL('./fixtures/cached-usage-team.json', import.meta.url), 'utf8'));

// ─── Lo que este repo existe para no dejar pasar ──────────────────────────

test('la barra que manda no es ninguna de las dos que todos leen', () => {
  // En esta cuenta five_hour=8 % y seven_day=59 %: cómodo. La que está por
  // frenarla es un weekly_scoped de un modelo puntual, al 75 % y con aviso.
  const v = parsearUtilizacion(max);
  const p = peor(v)!;
  assert.equal(p.clave, 'weekly_scoped');
  assert.equal(p.porcentaje, 75);
  assert.equal(p.severidad, 'warning');
  assert.equal(p.alcance, 'Fable');
  assert.ok(esPreocupante(p));
  assert.equal(nombreVentana(p), 'weekly_scoped (Fable)');
});

test('un lector que sólo mirara five_hour informaría 8 % con la cuenta al 75 %', () => {
  // El test que fija el tamaño del error, para que se note si alguien
  // "simplifica" el parser y vuelve a leer sólo las claves con nombre.
  const cincoHoras = max.utilization.five_hour.utilization;
  const real = peor(parsearUtilizacion(max))!.porcentaje;
  assert.equal(cincoHoras, 8);
  assert.equal(real, 75);
});

test('las barras en null no se cuentan como barras', () => {
  // seven_day_opus, seven_day_sonnet y otras diez vienen literalmente null.
  assert.equal(max.utilization.seven_day_opus, null);
  const claves = parsearUtilizacion(max).map((v) => v.clave);
  assert.ok(!claves.includes('seven_day_opus'));
});

test('limits[] y las barras con nombre no se muestran dos veces', () => {
  // `session` (de limits[]) y `five_hour` son la misma barra con dos nombres.
  const claves = parsearUtilizacion(max).map((v) => v.clave);
  assert.ok(claves.includes('session'));
  assert.ok(!claves.includes('five_hour'), 'five_hour duplica a session');
  assert.ok(!claves.includes('seven_day'), 'seven_day duplica a weekly_all');
});

test('spend, extra_usage y limits no son barras de cuota', () => {
  const claves = parsearUtilizacion(max).map((v) => v.clave);
  for (const k of ['spend', 'extra_usage', 'limits', 'seven_day_breakdown']) {
    assert.ok(!claves.includes(k), `${k} no es una barra`);
  }
});

test('la segunda cuenta, de otro tipo, se lee igual', () => {
  const v = parsearUtilizacion(team);
  const p = peor(v)!;
  // Acá la activa sí es la más alta: weekly_all al 40 %.
  assert.equal(p.clave, 'weekly_all');
  assert.equal(p.porcentaje, 40);
  assert.equal(p.activa, true);
  assert.equal(p.severidad, 'normal');
});

test('si el servidor marca activa una barra más baja, gana la más alta', () => {
  // En las fixtures la activa resulta ser también la más alta, así que este
  // caso hay que construirlo: es la rama que decide qué te frena PRIMERO.
  const v = parsearUtilizacion({
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 20, severity: 'normal', is_active: true },
      { kind: 'session', group: 'session', percent: 90, severity: 'warning', is_active: false },
    ],
  });
  const p = peor(v)!;
  assert.equal(p.clave, 'session');
  assert.equal(p.porcentaje, 90);
});

test('con todo igual, la activa es la que se marca', () => {
  const v = parsearUtilizacion({
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 30, severity: 'normal', is_active: true },
      { kind: 'session', group: 'session', percent: 30, severity: 'normal', is_active: false },
    ],
  });
  assert.equal(peor(v)!.clave, 'weekly_all');
});

test('resets_at viene en ISO con offset y se entiende', () => {
  const sesion = parsearUtilizacion(max).find((v) => v.clave === 'session')!;
  assert.equal(sesion.reinicia?.toISOString(), '2026-09-09T04:20:00.117Z');
});

test('paraMostrar saca las barras internas que vienen en cero', () => {
  const todas = parsearUtilizacion(max);
  assert.ok(todas.some((v) => v.clave === 'nimbus_quill'), 'el parser no censura nada');
  assert.ok(!paraMostrar(todas).some((v) => v.clave === 'nimbus_quill'), 'el render sí');
});

// ─── Que nunca invente un número ──────────────────────────────────────────

test('una respuesta que no entendemos da cero barras, no una barra inventada', () => {
  assert.deepEqual(parsearUtilizacion({ forma: 'nueva' }), []);
  assert.deepEqual(parsearUtilizacion(null), []);
  assert.deepEqual(parsearUtilizacion('texto'), []);
  assert.deepEqual(parsearUtilizacion({ limits: [{ kind: 'x' }] }), [], 'sin percent no hay barra');
});

test('una entrada de limits sin kind no se cuela con nombre vacío', () => {
  assert.deepEqual(parsearUtilizacion({ limits: [{ percent: 90 }] }), []);
});

// ─── Fechas ───────────────────────────────────────────────────────────────

test('epoch en segundos y en milisegundos no se confunden', () => {
  assert.equal(aFecha(1_800_000_000)?.getUTCFullYear(), 2027);
  assert.equal(aFecha(1_800_000_000_000)?.getUTCFullYear(), 2027);
  assert.equal(aFecha('2027-01-15T10:00:00Z')?.toISOString(), '2027-01-15T10:00:00.000Z');
  assert.equal(aFecha(null), null);
  assert.equal(aFecha('mañana'), null);
});

// ─── Ningún estado mudo ───────────────────────────────────────────────────

test('todo estado sin número produce una frase no vacía', () => {
  const estados: ResultadoCuota[] = [
    { estado: 'sin-credencial' },
    { estado: 'vencida' },
    { estado: 'sin-cache' },
    { estado: 'sin-suscripcion' },
    { estado: 'no-consultada' },
    { estado: 'ilegible', detalle: 'x' },
    { estado: 'error', detalle: 'y' },
  ];
  for (const e of estados) {
    assert.ok(frase(e, '/home/u/.claude-work').length > 0, `${e.estado} no dijo nada`);
  }
});

test('la frase de credencial vencida nombra el perfil y el comando que lo arregla', () => {
  const f = frase({ estado: 'vencida' }, '/home/u/.claude-work');
  assert.match(f, /CLAUDE_CONFIG_DIR=\/home\/u\/\.claude-work/);
  assert.match(f, /claude auth login/);
});

// ─── Render ───────────────────────────────────────────────────────────────

// El literal va escrito a mano a propósito: `tenue()` no pinta nada cuando la
// salida no es una terminal, que es justo el caso en CI, y entonces el test
// pasaría sin haber probado nada.
test('el relleno cuenta columnas, no bytes de color', () => {
  const celda = '\x1b[2msin cuenta\x1b[0m';
  assert.equal(celda.length, 18);
  assert.equal(anchoVisible(celda), 10);
  assert.equal(anchoVisible(relleno(celda, 32)), 32);
  assert.equal(anchoVisible(relleno(celda, 4)), 10, 'no recorta lo que ya es más ancho');
});

test('tenue() sigue siendo medible por anchoVisible, pinte o no pinte', () => {
  assert.equal(anchoVisible(tenue('hola')), 4);
});
