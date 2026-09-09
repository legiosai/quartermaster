// H5 · la cuota SIN red y SIN credencial.
//
// Claude Code guarda en el .claude.json de cada perfil la última respuesta de
// utilización que recibió, bajo `cachedUsageUtilization`:
//
//   { "fetchedAtMs": 1788916089239, "accountUuid": "…", "utilization": { … } }
//
// Eso convierte el número de cuota en un dato de disco. Importa por tres
// razones, y la tercera es la que justifica el archivo:
//
//   1. No cuesta una llamada de red.
//   2. No necesita credencial, así que funciona en un perfil con el token
//      vencido — que es EXACTAMENTE el estado en el que la herramienta que
//      motivó este repo se quedaba muda para siempre.
//   3. Es lo que Claude Code ya está mirando, así que no puede discrepar con
//      lo que el usuario ve adentro de Claude Code.
//
// El precio es que es un cache: sólo se refresca cuando ese perfil corre. Por
// eso `medidoEn` no se negocia y quien muestre esto tiene que mostrar la edad.
// Un número viejo presentado como actual es la misma mentira que el silencio.

import { leerConfig } from '../core/perfiles.ts';
import { parsearUtilizacion } from './utilizacion.ts';
import type { Perfil, ResultadoCuota } from '../core/tipos.ts';

export function cuotaEnCache(perfil: Perfil): ResultadoCuota {
  const config = leerConfig(perfil.directorio);
  if (config === null) return { estado: 'sin-cache' };

  const cache = config['cachedUsageUtilization'];
  if (typeof cache !== 'object' || cache === null) return { estado: 'sin-cache' };
  const c = cache as Record<string, unknown>;

  const ms = c['fetchedAtMs'];
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return { estado: 'ilegible', detalle: 'cachedUsageUtilization sin fetchedAtMs' };
  }

  const ventanas = parsearUtilizacion(c);
  if (ventanas.length === 0) {
    const dentro = c['utilization'];
    const claves = Object.keys((dentro as Record<string, unknown>) ?? {}).slice(0, 8);
    if (claves.length === 0) return { estado: 'sin-suscripcion' };
    return { estado: 'ilegible', detalle: `sin barras reconocibles en {${claves.join(', ')}}` };
  }

  return { estado: 'ok', origen: 'cache', medidoEn: new Date(ms), ventanas };
}
