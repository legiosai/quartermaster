import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearCuota } from '../src/adapters/cuota.ts';
import { frase, type ResultadoCuota } from '../src/core/tipos.ts';
import { anchoVisible, relleno, tenue } from '../src/render/barras.ts';

// La forma exacta de /api/oauth/usage no está verificada contra una respuesta
// real (ver README, H2). Por eso el parser acepta varios nombres, y por eso
// estos tests fijan CADA nombre que aceptamos: cuando llegue la respuesta real,
// el que sobre se borra con evidencia y el test dice cuál era.

test('lee la forma documentada en el binario: rate_limits.used_percentage + resets_at en segundos', () => {
  const v = parsearCuota({
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: 7.5, resets_at: 1_800_300_000 },
    },
  });
  assert.equal(v.length, 2);
  const cinco = v.find((x) => x.clave === 'five_hour')!;
  assert.equal(cinco.porcentaje, 42);
  assert.equal(cinco.reinicia?.toISOString(), new Date(1_800_000_000_000).toISOString());
});

test('acepta `utilization` en la raíz, que es la clave que aparece en el call site', () => {
  const v = parsearCuota({ five_hour: { utilization: 88, resets_at: 1_800_000_000 } });
  assert.equal(v.length, 1);
  assert.equal(v[0]!.porcentaje, 88);
});

test('un epoch en milisegundos no se interpreta como 1970', () => {
  const v = parsearCuota({ seven_day: { percent: 1, resets_at: 1_800_000_000_000 } });
  assert.equal(v[0]!.reinicia?.getUTCFullYear(), 2027);
});

test('un resets_at ISO también entra', () => {
  const v = parsearCuota({ seven_day: { percent: 1, resets_at: '2027-01-15T10:00:00Z' } });
  assert.equal(v[0]!.reinicia?.toISOString(), '2027-01-15T10:00:00.000Z');
});

test('lo que no tiene porcentaje no es una ventana', () => {
  // is_enabled y weekly_scoped conviven con las ventanas en la respuesta.
  const v = parsearCuota({ is_enabled: true, weekly_scoped: false, five_hour: { resets_at: 1 } });
  assert.deepEqual(v, []);
});

test('una respuesta que no entendemos devuelve cero ventanas, no una ventana inventada', () => {
  assert.deepEqual(parsearCuota({ forma: 'nueva' }), []);
  assert.deepEqual(parsearCuota(null), []);
  assert.deepEqual(parsearCuota('texto'), []);
});

// El bug que originó la herramienta fue un monitor que no mostraba NADA.
// Ningún estado puede quedarse sin frase.
test('todo estado sin número produce una frase no vacía', () => {
  const estados: ResultadoCuota[] = [
    { estado: 'sin-credencial' },
    { estado: 'vencida' },
    { estado: 'sin-suscripcion' },
    { estado: 'no-consultada' },
    { estado: 'ilegible', detalle: 'x' },
    { estado: 'error', detalle: 'y' },
  ];
  for (const e of estados) {
    const f = frase(e, '/home/u/.claude-work');
    assert.ok(f.length > 0, `${e.estado} no dijo nada`);
  }
});

test('la frase de credencial vencida nombra el perfil y el comando que lo arregla', () => {
  const f = frase({ estado: 'vencida' }, '/home/u/.claude-work');
  assert.match(f, /CLAUDE_CONFIG_DIR=\/home\/u\/\.claude-work/);
  assert.match(f, /claude auth login/);
});

// El color ocupa bytes y no columnas: medir mal desalinea toda la tabla.
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
