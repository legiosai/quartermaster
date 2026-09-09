// El único lugar que toca credenciales. Devuelve estado para mostrar (sin
// secreto) o el token para pollear, nunca las dos cosas mezcladas.
//
// macOS  → llavero, servicio determinista (ver core/perfiles.ts).
// Linux  → <directorio>/.credentials.json, 0600.
// Windows→ mismo archivo. NO VERIFICADO: puede usar DPAPI. Ver README.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { servicioLlavero } from '../core/perfiles.ts';
import type { EstadoCredencial, Perfil } from '../core/tipos.ts';

interface BlobOAuth {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /** Epoch en milisegundos. */
  readonly expiresAt?: number;
  readonly subscriptionType?: string;
}

const esMac = process.platform === 'darwin';
const esWindows = process.platform === 'win32';

function rutaArchivo(perfil: Perfil): string {
  return join(perfil.directorio, '.credentials.json');
}

export function ubicacionCredencial(perfil: Perfil): string {
  return esMac ? servicioLlavero(perfil.directorio) : rutaArchivo(perfil);
}

/** Lee el blob crudo. Puede lanzar. El secreto no se loguea nunca. */
function leerBlob(perfil: Perfil): BlobOAuth | null {
  let texto: string;
  if (esMac) {
    // -w imprime sólo la contraseña. Si el usuario deniega el prompt del
    // llavero, security sale distinto de 0 y esto lanza.
    texto = execFileSync('security', ['find-generic-password', '-s', servicioLlavero(perfil.directorio), '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } else {
    const ruta = rutaArchivo(perfil);
    if (!existsSync(ruta)) return null;
    texto = readFileSync(ruta, 'utf8');
  }
  const json = JSON.parse(texto) as Record<string, unknown>;
  return (json['claudeAiOauth'] as BlobOAuth) ?? (json as BlobOAuth);
}

/** Estado para mostrar. Nunca devuelve el token. */
export function estadoCredencial(perfil: Perfil): EstadoCredencial {
  const ubicacion = ubicacionCredencial(perfil);
  try {
    const blob = leerBlob(perfil);
    if (!blob || !blob.accessToken) {
      // En Windows «no está el archivo» NO significa «no estás logueado»: no
      // sabemos si Claude Code guarda ahí la credencial o usa DPAPI / el
      // Credential Manager. Decir «sin credencial» sería inventar un
      // diagnóstico, y encima uno que manda al usuario a loguearse de nuevo.
      if (esWindows) {
        return {
          presente: false,
          ubicacion,
          expiraEn: null,
          vencida: false,
          error: 'Windows sin verificar: no hay .credentials.json y puede que use DPAPI',
        };
      }
      return { presente: false, ubicacion, expiraEn: null, vencida: false, error: null };
    }
    const expiraEn = typeof blob.expiresAt === 'number' ? new Date(blob.expiresAt) : null;
    return {
      presente: true,
      ubicacion,
      expiraEn,
      vencida: expiraEn !== null && expiraEn.getTime() <= Date.now(),
      error: null,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message.split('\n')[0]! : 'error desconocido';
    return { presente: false, ubicacion, expiraEn: null, vencida: false, error };
  }
}

/** El token, para el adaptador que pollea. Devuelve null si no hay uno usable. */
export function tokenDeAcceso(perfil: Perfil): string | null {
  try {
    const blob = leerBlob(perfil);
    if (!blob?.accessToken) return null;
    if (typeof blob.expiresAt === 'number' && blob.expiresAt <= Date.now()) return null;
    return blob.accessToken;
  } catch {
    return null;
  }
}
