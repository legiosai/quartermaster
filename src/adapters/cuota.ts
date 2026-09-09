// H2 · el único lugar que habla por red. Pide la cuota al mismo host con el que
// Claude Code ya habla, con la credencial que el usuario ya tiene.
//
// PROCEDENCIA. El endpoint no está documentado. Salió del binario que Claude
// Code instala, que contiene el call site:
//
//   fetchUtilization: GET /api/oauth/usage (attempt
//
// La FORMA de la respuesta ya no se adivina: `cachedUsageUtilization` en
// .claude.json guarda esa misma respuesta, y de ahí salieron las fixtures de
// test/fixtures/. El parser vive en utilizacion.ts y lo comparten los dos
// adaptadores porque es el mismo dato.
//
// QUÉ AGREGA ESTO SOBRE EL CACHE: frescura, y nada más. El cache alcanza para
// casi todo y no necesita credencial; este camino existe para el perfil que
// hace rato no se usa, donde el cache quedó viejo. Si el endpoint desaparece,
// la herramienta sigue dando números (ver SOUL.md).

import { tokenDeAcceso, estadoCredencial } from './credenciales.ts';
import { parsearUtilizacion } from './utilizacion.ts';
import type { Perfil, ResultadoCuota } from '../core/tipos.ts';

export const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

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

  const ventanas = parsearUtilizacion(cuerpo);
  if (ventanas.length === 0) {
    const claves = Object.keys((cuerpo as Record<string, unknown>) ?? {}).slice(0, 8);
    // Una cuenta con API key o enterprise legítimamente no tiene ventanas.
    if (claves.length === 0) return { estado: 'sin-suscripcion' };
    return { estado: 'ilegible', detalle: `sin barras reconocibles en {${claves.join(', ')}}` };
  }
  return { estado: 'ok', origen: 'endpoint', medidoEn: new Date(), ventanas };
}
