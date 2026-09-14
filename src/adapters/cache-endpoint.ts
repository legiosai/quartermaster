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

// ── el freno del endpoint ────────────────────────────────────────────────
// Cuando el endpoint contesta 429 se anota hasta cuándo no preguntar por ESA
// cuenta (ver src/core/pedir.ts). Va en un archivo aparte y no adentro de
// endpoint.json: un freno no es una lectura, y mezclarlos haría que un 429
// pareciera un número guardado.
const FRENOS = join(dirname(CACHE), 'frenos.json');

function leerFrenos(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(FRENOS, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function frenadoHasta(perfil: string): Date | null {
  const t = leerFrenos()[perfil];
  if (t === undefined) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Si no se puede escribir, se pierde el freno: el próximo 429 lo vuelve a anotar. */
export function anotarFreno(perfil: string, hasta: Date): void {
  try {
    const todo = leerFrenos();
    todo[perfil] = hasta.toISOString();
    mkdirSync(dirname(FRENOS), { recursive: true });
    writeFileSync(FRENOS, JSON.stringify(todo));
  } catch {
    /* vacío a propósito */
  }
}

/** La más nueva de las dos. Ninguna miente mientras se muestre su edad. */
export function masNueva(a: ResultadoCuota, b: ResultadoCuota | null): ResultadoCuota {
  if (b === null || b.estado !== 'ok') return a;
  if (a.estado !== 'ok') return b;
  return b.medidoEn.getTime() > a.medidoEn.getTime() ? b : a;
}
