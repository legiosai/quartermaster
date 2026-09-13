// Qué hay alrededor del programa: el escritorio, las superficies instaladas y
// desde cuándo corre cada cosa.
//
// POR QUÉ EXISTE. El 2026-09-13 un reporte decía «toco Panel de cuota y se
// cierra al instante». La causa estaba a la vista y en ningún lado: la
// extensión de GNOME no arrancaba —un error de tipo guardado por el shell— y
// sin extensión el panel cae al menú de GTK, que es el que se cierra al
// tocarlo. Encontrarlo llevó `gnome-extensions info`, `gdbus call … 
// GetExtensionErrors`, `journalctl --user -b | grep`, mirar el `.cache/`, y
// preguntarle a `ps` cuándo había arrancado la sesión — porque el arreglo ya
// estaba en el disco y el shell seguía con el módulo viejo en memoria.
//
// Cinco comandos que nadie tiene por qué saberse para reportar un bug. Acá
// están los cinco, en uno.
//
// Todo lo de acá adentro es OPCIONAL y falla blando: una máquina sin GNOME, sin
// `ps` o sin DBus tiene que producir un diagnóstico igual, diciendo qué no pudo
// averiguar. Un diagnóstico que se muere porque le faltó un comando es
// exactamente el silencio que este repo no acepta.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, release, type as tipoSO } from 'node:os';
import { join } from 'node:path';

export const CACHE = join(homedir(), '.cache', 'quartermaster');
const UUID_EXTENSION = 'quartermaster@legios';

/** Un dato que se pudo averiguar, o el motivo por el que no. */
export type Dato = { readonly valor: string } | { readonly noSePudo: string };

const val = (valor: string): Dato => ({ valor });
const no = (noSePudo: string): Dato => ({ noSePudo });
export const texto = (d: Dato): string => ('valor' in d ? d.valor : `— (${d.noSePudo})`);

/**
 * Corre un comando y devuelve su salida. Nunca tira: un diagnóstico que se cae
 * porque falta un binario no diagnostica nada.
 *
 * El timeout no es decorativo: `gdbus` contra un shell ocupado se queda
 * esperando, y el diagnóstico tiene que terminar siempre.
 */
function correr(cmd: string, args: readonly string[]): Dato {
  try {
    const salida = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const limpio = salida.trim();
    return limpio === '' ? no(`${cmd} no dijo nada`) : val(limpio);
  } catch {
    return no(`no se pudo correr ${cmd}`);
  }
}

/** Las rutas de casa salen del diagnóstico: está hecho para pegarlo en un issue. */
export function sinCasa(s: string): string {
  return s.split(homedir()).join('~');
}

export function mtime(ruta: string): number | null {
  try {
    return statSync(ruta).mtimeMs;
  } catch {
    return null;
  }
}

export function edad(ruta: string): Dato {
  try {
    const seg = Math.round((Date.now() - statSync(ruta).mtimeMs) / 1000);
    return val(`hace ${duracionCorta(seg)}`);
  } catch {
    return no('no existe');
  }
}

function duracionCorta(seg: number): string {
  if (seg < 60) return `${seg}s`;
  if (seg < 3600) return `${Math.round(seg / 60)}m`;
  if (seg < 86400) return `${(seg / 3600).toFixed(1)}h`;
  return `${(seg / 86400).toFixed(1)}d`;
}

// ── el escritorio ────────────────────────────────────────────────────────

export interface Escritorio {
  readonly so: string;
  readonly escritorio: Dato;
  readonly sesion: Dato;
  readonly shell: Dato;
  readonly arrancoLaSesion: Dato;
  /** El mismo instante en ms, cuando se pudo leer. Para comparar, no para mostrar. */
  readonly arrancoMs: number | null;
}

/**
 * Cuándo arrancó el proceso del shell gráfico.
 *
 * Es el dato que contesta la pregunta más cara de todas: si una extensión se
 * arregló en el disco DESPUÉS de que arrancó la sesión, el shell sigue con el
 * módulo viejo en memoria y el arreglo no está corriendo. En Wayland no hay
 * forma de recargarlo —`ReloadExtension` está declarado en DBus y devuelve
 * UnknownMethod— así que la única salida es cerrar sesión. Sin este dato, eso
 * se confunde con «el arreglo no sirvió».
 */
function arranqueDelShell(): { readonly dato: Dato; readonly ms: number | null } {
  if (process.platform !== 'linux') return { dato: no('sólo se mira en Linux'), ms: null };
  const pid = correr('pgrep', ['-x', 'gnome-shell']);
  if (!('valor' in pid)) return { dato: no('no hay gnome-shell corriendo'), ms: null };
  const primero = pid.valor.split('\n')[0]!.trim();
  const cuando = correr('ps', ['-o', 'lstart=', '-p', primero]);
  if (!('valor' in cuando)) return { dato: cuando, ms: null };
  const ms = Date.parse(cuando.valor);
  return { dato: val(cuando.valor), ms: Number.isNaN(ms) ? null : ms };
}

