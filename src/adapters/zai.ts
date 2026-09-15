// La cuota de los planes de z.ai (GLM Coding Plan), que SÍ existe.
//
// Este archivo es la excepción declarada al párrafo de arriba de `opencode.ts`.
// Ese adaptador promete no abrir `auth.json` ni una vez, y la sigue cumpliendo:
// descubrir proveedores y contar tokens se hace de la base de sesiones, sin
// credencial. Pero la BITACORA cerró en su momento con «el porcentaje no
// existe», y esa conclusión quedó vieja — z.ai expone un endpoint de cuota:
//
//   GET https://api.z.ai/api/monitor/usage/quota/limit
//   Authorization: Bearer <la clave que opencode ya guardó>
//
// Medido contra la cuenta donde se escribió esto, HTTP 200:
//
//   {"code":200,"data":{"limits":[
//     {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,
//      "currentValue":0,"remaining":2000,"percentage":0},
//     {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":10000,
//      "currentValue":0,"remaining":10000,"percentage":0,
//      "nextResetTime":1789727724998}],
//     "level":"lite"},"success":true}
//
// OJO CON `usage`: no es lo gastado, es el TECHO. Lo gastado es `currentValue`
// y `remaining` es lo que queda (`usage - currentValue`). El nombre invita a
// leerlo al revés, y leerlo al revés da 100 % cuando no gastaste nada.
//
// Como cuesta una clave, este camino NO corre solo: vale lo mismo que el
// endpoint de Anthropic —sólo con `--refrescar` o `--calentar`— y lo que ve la
// pantalla por defecto es el cache que dejó la última corrida. Es el principio
// de SOUL: preferir el número que no pide permiso, y que el que sí lo pide sea
// el refrescador y nunca el único camino a un número.
//
// El endpoint tampoco está documentado. Si desaparece, la fila de opencode
// sigue teniendo su piso —tokens contados de la base— y la frase de siempre.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR_OPENCODE } from './opencode.ts';
import type { ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

export const ENDPOINT_ZAI = 'https://api.z.ai/api/monitor/usage/quota/limit';

/**
 * Los `providerID` que este endpoint sabe contestar.
 *
 * Son dos porque son dos productos distintos del mismo vendor: `zai` pega
 * contra `api.z.ai/api/paas/v4` —el saldo por uso— y `zai-coding-plan` contra
 * `api.z.ai/api/coding/paas/v4` —la suscripción—. La cuota que devuelve este
 * endpoint es la de la suscripción en los dos casos; que la key sea de un plan
 * o no lo dice la respuesta, no nosotros.
 */
export const PROVEEDORES_ZAI: ReadonlySet<string> = new Set(['zai', 'zai-coding-plan']);

/**
 * La clave que opencode guardó para un proveedor. Sólo se llama con
 * `--refrescar` o `--calentar`, igual que `tokenDeAcceso()`.
 *
 * Devuelve el secreto y por eso no lo toca nadie más: quien la llama la manda
 * al endpoint y la suelta. Nunca se imprime, nunca se loguea, nunca entra en un
 * mensaje de error — los `catch` de acá devuelven null, no el contenido.
 */
export function claveDeOpencode(proveedor: string): string | null {
  try {
    const auth = JSON.parse(readFileSync(join(DIR_OPENCODE, 'auth.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const entrada = auth[proveedor];
    if (typeof entrada !== 'object' || entrada === null) return null;
    const e = entrada as Record<string, unknown>;
    if (e['type'] !== 'api' || typeof e['key'] !== 'string' || e['key'] === '') return null;
    return e['key'];
  } catch {
    // Sin archivo, ilegible, o sin esa clave. Las tres cosas son «no hay», y
    // ninguna justifica filtrar por qué en un mensaje que puede terminar en un
    // log.
    return null;
  }
}

/**
 * Qué ventana es cada `unit`, y en qué unidad viene su `number`.
 *
 * `unit: 3` es la ventana corta y su `number` son horas (5); `unit: 6` es la
 * semanal y su `number` son semanas (1). Cualquier otra se saltea entera: el
 * contador de búsquedas web viaja en el mismo array con `type: "TIME_LIMIT"` y
 * no es una barra de cuota de tokens, así que meterlo sería mezclar dos cosas
 * que se agotan por separado.
 */
const UNIDADES: Readonly<Record<number, { clave: string; grupo: string; msPorNumero: number }>> = {
  3: { clave: 'session', grupo: 'session', msPorNumero: 3600_000 },
  6: { clave: 'weekly', grupo: 'weekly', msPorNumero: 7 * 24 * 3600_000 },
};

const TIPOS = new Set(['TOKENS_LIMIT', 'CREDIT_LIMIT']);

/**
 * La respuesta a barras. Puro, para poder testearlo con el payload real.
 *
 * Dos decisiones que no son obvias:
 *
 * **`severidad` es siempre `normal` y `activa` siempre `false`.** z.ai no manda
 * ninguna de las dos. Inventar un `warning` sería inventar una opinión del
 * servidor que no existe; con `normal` la regla del 80 % de `esPreocupante()`
 * hace el trabajo, y `peor()` —sin ninguna activa— se queda con la más alta,
 * que es exactamente lo que corresponde cuando nadie marcó una.
 *
 * **La ventana corta se guarda con un techo de reinicio.** z.ai manda
 * `nextResetTime` sólo en la semanal; la de 5 h es rodante y se libera 5 h
 * después de lo que gastaste. O sea que no se sabe cuándo reinicia, pero sí se
 * sabe que **no puede reiniciar más tarde que ahora + 5 h**, y eso es un dato
 * verdadero, no un relleno. Importa porque este número se cachea: sin un
 * instante de vencimiento, `vencida()` nunca marca la lectura y un 100 % de
 * anteayer se seguiría mostrando como si fuera de hoy — que es el caso peor
 * que `tipos.ts` documenta en `vencida()`. Con el techo, el cache se marca solo.
 */
export function parsearCuotaZai(cuerpo: unknown, ahora: number = Date.now()): VentanaCuota[] {
  if (typeof cuerpo !== 'object' || cuerpo === null) return [];
  const datos = (cuerpo as Record<string, unknown>)['data'];
  if (typeof datos !== 'object' || datos === null) return [];
  const limites = (datos as Record<string, unknown>)['limits'];
  if (!Array.isArray(limites)) return [];

  const salida: VentanaCuota[] = [];
  for (const cruda of limites) {
    if (typeof cruda !== 'object' || cruda === null) continue;
    const e = cruda as Record<string, unknown>;

    if (typeof e['type'] !== 'string' || !TIPOS.has(e['type'])) continue;
    const unidad = typeof e['unit'] === 'number' ? UNIDADES[e['unit']] : undefined;
    if (unidad === undefined) continue;

    const pct = porcentaje(e);
    if (pct === null) continue;

    const reset = e['nextResetTime'];
    let reinicia: Date | null = null;
    if (typeof reset === 'number' && Number.isFinite(reset) && reset > 0) {
      reinicia = new Date(reset);
    } else if (typeof e['number'] === 'number' && e['number'] > 0) {
      reinicia = new Date(ahora + e['number'] * unidad.msPorNumero);
    }

    salida.push({
      clave: unidad.clave,
      grupo: unidad.grupo,
      alcance: null,
      porcentaje: pct,
      reinicia,
      severidad: 'normal',
      activa: false,
    });
  }
  return salida;
}

/**
 * El porcentaje de una entrada, con `percentage` mandando y la división de
 * respaldo.
 *
 * La división existe porque `percentage` es el único campo del payload que no
 * se puede reconstruir si un día viene ausente o en otra escala, y los otros
 * tres —`usage`, `currentValue`, `remaining`— son coherentes entre sí. Se
 * acota a 0..100 porque una barra fuera de rango rompe el render y no dice
 * nada que el 100 % no diga.
 */
function porcentaje(e: Record<string, unknown>): number | null {
  const p = e['percentage'];
  if (typeof p === 'number' && Number.isFinite(p)) return Math.min(100, Math.max(0, p));
  const techo = e['usage'];
  const gastado = e['currentValue'];
  if (typeof techo === 'number' && typeof gastado === 'number' && techo > 0) {
    return Math.min(100, Math.max(0, (gastado / techo) * 100));
  }
  return null;
}

/**
 * Le pide la cuota a z.ai para un proveedor. Igual que `consultarCuota()`: no
 * refresca nada, no escribe nada, y cada estado que no produce número produce
 * una frase.
 */
export async function consultarCuotaZai(proveedor: string, ms = 10_000): Promise<ResultadoCuota> {
  if (!PROVEEDORES_ZAI.has(proveedor)) return { estado: 'no-consultada' };
  const clave = claveDeOpencode(proveedor);
  if (clave === null) return { estado: 'sin-credencial' };

  let respuesta: Response;
  try {
    respuesta = await fetch(ENDPOINT_ZAI, {
      method: 'GET',
      headers: { Authorization: `Bearer ${clave}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    return { estado: 'error', detalle: e instanceof Error ? e.message : 'error de red' };
  }

  if (respuesta.status === 401 || respuesta.status === 403) {
    // No se dice «vencida»: una API key no vence como un token OAuth, y la
    // frase de ese estado manda a correr `claude auth login`, que acá no
    // arregla nada.
    return { estado: 'error', detalle: `HTTP ${respuesta.status} — la clave de ${proveedor} en auth.json no la acepta z.ai` };
  }
  if (!respuesta.ok) return { estado: 'error', detalle: `HTTP ${respuesta.status}` };

  let cuerpo: unknown;
  try {
    cuerpo = await respuesta.json();
  } catch {
    return { estado: 'ilegible', detalle: 'la respuesta de z.ai no es JSON' };
  }

  const ventanas = parsearCuotaZai(cuerpo);
  if (ventanas.length === 0) {
    // Una key por uso, sin suscripción, contesta 200 con la lista vacía: no
    // tiene límites de plan que reportar, que es otra cosa que un error.
    const c = cuerpo as Record<string, unknown>;
    const datos = (c['data'] ?? {}) as Record<string, unknown>;
    if (Array.isArray(datos['limits']) && datos['limits'].length === 0) {
      return { estado: 'sin-suscripcion' };
    }
    return { estado: 'ilegible', detalle: `sin barras reconocibles en {${Object.keys(c).slice(0, 8).join(', ')}}` };
  }
  return { estado: 'ok', origen: 'endpoint', medidoEn: new Date(), ventanas };
}
