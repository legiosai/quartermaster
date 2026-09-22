// `src/render/barras.ts` — lo que se imprime.
//
// Ojo con el nombre: `barra.test.ts` (singular) prueba `adapters/barra.ts`, que
// es otra cosa — la oferta de instalar la barra. Éste prueba el render.

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { veredictoCredencial } from '../src/render/barras.ts';
import type { EstadoCredencial } from '../src/core/tipos.ts';

function cred(parcial: Partial<EstadoCredencial>): EstadoCredencial {
  return {
    presente: true,
    ubicacion: '~/donde/sea',
    expiraEn: null,
    vencida: false,
    error: null,
    ...parcial,
  };
}

describe('veredictoCredencial', () => {
  test('ausente dice «sin credencial», no «ilegible»', () => {
    // La distinción no es cosmética: «ilegible» afirma que el archivo está y
    // está roto, y manda a quien lo lee a buscar un archivo corrupto que no
    // existe. Un adaptador que marque la ausencia con `error` rompe esto, y por
    // eso `presente` se mira primero.
    assert.equal(veredictoCredencial(cred({ presente: false })), 'sin credencial');
  });

  test('ilegible sólo cuando hay un error de verdad', () => {
    assert.equal(
      veredictoCredencial(cred({ presente: false, error: 'Unexpected token' })),
      'ilegible · Unexpected token',
    );
  });

  test('presente y sin fecha es «vigente» a secas, nunca «vigente (vencido)»', () => {
    // El bug que motivó esta función: `(expiraEn?.getTime() ?? 0) - Date.now()`
    // daba un negativo enorme y `duracion()` lo rendía como «vencido».
    const v = veredictoCredencial(cred({ presente: true, expiraEn: null }));
    assert.equal(v, 'vigente');
    assert.doesNotMatch(v, /vencido/);
  });

  test('presente con fecha futura muestra cuánto le queda', () => {
    const v = veredictoCredencial(cred({ expiraEn: new Date(Date.now() + 3600_000) }));
    assert.match(v, /^vigente \(.+\)$/);
    assert.doesNotMatch(v, /vencido/);
  });

  test('vencida gana sobre la fecha', () => {
    assert.equal(
      veredictoCredencial(cred({ vencida: true, expiraEn: new Date(Date.now() - 1000) })),
      'vencida',
    );
  });
});
