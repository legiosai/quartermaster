// El cache de lo que devolvió el endpoint, escrito por nosotros.
//
// Hace falta por una asimetría que H2 dejó a la vista. El número bueno de la
// sesión sólo sale del endpoint —con 95 minutos de cache la sesión estaba 11
// puntos abajo, ver numeros/h2-endpoint.md—, pero **ese número no se puede
// guardar donde Claude Code guarda el suyo**: `.claude.json` es de él, y este
// repo lee credenciales y configuración, no las escribe. Meterle mano sería
// competir con sus escrituras por un cache.
//
// Así que la lectura fresca se guarda acá, al lado de la de Codex, y `qm` usa
// la más nueva de las dos: la de Claude Code o la nuestra. La edad se sigue
// mostrando siempre, venga de donde venga.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

const CACHE = join(homedir(), '.cache', 'quartermaster', 'endpoint.json');

interface Guardado {
  medidoEn: string;
  ventanas: (Omit<VentanaCuota, 'reinicia'> & { reinicia: string | null })[];
}

function leerTodo(): Record<string, Guardado> {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, Guardado>;
  } catch {
    return {};
  }
}

/** Guarda una lectura del endpoint. Si no se puede escribir, se pierde la edad y nada más. */
export function guardarEndpoint(perfil: string, cuota: ResultadoCuota): void {
  if (cuota.estado !== 'ok') return;
  try {
    const todo = leerTodo();
    todo[perfil] = {
      medidoEn: cuota.medidoEn.toISOString(),
      ventanas: cuota.ventanas.map((v) => ({ ...v, reinicia: v.reinicia?.toISOString() ?? null })),
    };
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(todo));
  } catch {
    /* vacío a propósito */
  }
}

export function endpointEnCache(perfil: string): ResultadoCuota | null {
  if (!existsSync(CACHE)) return null;
  const g = leerTodo()[perfil];
  if (g === undefined) return null;
  const medidoEn = new Date(g.medidoEn);
  if (Number.isNaN(medidoEn.getTime())) return null;
  return {
    estado: 'ok',
    origen: 'endpoint',
    medidoEn,
    ventanas: g.ventanas.map((v) => ({ ...v, reinicia: v.reinicia === null ? null : new Date(v.reinicia) })),
  };
}

/** La más nueva de las dos. Ninguna miente mientras se muestre su edad. */
export function masNueva(a: ResultadoCuota, b: ResultadoCuota | null): ResultadoCuota {
  if (b === null || b.estado !== 'ok') return a;
  if (a.estado !== 'ok') return b;
  return b.medidoEn.getTime() > a.medidoEn.getTime() ? b : a;
}
