// Descubrimiento de perfiles. Claude Code guarda cada perfil en un directorio
// distinto (CLAUDE_CONFIG_DIR) y cada directorio tiene su propia credencial.
//
// El hallazgo que hace posible este archivo: en macOS el servicio del llavero
// es determinista. El directorio por defecto usa "Claude Code-credentials" a
// secas; cualquier otro usa ese nombre más un guion y los primeros 8 hex del
// sha256 de la RUTA ABSOLUTA del directorio. Verificado contra items reales.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { Cuenta, Perfil } from './tipos.ts';

const SERVICIO_BASE = 'Claude Code-credentials';

/** El directorio por defecto, sin mirar CLAUDE_CONFIG_DIR. */
export function directorioPorDefecto(): string {
  return join(homedir(), '.claude');
}

/**
 * El servicio del llavero (macOS) que corresponde a un directorio de configuración.
 * Determinista: no hace falta enumerar el llavero ni adivinar.
 */
export function servicioLlavero(directorio: string): string {
  if (directorio === directorioPorDefecto()) return SERVICIO_BASE;
  const hash = createHash('sha256').update(directorio).digest('hex').slice(0, 8);
  return `${SERVICIO_BASE}-${hash}`;
}

/**
 * Lee la cuenta de un perfil sin tocar credenciales. Claude Code escribe
 * oauthAccount en .claude.json; en instalaciones viejas ese archivo vive un
 * nivel más arriba (~/.claude.json) en vez de adentro del directorio.
 */
/**
 * Los `.claude.json` candidatos de un perfil, del más rico al más pobre.
 *
 * El perfil por defecto guarda su config al lado del directorio (`~/.claude.json`)
 * y los demás adentro (`<dir>/.claude.json`), así que se prueban las dos. Lo
 * que NO se puede hacer es quedarse con la primera que exista, que es lo que
 * hacía antes: Claude Code creó un `~/.claude/.claude.json` de 9 claves —sin
 * cuenta y sin cuota— al lado del `~/.claude.json` de 45 que sí las tenía, y el
 * perfil pasó a mostrarse como «sin cuenta» de un día para el otro.
 *
 * Un archivo vacío que tapa a uno lleno es la misma falla que este repo le
 * critica a los monitores que leen una sola credencial, sólo que un nivel más
 * abajo. Así que se ordenan por lo que traen, no por dónde están.
 *
 * Y a igual riqueza, primero el más nuevo. Medido el 2026-11-01: ese
 * `~/.claude/.claude.json` ya tenía cuenta (escrita el 13/10, en Max 5x) y
 * ninguno de los dos traía `cachedUsageUtilization`, así que empataban; el
 * empate dejaba el orden de las rutas, y el viejo tapaba al `~/.claude.json`
 * que Claude Code sigue escribiendo, donde la cuenta ya era Ultra.
 */
