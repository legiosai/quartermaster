// La cuota de un perfil de Claude tal como está en el disco: sin red y sin
// credencial.
//
// Es la misma regla que usa `medir()` para la terminal y el JSON —la lectura
// más nueva entre la de Claude Code y la del endpoint, con lo de la statusline
// encima—, sacada a un lugar propio para que `--mejor` y `--aviso` la usen sin
// copiarla. Una regla de precedencia escrita dos veces termina valiendo
// distinto en cada lado (ver SOUL.md, «A rule in three languages»).

import { cuotaEnCache } from './cache-cuota.ts';
import { endpointEnCache, masNueva } from './cache-endpoint.ts';
import { claveBarra, muestras } from './historial.ts';
import { statuslineEnCache, superponer } from './statusline.ts';
import { proyectar, type Proyeccion } from '../core/proyeccion.ts';
import type { Perfil, ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

export function cuotaGuardada(perfil: Perfil): ResultadoCuota {
  return superponer(masNueva(cuotaEnCache(perfil), endpointEnCache(perfil.nombre)), statuslineEnCache(perfil.nombre));
}

/** Hacia dónde va una barra, con las muestras que ya hay en el historial. Sólo lee. */
export function proyeccionDe(perfil: string, v: VentanaCuota | null, ahora = Date.now()): Proyeccion | null {
  if (v === null) return null;
  return proyectar(muestras(perfil, claveBarra(v.clave, v.alcance)), v.porcentaje, v.reinicia, ahora);
}
