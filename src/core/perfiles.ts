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
export function leerCuenta(directorio: string): Cuenta | null {
  const candidatos = [join(directorio, '.claude.json'), `${directorio}.json`];
  for (const ruta of candidatos) {
    if (!existsSync(ruta)) continue;
    try {
      const json = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
      const oauth = json['oauthAccount'] as Record<string, unknown> | undefined;
      if (!oauth) continue;
      return {
        email: (oauth['emailAddress'] as string) ?? null,
        organizacion: (oauth['organizationName'] as string) ?? null,
        plan: (oauth['seatTier'] as string) ?? (oauth['organizationType'] as string) ?? null,
      };
    } catch {
      // Un .claude.json corrupto no debería tumbar el descubrimiento entero.
    }
  }
  return null;
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
