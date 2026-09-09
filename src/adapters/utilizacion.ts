// La forma de la utilización, tal como la manda el servidor. La comparten el
// adaptador que la lee del disco y el que la pide por red, porque son el mismo
// dato: Claude Code guarda en .claude.json, bajo `cachedUsageUtilization`, la
// respuesta que recibió.
//
// FORMA VERIFICADA (2026-09-09) contra dos cuentas reales de distinto tipo,
// una Max y una de equipo. Las fixtures redactadas están en test/fixtures/.
//
//   {
//     "five_hour":  { "utilization": 8,  "resets_at": "2026-09-09T04:20:00+00:00",
//                     "limit_dollars": null, "used_dollars": null,
//                     "remaining_dollars": null, "locked_reason": null },
//     "seven_day":  { ... },
//     "seven_day_opus": null, "seven_day_sonnet": null, …   ← casi todas null
//     "limits": [
//       { "kind": "session",       "group": "session", "percent": 8,
//         "severity": "normal",  "resets_at": "…", "scope": null, "is_active": false },
//       { "kind": "weekly_all",    "group": "weekly",  "percent": 59,
//         "severity": "normal",  "resets_at": "…", "scope": null, "is_active": false },
//       { "kind": "weekly_scoped", "group": "weekly",  "percent": 75,
//         "severity": "warning", "resets_at": "…", "is_active": true,
//         "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } }
//     ],
//     "extra_usage": { … }, "spend": { … }
//   }
//
// `limits` es la fuente buena y `five_hour`/`seven_day` el respaldo: la tercera
// barra del ejemplo —la única con aviso, y la que estaba por frenar la cuenta—
// NO tiene entrada propia arriba. `seven_day_opus` y compañía venían en null.
// Leer sólo las claves con nombre es exactamente cómo se esconde un 75 %.
//
// Ojo con lo que NO dice: los porcentajes vienen sin el límite absoluto
// (`limit_dollars` es null en planes de suscripción). Se puede decir «vas 75 %»
// y «se reinicia tal día», no «te quedan N tokens».

import type { VentanaCuota } from '../core/tipos.ts';

/** Un instante ISO, o epoch en segundos o milisegundos. null si no se entiende. */
export function aFecha(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Distinguir por magnitud es feo pero es correcto hasta el año 33658, y el
    // error de confundirlos es una fecha en 1970.
    const d = new Date(v > 1e11 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string' && v.length > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** El nombre del alcance de una barra: hoy, el display_name del modelo. */
function alcanceDe(scope: unknown): string | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const s = scope as Record<string, unknown>;
  const modelo = s['model'];
  if (typeof modelo === 'object' && modelo !== null) {
    const m = modelo as Record<string, unknown>;
    const n = texto(m['display_name']) ?? texto(m['id']);
    if (n) return n;
  }
  return texto(s['surface']);
}

/** Una entrada de `limits[]`. */
function deLimite(v: unknown): VentanaCuota | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const pct = o['percent'];
  const clave = texto(o['kind']);
  if (typeof pct !== 'number' || !Number.isFinite(pct) || clave === null) return null;
  return {
    clave,
    porcentaje: pct,
    reinicia: aFecha(o['resets_at']),
    severidad: texto(o['severity']) ?? 'normal',
    activa: o['is_active'] === true,
    alcance: alcanceDe(o['scope']),
    grupo: texto(o['group']),
  };
}

/** Una barra con nombre propio: five_hour, seven_day… */
function deBarra(clave: string, v: unknown): VentanaCuota | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  // `utilization` es lo que manda el servidor. `used_percentage` es como lo
  // republica Claude Code en su statusline; se acepta por si alguien le pasa eso.
  const pct = o['utilization'] ?? o['used_percentage'] ?? o['percent'];
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return {
    clave,
    porcentaje: pct,
    reinicia: aFecha(o['resets_at']),
    severidad: texto(o['severity']) ?? 'normal',
    activa: false,
    alcance: null,
    grupo: null,
  };
}

/** Claves de `utilization` que no son barras y no hay que intentar leer como tales. */
const NO_SON_BARRAS = new Set(['limits', 'spend', 'extra_usage', 'seven_day_breakdown']);

/**
 * Todas las barras de un cuerpo de utilización. Acepta el objeto pelado, o
 * envuelto en `utilization` (como lo guarda el cache) o en `rate_limits`.
 *
 * `limits[]` gana sobre las barras con nombre cuando describen lo mismo: trae
 * severidad, alcance y cuál está activa, que las otras no tienen.
 */
export function parsearUtilizacion(cuerpo: unknown): VentanaCuota[] {
  if (typeof cuerpo !== 'object' || cuerpo === null) return [];
  const raiz = cuerpo as Record<string, unknown>;
  for (const envoltorio of ['utilization', 'rate_limits']) {
    const dentro = raiz[envoltorio];
    if (typeof dentro === 'object' && dentro !== null && !Array.isArray(dentro)) {
      return parsearUtilizacion(dentro);
    }
  }

  const ventanas: VentanaCuota[] = [];

  const limites = raiz['limits'];
  if (Array.isArray(limites)) {
    for (const l of limites) {
      const v = deLimite(l);
      if (v) ventanas.push(v);
    }
  }

  // Las barras con nombre sólo se agregan si `limits[]` no cubrió ese grupo:
  // five_hour y `session` son la misma barra con dos nombres, y mostrarla dos
  // veces hace dudar del resto de la tabla.
  const cubiertoSesion = ventanas.some((v) => v.grupo === 'session');
  const cubiertoSemanal = ventanas.some((v) => v.grupo === 'weekly');
  for (const [clave, valor] of Object.entries(raiz)) {
    if (NO_SON_BARRAS.has(clave)) continue;
    if (clave === 'five_hour' && cubiertoSesion) continue;
    if (clave.startsWith('seven_day') && cubiertoSemanal) continue;
    const v = deBarra(clave, valor);
    if (v) ventanas.push(v);
  }

  return ventanas;
}
