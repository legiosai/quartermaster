// Las dos decisiones del adaptador de Codex que se pueden romper en silencio.

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsearRateLimits, tieneBarras } from '../src/adapters/codex.ts';
import { fechaDeReinicio } from '../src/adapters/opencode.ts';

/** Como lo escribe el app-server: camelCase. */
const DEL_SERVIDOR = {
  limitId: 'codex',
  primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1788970664 },
  secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1789469676 },
  planType: 'plus',
  rateLimitReachedType: null,
};

/** El MISMO dato como lo escribe el rollout: snake_case. */
const DEL_ROLLOUT = {
  limit_id: 'codex',
  primary: { used_percent: 23, window_minutes: 300, resets_at: 1788970664 },
  secondary: { used_percent: 55, window_minutes: 10080, resets_at: 1789469676 },
  plan_type: 'plus',
  rate_limit_reached_type: null,
};

const AHORA = new Date('2026-09-09T12:00:00.000Z');

describe('codex · la forma de las barras', () => {
  it('la ventana se nombra por su duración, no por la clave del servidor', () => {
    const r = parsearRateLimits(DEL_SERVIDOR, AHORA);
    strictEqual(r.cuota.estado, 'ok');
    if (r.cuota.estado !== 'ok') return;
    // 300 min es la misma pregunta que la `session` de Claude; 10 080 la semanal.
    // Igualar los nombres es lo que deja comparar las dos cuentas en una columna.
    deepStrictEqual(
      r.cuota.ventanas.map((v) => [v.clave, v.grupo, v.porcentaje]),
      [
        ['session', 'session', 23],
        ['weekly_all', 'weekly', 55],
      ],
    );
  });

  it('el rollout y el app-server dan exactamente lo mismo', () => {
    // Es la garantía de que leer del disco y preguntar por red no se
    // contradicen: si divergen, el usuario ve un número distinto según de dónde
    // salió, que es peor que no tener número.
    const a = parsearRateLimits(DEL_SERVIDOR, AHORA);
    const b = parsearRateLimits(DEL_ROLLOUT, AHORA);
    deepStrictEqual(a.cuota, b.cuota);
  });

  it('resets_at viene en segundos de epoch y sale como fecha', () => {
    const r = parsearRateLimits(DEL_ROLLOUT, AHORA);
    if (r.cuota.estado !== 'ok') throw new Error('debería ser ok');
    strictEqual(r.cuota.ventanas[0]!.reinicia?.toISOString(), new Date(1788970664 * 1000).toISOString());
  });

  it('cuando el servidor dice que ya te frenó, la barra queda con aviso', () => {
    const r = parsearRateLimits({ ...DEL_ROLLOUT, rate_limit_reached_type: 'rate_limit_reached' }, AHORA);
    if (r.cuota.estado !== 'ok') throw new Error('debería ser ok');
    strictEqual(r.cuota.ventanas.every((v) => v.severidad === 'warning'), true);
  });

  it('sin ninguna ventana no inventa un cero: dice que no hay suscripción', () => {
    const r = parsearRateLimits({ limit_id: 'codex', primary: null, secondary: null }, AHORA);
    strictEqual(r.cuota.estado, 'sin-suscripcion');
  });

  it('el plan y los créditos de reset salen del mismo balde', () => {
    const r = parsearRateLimits(
      { ...DEL_SERVIDOR, accountId: 'abc', rateLimitResetCredits: { availableCount: 2 } },
      AHORA,
    );
    strictEqual(r.info?.plan, 'plus');
    strictEqual(r.info?.creditosReset, 2);
    strictEqual(r.info?.accountId, 'abc');
  });
});

describe('codex · el balde vacío que venía después del bueno', () => {
  // Codex escribe varios baldes por evento: después del de `limit_id: codex`
  // manda uno de `premium` con todo en null. Quedarse con el último devolvía
  // ese, y descartarlo descartaba el archivo entero — con el número bueno
  // adentro, unos milisegundos antes.
  it('un balde sin porcentaje no cuenta como lectura', () => {
    strictEqual(tieneBarras({ limit_id: 'premium', primary: null, secondary: null }), false);
    strictEqual(tieneBarras({ limit_id: 'codex', primary: {} }), false);
  });

  it('un balde con porcentaje sí, venga como venga escrito', () => {
    strictEqual(tieneBarras(DEL_ROLLOUT), true);
    strictEqual(tieneBarras(DEL_SERVIDOR), true);
  });

  it('un cero es un porcentaje, no un vacío', () => {
    strictEqual(tieneBarras({ primary: { used_percent: 0 } }), true);
  });
});

describe('opencode · la fecha de reinicio que viene adentro de una oración', () => {
  it('la saca del texto del 429', () => {
    // Es lo único que estos planes dejan: no hay porcentaje por ningún lado,
    // pero cuando te frenan dicen cuándo te liberás.
    const d = fechaDeReinicio('Usage limit reached for 5 hour. Your limit will reset at 2026-09-01 00:11:03');
    strictEqual(d?.getFullYear(), 2026);
    strictEqual(d?.getMonth(), 8);
    strictEqual(d?.getDate(), 1);
  });

  it('acepta la forma sin segundos y la separada con T', () => {
    strictEqual(fechaDeReinicio('will reset at 2026-09-11 18:35')?.getMinutes(), 35);
    strictEqual(fechaDeReinicio('will reset at 2026-09-11T18:35:24')?.getHours(), 18);
  });

  it('sin fecha en el mensaje devuelve null, no una fecha inventada', () => {
    strictEqual(fechaDeReinicio('The usage limit has been reached'), null);
    strictEqual(fechaDeReinicio('will reset at mañana'), null);
  });
});
