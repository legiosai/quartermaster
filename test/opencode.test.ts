// La fecha de reinicio que viaja adentro del texto de un 429.

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fechaDeReinicio } from '../src/adapters/opencode.ts';

describe('fechaDeReinicio · el 429 que guarda opencode', () => {
  it('la hora del mensaje es de Beijing, no la de la máquina', () => {
    // Antes se leía como hora local. Las dos puntas del mismo dato lo cerraron:
    // este 429 y el `nextResetTime` del endpoint de cuota para la misma ventana
    // semanal (2026-09-18T10:35:24Z) dan 7 días exactos sólo si el texto es
    // UTC+8. Leído como local en UTC daban 6 días y 16 horas, que no es ninguna
    // ventana — y en cualquier máquina fuera de UTC+8 el «libre en» salía 8 h
    // antes de tiempo.
    const d = fechaDeReinicio(
      'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-11 18:35:24',
    );
    strictEqual(d?.toISOString(), '2026-09-11T10:35:24.000Z');
  });

  it('acepta la forma sin segundos y la que trae T', () => {
    strictEqual(fechaDeReinicio('will reset at 2026-09-11 18:35')?.toISOString(), '2026-09-11T10:35:00.000Z');
    strictEqual(fechaDeReinicio('will reset at 2026-09-11T18:35:24')?.toISOString(), '2026-09-11T10:35:24.000Z');
  });

  it('la saca del texto del 429', () => {
    // Es lo que estos planes dejan gratis: cuando te frenan dicen cuándo te
    // liberás, y opencode guarda la respuesta.
    const d = fechaDeReinicio(
      'Usage limit reached for 5 hour. Your limit will reset at 2026-09-01 00:11:03',
    );
    strictEqual(d?.toISOString(), '2026-08-31T16:11:03.000Z');
  });

  it('un mensaje sin fecha no inventa una', () => {
    strictEqual(fechaDeReinicio('Rate limit exceeded'), null);
    strictEqual(fechaDeReinicio('The usage limit has been reached'), null);
    strictEqual(fechaDeReinicio('will reset at mañana'), null);
    strictEqual(fechaDeReinicio(''), null);
  });
});