export function escritorio(): Escritorio {
  const arranque = arranqueDelShell();
  return {
    so: `${tipoSO()} ${release()} (${process.platform})`,
    escritorio: process.env['XDG_CURRENT_DESKTOP']
      ? val(process.env['XDG_CURRENT_DESKTOP'])
      : no('XDG_CURRENT_DESKTOP vacío'),
    sesion: process.env['XDG_SESSION_TYPE']
      ? val(process.env['XDG_SESSION_TYPE'])
      : no('XDG_SESSION_TYPE vacío'),
    shell:
      process.platform === 'linux' ? correr('gnome-shell', ['--version']) : no('no es Linux'),
    arrancoLaSesion: arranque.dato,
    arrancoMs: arranque.ms,
  };
}

// ── la extensión de GNOME ────────────────────────────────────────────────

export interface Extension {
  readonly instalada: boolean;
  readonly estado: Dato;
  readonly ultimoError: Dato;
  readonly archivoTocado: Dato;
  /** mtime de extension.js en ms, cuando se pudo leer. Para comparar. */
  readonly tocadoMs: number | null;
  readonly latido: Dato;
}

/**
 * El estado de la extensión, incluido el error que el shell tiene GUARDADO.
 *
 * `gnome-extensions info` dice `State: ERROR` y nada más. El motivo se lo pide
 * por DBus, y es lo que realmente hace falta: el stack con archivo y línea.
 */
export function extension(): Extension {
  const dir = join(homedir(), '.local', 'share', 'gnome-shell', 'extensions', UUID_EXTENSION);
  const instalada = existsSync(dir);
  if (!instalada) {
    return {
      instalada: false,
      estado: no('no está instalada'),
      ultimoError: no('no está instalada'),
      archivoTocado: no('no está instalada'),
      tocadoMs: null,
      latido: latidoExtension(),
    };
  }
  const info = correr('gnome-extensions', ['info', UUID_EXTENSION]);
  const estado =
    'valor' in info
      ? val(
          info.valor
            .split('\n')
            .filter((l) => /^\s*(Enabled|State):/.test(l))
            .map((l) => l.trim())
            .join(' · ') || 'sin Enabled/State en la salida',
        )
      : info;
  const errores = correr('gdbus', [
    'call', '--session',
    '--dest', 'org.gnome.Shell.Extensions',
    '--object-path', '/org/gnome/Shell/Extensions',
    '--method', 'org.gnome.Shell.Extensions.GetExtensionErrors',
    UUID_EXTENSION,
  ]);
  return {
    instalada: true,
    estado,
    ultimoError:
      'valor' in errores
        ? errores.valor.includes('\\n') || errores.valor.length > 8
          ? val(sinCasa(errores.valor))
          : no('el shell no guardó ningún error')
        : errores,
    archivoTocado: edad(join(dir, 'extension.js')),
    tocadoMs: mtime(join(dir, 'extension.js')),
    latido: latidoExtension(),
  };
}

/**
 * El latido que la extensión renueva mientras vive.
 *
 * Si no está, qm-indicator muestra su PROPIO item de AppIndicator — y ése abre
 * el panel adentro de un menú de GTK, que es el que no sostiene el agarre y se
 * cierra al tocarlo. O sea: sin latido, «el panel se cierra solo» es lo
 * esperable, y el problema real está en la extensión.
 */
function latidoExtension(): Dato {
  const viva = join(CACHE, 'extension-viva');
  if (!existsSync(viva)) {
    return no('sin latido: el item lo dibuja AppIndicator, y ese panel es el menú de GTK');
  }
  return edad(viva);
}

// ── el indicador ─────────────────────────────────────────────────────────

export function indicador(): Dato {
  if (process.platform !== 'linux') return no('sólo se mira en Linux');
  const pid = correr('pgrep', ['-af', 'qm-indicator']);
  if (!('valor' in pid)) return no('no está corriendo');
  const lineas = pid.valor
    .split('\n')
    .filter((l) => !/pgrep|zsh|bash|-c /.test(l))
    .map((l) => sinCasa(l.trim()));
  return lineas.length === 0 ? no('no está corriendo') : val(lineas.join('\n'));
}

// ── el cache ─────────────────────────────────────────────────────────────

export function cache(): { readonly nombre: string; readonly edad: string }[] {
  try {
    return readdirSync(CACHE)
      .sort()
      .map((n) => ({ nombre: n, edad: texto(edad(join(CACHE, n))) }));
  } catch {
    return [];
  }
}

// ── el journal ───────────────────────────────────────────────────────────

/** Lo que el sistema anotó sobre quartermaster en este arranque. */
export function journal(lineas = 20): Dato {
  if (process.platform !== 'linux') return no('sólo se mira en Linux');
  const salida = correr('journalctl', ['--user', '-b', '--no-pager', '-o', 'cat']);
  if (!('valor' in salida)) return salida;
  // `grep quartermaster` a secas trae ruido que no es del programa: líneas de
  // sudo cuyo PWD es el repo, y activaciones de DBus disparadas por el propio
  // `gnome-extensions info` que corre este diagnóstico. Se sacan: un diagnóstico
  // que hay que leer con pinzas es un diagnóstico que nadie lee.
  const RUIDO = /Activating service name=|Successfully activated service|a password is required|pam_unix|sudo\[/;
  const suyas = salida.valor
    .split('\n')
    .filter((l) => /quartermaster|qm-indicator/i.test(l) && !RUIDO.test(l))
    .slice(-lineas);
  return suyas.length === 0 ? no('el journal no tiene nada de quartermaster') : val(sinCasa(suyas.join('\n')));
}
