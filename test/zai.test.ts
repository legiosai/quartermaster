// El parser de la cuota de z.ai, contra el payload que devolvió de verdad.

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsearCuotaZai } from '../src/adapters/zai.ts';

/**
 * Copiado tal cual de `GET /api/monitor/usage/quota/limit`, cuenta `lite`,
 * 2026-09-14. Es la fixture: si el vendor cambia la forma, este archivo es el
 * que tiene que fallar.
 */
const REAL = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
      {
        type: 'CREDIT_LIMIT',
        unit: 6,
        number: 1,
        usage: 10000,
        currentValue: 0,
        remaining: 10000,
        percentage: 0,
        nextResetTime: 1789727724998,
      },
    ],
    level: 'lite',
  },
  success: true,
};

const AHORA = Date.parse('2026-09-14T23:36:00.000Z');

describe('parsearCuotaZai · el payload real', () => {
  it('saca las dos ventanas, con los nombres que el núcleo ya entiende', () => {
    const v = parsearCuotaZai(REAL, AHORA);
    strictEqual(v.length, 2);
    deepStrictEqual(
      v.map((x) => [x.clave, x.grupo]),
      [
        ['session', 'session'],
        ['weekly', 'weekly'],
      ],
    );
  });

  it('`usage` es el techo, no lo gastado', () => {
    // El campo se llama «usage» y vale 2000 con currentValue 0. Leerlo como
    // consumo da 100 % en una cuenta que no gastó nada — el 0 % que parece un
    // dato, al revés y peor.
    for (const x of parsearCuotaZai(REAL, AHORA)) strictEqual(x.porcentaje, 0);
  });

  it('la semanal usa el nextResetTime que manda el servidor', () => {
    const semanal = parsearCuotaZai(REAL, AHORA)[1]!;
    strictEqual(semanal.reinicia?.toISOString(), '2026-09-18T10:35:24.998Z');
  });

  it('la de 5 h se guarda con su techo de reinicio, que es lo único que se sabe', () => {
    // z.ai no manda nextResetTime para la ventana rodante. No se sabe cuándo
    // reinicia, pero sí que no puede ser más tarde que ahora + 5 h, y sin ese
    // instante `vencida()` nunca marcaría un cache viejo.
    const sesion = parsearCuotaZai(REAL, AHORA)[0]!;
    strictEqual(sesion.reinicia?.getTime(), AHORA + 5 * 3600_000);
  });

  it('no inventa severidad ni marca ninguna activa', () => {
    // El servidor no manda ninguna de las dos. Con `normal` decide la regla del
    // 80 %; con una `activa` inventada decidiría una opinión que nadie dio.
    for (const x of parsearCuotaZai(REAL, AHORA)) {
      strictEqual(x.severidad, 'normal');
      strictEqual(x.activa, false);
      strictEqual(x.alcance, null);
    }
  });
});

describe('parsearCuotaZai · lo que se saltea', () => {
  const con = (limits: unknown[]) => parsearCuotaZai({ data: { limits } }, AHORA);

  it('el contador de búsquedas web no es una barra de cuota', () => {
    strictEqual(con([{ type: 'TIME_LIMIT', unit: 3, number: 5, percentage: 90 }]).length, 0);
  });

  it('una unidad que no conocemos se saltea en vez de adivinarse', () => {
    strictEqual(con([{ type: 'TOKENS_LIMIT', unit: 99, number: 1, percentage: 50 }]).length, 0);
  });

  it('una entrada sin porcentaje ni con qué calcularlo no produce barra', () => {
    strictEqual(con([{ type: 'TOKENS_LIMIT', unit: 6, number: 1 }]).length, 0);
    strictEqual(con([{ type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 0, currentValue: 0 }]).length, 0);
  });

  it('basura no tira nada abajo', () => {
    strictEqual(parsearCuotaZai(null, AHORA).length, 0);
    strictEqual(parsearCuotaZai({ data: {} }, AHORA).length, 0);
    strictEqual(parsearCuotaZai({ data: { limits: 'no' } }, AHORA).length, 0);
    strictEqual(con([null, 7, 'x']).length, 0);
  });
});

describe('parsearCuotaZai · el porcentaje', () => {
  const una = (e: Record<string, unknown>) =>
    parsearCuotaZai({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, ...e }] } }, AHORA)[0]!;

  it('manda el que viene', () => {
    strictEqual(una({ percentage: 42.5 }).porcentaje, 42.5);
  });

  it('si no viene, sale de lo gastado sobre el techo', () => {
    strictEqual(una({ usage: 10000, currentValue: 2500 }).porcentaje, 25);
  });

  it('se acota a 0..100', () => {
    strictEqual(una({ percentage: 140 }).porcentaje, 100);
    strictEqual(una({ percentage: -3 }).porcentaje, 0);
  });
});
