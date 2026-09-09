// H2 · el único lugar que habla por red. Pide la cuota al mismo host con el que
// Claude Code ya habla, con la credencial que el usuario ya tiene.
//
// PROCEDENCIA DEL ENDPOINT. No está documentado públicamente. Se leyó del
// binario que se instala con Claude Code
// (node_modules/@anthropic-ai/claude-code/bin/claude.exe), que contiene:
//
//   fetchUtilization: GET /api/oauth/usage (attempt
//   fetchUtilization: 200 after
//
// y, en la documentación de statusline embebida en ese mismo binario, la forma
// de los datos que Claude Code publica a partir de la respuesta:
//
//   "rate_limits": {   // Only present for subscribers after first API response.
//     "five_hour": {   // Optional: 5-hour session limit (may be absent)
//       "used_percentage": number,   // Percentage of limit used (0-100)
//       "resets_at": number          // Unix epoch seconds when this window resets
//     },
//     "seven_day": { ... }           // Optional: 7-day weekly limit
//   }
//
// Cerca del call site aparecen además las claves `utilization`, `percent`,
// `is_enabled` y `weekly_scoped`. Por eso el parser de abajo acepta varios
// nombres para lo mismo: la forma EXACTA de /api/oauth/usage no está
// verificada contra una respuesta real todavía (ver README, H2).
//
// La regla que no se negocia: si no se entiende la respuesta, se devuelve
// 'ilegible' con el detalle. Nunca se inventa un número.

import { tokenDeAcceso, estadoCredencial } from './credenciales.ts';
import type { Perfil, ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

export const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/** Nombres que hemos visto para el porcentaje usado, en orden de preferencia. */
const CLAVES_PORCENTAJE = ['used_percentage', 'utilization', 'percent'] as const;
const CLAVES_REINICIO = ['resets_at', 'resetsAt', 'reset_at'] as const;

/**
 * Un instante puede venir como epoch en segundos, epoch en milisegundos o ISO.
 * Distinguir segundos de milisegundos por magnitud es feo pero es correcto
 * hasta el año 33658, y el error de confundirlos es una fecha en 1970.
 */
function aFecha(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string' && v.length > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Una ventana si el objeto tiene forma de ventana; null si no. */
function aVentana(clave: string, v: unknown): VentanaCuota | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  let porcentaje: number | null = null;
  for (const k of CLAVES_PORCENTAJE) {
    const bruto = o[k];
    if (typeof bruto === 'number' && Number.isFinite(bruto)) {
      // `utilization` podría venir como fracción 0..1 en vez de 0..100. Un
      // valor <= 1 es ambiguo (1 % y 100 % se escriben igual); se toma como
      // porcentaje, que es lo que dice la documentación embebida, y el caso
      // ambiguo se resuelve solo cuando haya una respuesta real capturada.
      porcentaje = bruto;
      break;
    }
  }
  if (porcentaje === null) return null;
  let reinicia: Date | null = null;
  for (const k of CLAVES_REINICIO) {
    reinicia = aFecha(o[k]);
    if (reinicia) break;
  }
  return { clave, porcentaje, reinicia };
}

/**
 * Extrae todas las ventanas de un cuerpo cualquiera. Busca en la raíz y en
 * `rate_limits`, que es donde Claude Code las republica.
 */
export function parsearCuota(cuerpo: unknown): VentanaCuota[] {
  if (typeof cuerpo !== 'object' || cuerpo === null) return [];
  const raiz = cuerpo as Record<string, unknown>;
  const nido = raiz['rate_limits'];
  const fuentes: Record<string, unknown>[] = [raiz];
  if (typeof nido === 'object' && nido !== null) fuentes.push(nido as Record<string, unknown>);

  const ventanas = new Map<string, VentanaCuota>();
  for (const fuente of fuentes) {
    for (const [clave, valor] of Object.entries(fuente)) {
      const v = aVentana(clave, valor);
      if (v) ventanas.set(clave, v);
    }
  }
  return [...ventanas.values()];
}

/**
 * Pide la cuota de UN perfil. No refresca el token: si está vencido lo dice y
 * devuelve la frase que lo arregla (ver SOUL.md, non-goals).
 */
export async function consultarCuota(perfil: Perfil, ms = 10_000): Promise<ResultadoCuota> {
  const cred = estadoCredencial(perfil);
  if (cred.error !== null) return { estado: 'error', detalle: cred.error };
  if (!cred.presente) return { estado: 'sin-credencial' };
  if (cred.vencida) return { estado: 'vencida' };

  const token = tokenDeAcceso(perfil);
  if (token === null) return { estado: 'vencida' };

  let respuesta: Response;
  try {
    respuesta = await fetch(ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    const detalle = e instanceof Error ? e.message : 'error de red';
    return { estado: 'error', detalle };
  }

  if (respuesta.status === 401 || respuesta.status === 403) return { estado: 'vencida' };
  if (!respuesta.ok) return { estado: 'error', detalle: `HTTP ${respuesta.status}` };

  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    return { estado: 'ilegible', detalle: 'la respuesta no es JSON' };
  }

  const ventanas = parsearCuota(cuerpo);
  if (ventanas.length === 0) {
    const claves = Object.keys((cuerpo as Record<string, unknown>) ?? {}).slice(0, 8);
    // Una cuenta con API key o enterprise legítimamente no tiene ventanas.
    if (claves.length === 0) return { estado: 'sin-suscripcion' };
    return { estado: 'ilegible', detalle: `sin ventanas reconocibles en {${claves.join(', ')}}` };
  }
  return { estado: 'ok', ventanas };
}
