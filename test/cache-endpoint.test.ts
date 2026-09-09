// La regla que decide qué número se muestra cuando hay dos.

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { masNueva } from '../src/adapters/cache-endpoint.ts';
import type { ResultadoCuota } from '../src/core/tipos.ts';

const ok = (iso: string): ResultadoCuota => ({
  estado: 'ok',
  origen: 'cache',
  medidoEn: new Date(iso),
  ventanas: [],
});

const viejo = ok('2026-09-09T10:00:00.000Z');
const nuevo = ok('2026-09-09T11:00:00.000Z');

describe('masNueva · cuál de los dos números gana', () => {
  it('gana el más nuevo, venga de donde venga', () => {
    strictEqual(masNueva(viejo, nuevo), nuevo);
    strictEqual(masNueva(nuevo, viejo), nuevo);
  });

  it('con la misma hora se queda con el que ya estaba', () => {
    // Empatar y cambiar igual haría que el origen cambiara solo entre lecturas
    // sin que el número cambie, y la edad mostrada bailaría sin motivo.
    const a = ok('2026-09-09T10:00:00.000Z');
    const b = ok('2026-09-09T10:00:00.000Z');
    strictEqual(masNueva(a, b), a);
  });

  it('un estado sin número nunca le gana a uno con número', () => {
    // Es la regla que evita que un fallo de red borre de la pantalla un número
    // perfectamente bueno que estaba en el disco.
    strictEqual(masNueva(nuevo, { estado: 'vencida' }), nuevo);
    strictEqual(masNueva(nuevo, null), nuevo);
  });

  it('si el de la izquierda no tiene número, gana el otro aunque sea viejo', () => {
    strictEqual(masNueva({ estado: 'sin-cache' }, viejo), viejo);
  });

  it('sin ninguno de los dos, se queda con el de la izquierda', () => {
    // Ninguno tiene número, así que no hay nada que elegir: se conserva el que
    // vino del camino por defecto —el disco— y su frase, en vez de pisarla con
    // la del refresco. Cualquiera de las dos deja al usuario sin número; la
    // del disco al menos dice qué falta ahí.
    const r = masNueva({ estado: 'sin-cache' }, { estado: 'vencida' });
    strictEqual(r.estado, 'sin-cache');
  });
});