export function rutasConfig(directorio: string): string[] {
  const riqueza = (ruta: string): number => {
    try {
      const j = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
      return (j['cachedUsageUtilization'] !== undefined ? 2 : 0) + (j['oauthAccount'] !== undefined ? 1 : 0);
    } catch {
      return -1;
    }
  };
  const escrito = (ruta: string): number => {
    try {
      return statSync(ruta).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [join(directorio, '.claude.json'), `${directorio}.json`]
    .filter((r) => existsSync(r))
    .map((ruta) => ({ ruta, r: riqueza(ruta), t: escrito(ruta) }))
    .sort((a, b) => b.r - a.r || b.t - a.t)
    .map((x) => x.ruta);
}

/** El .claude.json de un perfil, ya parseado. null si no hay o no se puede leer. */
export function leerConfig(directorio: string): Record<string, unknown> | null {
  // Se fusionan los candidatos de pobre a rico, así que si uno tiene la cuenta
  // y el otro la cuota, no se pierde ninguna de las dos.
  const rutas = rutasConfig(directorio);
  if (rutas.length === 0) return null;
  let salida: Record<string, unknown> | null = null;
  for (const ruta of [...rutas].reverse()) {
    try {
      const j = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
      const previo: Record<string, unknown> = salida ?? {};
      salida = { ...previo, ...j };
    } catch {
      // Un .claude.json corrupto no debería tumbar el descubrimiento entero.
    }
  }
  return salida;
}

export function leerCuenta(directorio: string): Cuenta | null {
  const json = leerConfig(directorio);
  if (json === null) return null;
  const oauth = json['oauthAccount'] as Record<string, unknown> | undefined;
  if (!oauth) return null;
  const plan = (oauth['seatTier'] as string) ?? (oauth['organizationType'] as string) ?? null;
  return {
    email: (oauth['emailAddress'] as string) ?? null,
    organizacion: (oauth['organizationName'] as string) ?? null,
    plan,
    planNombre: nombrePlan(oauth, plan),
  };
}

/** Un string con algo adentro, o null. `''` y `null` valen lo mismo: nada. */
function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * El plan como lo dice Claude Code en pantalla, con el multiplicador al lado.
 *
 * `plan` sale de `seatTier ?? organizationType`, y en una cuenta individual
 * `seatTier` es null: el plan cae en `organizationType`, que vale `claude_max`
 * para Max 5x, Max 20x y Ultra por igual. Medido el 2026-11-01: una cuenta que
 * ya era Ultra (`planDisplayName: "Ultra"`) se seguía mostrando `claude_max`,
 * igual que el 13/10 cuando era Max 5x. Lo que sí cambió entre las dos fechas
 * es el tier de rate limit (`default_claude_max_5x` → `default_claude_max_20x`),
 * que es lo único que dice cuánta cuota hay detrás.
 *
 * El tier del usuario va antes que el de la organización: en Teams el de la
 * organización es un nombre interno (`default_raven`) y el del asiento
 * (`userRateLimitTier: default_claude_max_5x`) es el que te frena a vos.
 */
export function nombrePlan(oauth: Record<string, unknown>, plan: string | null): string | null {
  const nombre = texto(oauth['planDisplayName']) ?? plan;
  if (nombre === null) return null;
  const nivel = nivelPlan(texto(oauth['userRateLimitTier']) ?? texto(oauth['organizationRateLimitTier']));
  if (nivel === null) return nombre;
  // «Max 20x (max_20x)» no agrega nada: si el nombre ya lo dice, no se repite.
  if (nombre.toLowerCase().replace(/[\s-]+/g, '_').includes(nivel)) return nombre;
  return `${nombre} (${nivel})`;
}

/**
 * `default_claude_max_20x` → `max_20x`. Sólo los tiers con multiplicador: los
 * otros (`default_raven`, `default_claude_ai`) son nombres internos que no le
 * dicen nada a quien lee, y entre paréntesis serían ruido.
 */
function nivelPlan(tier: string | null): string | null {
  if (tier === null) return null;
  const corto = tier.replace(/^default_/, '').replace(/^claude_/, '');
  return /\d+x$/.test(corto) ? corto : null;
}

/**
 * Lo que se muestra de una cuenta donde va el plan. Lo usan TODAS las salidas
 * del CLI, y el JSON lo publica ya resuelto en `planNombre`: si cada pantalla
 * eligiera entre `planNombre` y `plan` por su lado, alguna se olvidaría.
 */
export function planParaMostrar(cuenta: Cuenta | null | undefined): string | null {
  return cuenta?.planNombre ?? cuenta?.plan ?? null;
}

/**
 * Todos los perfiles que existen en esta máquina: el por defecto, el que
 * CLAUDE_CONFIG_DIR apunte, y cualquier hermano ~/.claude-* que parezca un
 * directorio de configuración.
 */
export function descubrirPerfiles(): Perfil[] {
  const porDefecto = directorioPorDefecto();
  const vistos = new Set<string>();
  const dirs: string[] = [];

  const agregar = (d: string): void => {
    if (!d || vistos.has(d)) return;
    if (!existsSync(d) || !statSync(d).isDirectory()) return;
    vistos.add(d);
    dirs.push(d);
  };

  agregar(porDefecto);
  agregar(process.env['CLAUDE_CONFIG_DIR'] ?? '');

  // Hermanos: ~/.claude-personal, ~/.claude-teams, etc. Se aceptan sólo si
  // tienen adentro algo que Claude Code haya escrito.
  const casa = homedir();
  let entradas: string[] = [];
  try {
    entradas = readdirSync(casa);
  } catch {
    entradas = [];
  }
  for (const entrada of entradas) {
    if (!entrada.startsWith('.claude-')) continue;
    const ruta = join(casa, entrada);
    if (!existsSync(join(ruta, '.claude.json')) && !existsSync(join(ruta, 'projects'))) continue;
    agregar(ruta);
  }

  return dirs.map((directorio) => ({
    directorio,
    nombre: basename(directorio),
    porDefecto: directorio === porDefecto,
    cuenta: leerCuenta(directorio),
  }));
}
