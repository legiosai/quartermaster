// Dónde vive el cache de quartermaster. UNA respuesta para todo el programa.
//
// POR QUÉ EXISTE. El historial y la memoria de `--aviso` respetaban
// `XDG_CACHE_HOME`; la lectura del endpoint, la de Codex, la de la statusline y
// el diagnóstico escribían en `~/.cache` a mano. En una máquina con la
// variable puesta el cache quedaba partido en dos carpetas, y lo que más
// costaba era el diagnóstico: buscaba el latido de la extensión de GNOME —que
// GLib escribe bajo `XDG_CACHE_HOME`— en la carpeta equivocada, y decía «sin
// latido» de una extensión viva. Un diagnóstico que se equivoca con seguridad
// es peor que ninguno.
//
// Las superficies ya lo hacían bien: el indicador de GNOME, la barra de macOS y
// la extensión miran la variable. Esto alinea al resto con ellas.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** La carpeta: `$XDG_CACHE_HOME/quartermaster`, o `~/.cache/quartermaster`. */
export function directorioCache(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'quartermaster');
}

/** Donde estaba todo antes de respetar `XDG_CACHE_HOME`. */
export function directorioViejo(): string {
  return join(homedir(), '.cache', 'quartermaster');
}

/** Dónde se ESCRIBE un archivo del cache. */
export function rutaEnCache(nombre: string): string {
  return join(directorioCache(), nombre);
}

/**
 * Dónde se LEE un archivo del cache.
 *
 * Si todavía no existe en la carpeta nueva y sí en la vieja, se lee la vieja.
 * Sin esto, quien tiene `XDG_CACHE_HOME` puesto perdería su última lectura el
 * día que actualiza: el número desaparece hasta el próximo calentado, que es
 * justo el silencio que este repo no acepta. La primera escritura lo deja en
 * la carpeta nueva —con lo que había en la vieja adentro, porque cada escritor
 * lee, mezcla y escribe— y desde ahí la vieja ya no se mira.
 */
export function rutaParaLeer(nombre: string): string {
  const nueva = rutaEnCache(nombre);
  if (existsSync(nueva)) return nueva;
  const vieja = join(directorioViejo(), nombre);
  return vieja !== nueva && existsSync(vieja) ? vieja : nueva;
}
