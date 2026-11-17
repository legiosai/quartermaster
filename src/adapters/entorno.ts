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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, release, type as tipoSO } from 'node:os';
import { join } from 'node:path';
import { tr } from '../core/idioma.ts';
import { directorioCache, directorioViejo } from './directorio-cache.ts';

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
function correr(cmd: string, args: readonly string[], timeout = 4000, maxBuffer = 1024 * 1024): Dato {
  try {
    const salida = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const limpio = salida.trim();
    return limpio === '' ? no(tr(`${cmd} no dijo nada`, `${cmd} said nothing`)) : val(limpio);
  } catch {
    return no(tr(`no se pudo correr ${cmd}`, `couldn't run ${cmd}`));
  }
}

/** Las rutas de casa salen del diagnóstico: está hecho para pegarlo en un issue. */
export function sinCasa(s: string): string {
  return s.split(homedir()).join('~');
}

/**
 * Lo que se imprime de un archivo o de un comando ajeno: sin casa y sin mails.
 *
 * Los logs de las superficies y el journal no los escribe el diagnóstico, así
 * que no se puede prometer qué traen. El encabezado sí promete «sin mails», y
 * una promesa así se cumple acá, en la salida, y no confiando en cada fuente.
 */
export function redactar(s: string): string {
  return sinCasa(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<mail>');
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
    return val(tr(`hace ${duracionCorta(seg)}`, `${duracionCorta(seg)} ago`));
  } catch {
    return no(tr('no existe', 'does not exist'));
  }
}

export function duracionCorta(seg: number): string {
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
  if (process.platform !== 'linux') return { dato: no(tr('sólo se mira en Linux', 'only checked on Linux')), ms: null };
  const pid = correr('pgrep', ['-x', 'gnome-shell']);
  if (!('valor' in pid)) return { dato: no(tr('no hay gnome-shell corriendo', 'no gnome-shell running')), ms: null };
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
      : no(tr('XDG_CURRENT_DESKTOP vacío', 'XDG_CURRENT_DESKTOP empty')),
    sesion: process.env['XDG_SESSION_TYPE']
      ? val(process.env['XDG_SESSION_TYPE'])
      : no(tr('XDG_SESSION_TYPE vacío', 'XDG_SESSION_TYPE empty')),
    shell:
      process.platform === 'linux' ? correr('gnome-shell', ['--version']) : no(tr('no es Linux', 'not Linux')),
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
      estado: no(tr('no está instalada', 'not installed')),
      ultimoError: no(tr('no está instalada', 'not installed')),
      archivoTocado: no(tr('no está instalada', 'not installed')),
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
            .join(' · ') || tr('sin Enabled/State en la salida', 'no Enabled/State in the output'),
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
          : no(tr('el shell no guardó ningún error', 'the shell kept no error'))
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
  const viva = join(directorioCache(), 'extension-viva');
  if (!existsSync(viva)) {
    return no(tr(
      'sin latido: el item lo dibuja AppIndicator, y ese panel es el menú de GTK',
      'no heartbeat: AppIndicator draws the item, and that panel is the GTK menu',
    ));
  }
  return edad(viva);
}

// ── el indicador ─────────────────────────────────────────────────────────

export function indicador(): Dato {
  if (process.platform !== 'linux') return no(tr('sólo se mira en Linux', 'only checked on Linux'));
  const pid = correr('pgrep', ['-af', 'qm-indicator']);
  if (!('valor' in pid)) return no(tr('no está corriendo', 'not running'));
  const lineas = pid.valor
    .split('\n')
    .filter((l) => !/pgrep|zsh|bash|-c /.test(l))
    .map((l) => sinCasa(l.trim()));
  return lineas.length === 0 ? no(tr('no está corriendo', 'not running')) : val(lineas.join('\n'));
}

/** Si el indicador arranca solo al iniciar sesión: el .desktop que escribe `qm-indicator --instalar-arranque`. */
export function indicadorAlIniciar(): boolean {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return existsSync(join(base, 'autostart', 'quartermaster.desktop'));
}

// ── el cache ─────────────────────────────────────────────────────────────

/**
 * Qué es cada archivo. Hace falta porque una edad sin significado se lee mal:
 * en el primer diagnóstico de una Mac, `qm-barra · hace 6.9d` parecía una barra
 * que llevaba una semana sin escribir, y es el binario compilado — su edad es
 * la de la última compilación, no la de la última lectura.
 */
const QUE_ES: Readonly<Record<string, readonly [string, string]>> = {
  'qm-barra': ['el binario de la barra; su edad es la de la compilación', 'the menu bar binary; its age is when it was built'],
  'extension-viva': ['el latido de la extensión de GNOME', 'the GNOME extension heartbeat'],
  'endpoint.json': ['la última lectura del endpoint, por perfil', 'the last endpoint reading, per profile'],
  'statusline.json': ['lo último que pasó la statusline, por perfil', 'the last statusline reading, per profile'],
  'codex.json': ['la última lectura de Codex', 'the last Codex reading'],
  'historial.jsonl': ['la serie de la proyección', 'the series behind the projection'],
  'frenos.json': ['hasta cuándo no preguntarle al endpoint (429)', 'when to ask the endpoint again (429)'],
  'bandeja.log': ['el log de la bandeja', 'the tray log'],
};

export interface CarpetaCache {
  /** La ruta, ya sin casa. */
  readonly ruta: string;
  /** Por qué se mira esta carpeta, cuando no es la de siempre. */
  readonly nota: string | null;
  readonly archivos: readonly { readonly nombre: string; readonly edad: string; readonly que: string | null }[];
}

/**
 * El indicador de GNOME deja un PNG por refresco con un sello en el nombre
 * (`barra-1794866635440678352.png`): listarlos de a uno llena el informe de
 * renglones iguales. Van juntos, con cuántos son y la edad del más nuevo.
 */
const SELLADO = /^(.+)-\d{6,}(\.[a-z]+)$/;

function leerCarpeta(ruta: string, nota: string | null): CarpetaCache {
  let nombres: string[] = [];
  try {
    nombres = readdirSync(ruta).sort();
  } catch {
    /* no existe o no se puede leer: la carpeta sale vacía y se dice */
  }
  const grupos = new Map<string, string[]>();
  const sueltos: string[] = [];
  for (const n of nombres) {
    const m = SELLADO.exec(n);
    if (m === null) sueltos.push(n);
    else {
      const clave = `${m[1]}-*${m[2]}`;
      grupos.set(clave, [...(grupos.get(clave) ?? []), n]);
    }
  }
  const archivos = sueltos.map((n) => {
    const q = QUE_ES[n];
    return { nombre: n, edad: texto(edad(join(ruta, n))), que: q ? tr(q[0], q[1]) : null };
  });
  for (const [clave, miembros] of grupos) {
    const nuevo = miembros.reduce((a, b) => ((mtime(join(ruta, a)) ?? 0) >= (mtime(join(ruta, b)) ?? 0) ? a : b));
    archivos.push({
      nombre: clave,
      edad: texto(edad(join(ruta, nuevo))),
      que: tr(`${miembros.length} imagen(es) que dibuja el indicador`, `${miembros.length} image(s) the indicator draws`),
    });
  }
  archivos.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { ruta: sinCasa(ruta), nota, archivos };
}

/**
 * Las carpetas donde quartermaster deja cosas en esta máquina.
 *
 * Casi siempre es una sola. Son dos cuando `XDG_CACHE_HOME` apunta a otro lado
 * y todavía quedan archivos de antes de que se respetara, y en Windows suma la
 * de la bandeja, que vive en `%LOCALAPPDATA%`.
 */
export function cache(): CarpetaCache[] {
  const carpetas = [leerCarpeta(directorioCache(), null)];
  const vieja = directorioViejo();
  if (vieja !== directorioCache() && existsSync(vieja)) {
    carpetas.push(leerCarpeta(vieja, tr(
      'la de antes de respetar XDG_CACHE_HOME: se lee hasta la próxima escritura',
      'the one from before XDG_CACHE_HOME was honored: read until the next write',
    )));
  }
  const local = process.env['LOCALAPPDATA'];
  if (process.platform === 'win32' && local) {
    carpetas.push(leerCarpeta(join(local, 'quartermaster'), tr('la de la bandeja', 'the tray\'s')));
  }
  return carpetas;
}

// ── el journal ───────────────────────────────────────────────────────────

/** Lo que el sistema anotó sobre quartermaster en este arranque. */
export function journal(lineas = 20): Dato {
  if (process.platform !== 'linux') return no(tr('sólo se mira en Linux', 'only checked on Linux'));
  // Filtrado del lado de journald. Antes se pedía el arranque ENTERO y se
  // filtraba acá, y en una máquina con un día de uso son varios MB: pasaba el
  // tope de salida de execFileSync (1 MB) y la sección decía «no se pudo correr
  // journalctl» con journalctl andando perfecto. `--grep` necesita un journald
  // con PCRE2, que es lo normal; si no lo tiene, las últimas líneas del
  // arranque con un tope de salida que alcanza para ellas.
  const PATRON = 'quartermaster|qm-indicator';
  let salida = correr('journalctl', ['--user', '-b', '--no-pager', '-o', 'cat', `--grep=${PATRON}`], 8000, 8 * 1024 * 1024);
  if (!('valor' in salida)) {
    salida = correr('journalctl', ['--user', '-b', '--no-pager', '-o', 'cat', '-n', '20000'], 8000, 64 * 1024 * 1024);
  }
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
  return suyas.length === 0 ? no(tr('el journal no tiene nada de quartermaster', 'the journal has nothing from quartermaster')) : val(redactar(suyas.join('\n')));
}

/** Las últimas líneas de un log, redactadas. */
function colaDeLog(ruta: string, lineas = 12): Dato {
  try {
    const todas = readFileSync(ruta, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (todas.length === 0) return no(tr('está vacío', 'it is empty'));
    return val(redactar(todas.slice(-lineas).join('\n')));
  } catch {
    return no(tr('no existe', 'does not exist'));
  }
}

// ── la barra de macOS ────────────────────────────────────────────────────
// En el primer diagnóstico de una Mac (issue #10) esta sección no existía: el
// indicador decía «sólo se mira en Linux» y la única pista de la barra era la
// edad de su binario en el cache, que se leyó como otra cosa.

const ETIQUETA_BARRA = 'com.legios.quartermaster.barra';
// `brew services` cambió de etiqueta: hoy escribe `sh.brew.<fórmula>`, y las
// instalaciones de antes siguen con `homebrew.mxcl.<fórmula>`. Se miran las
// dos; la primera se encontró en una Mac real, no en la documentación.
const ETIQUETAS_BREW = ['sh.brew.quartermaster', 'homebrew.mxcl.quartermaster'];

/** Lo que launchd sabe de un agente: si está cargado, su PID y cómo salió la última vez. */
export interface AgenteLaunchd {
  readonly etiqueta: string;
  /** Lo registró `brew services`, no `qm-barra --instalar-arranque`. */
  readonly brew: boolean;
  /** El plist está en ~/Library/LaunchAgents: arranca solo al iniciar sesión. */
  readonly plist: boolean;
  /** `launchctl list` lo conoce. */
  readonly cargado: boolean;
  readonly pid: number | null;
  readonly ultimaSalida: number | null;
}

/** Lee la salida de `launchctl list <etiqueta>`: un diccionario con `"PID" = 123;`. */
export function leerLaunchctl(salida: string): { readonly pid: number | null; readonly ultimaSalida: number | null } {
  const num = (clave: string): number | null => {
    const m = new RegExp(`"${clave}"\\s*=\\s*(-?\\d+)\\s*;`).exec(salida);
    return m ? Number(m[1]) : null;
  };
  return { pid: num('PID'), ultimaSalida: num('LastExitStatus') };
}

function agente(etiqueta: string): AgenteLaunchd {
  const brew = ETIQUETAS_BREW.includes(etiqueta);
  const plist = existsSync(join(homedir(), 'Library', 'LaunchAgents', `${etiqueta}.plist`));
  const lista = correr('launchctl', ['list', etiqueta]);
  if (!('valor' in lista)) return { etiqueta, brew, plist, cargado: false, pid: null, ultimaSalida: null };
  return { etiqueta, brew, plist, cargado: true, ...leerLaunchctl(lista.valor) };
}

export interface BarraMac {
  /** Si el binario se compiló alguna vez en esta máquina. */
  readonly compilada: boolean;
  readonly binario: Dato;
  /** Los procesos de la barra, con PID y hora de arranque. Vacío si no corre. */
  readonly procesos: readonly string[];
  readonly corriendo: Dato;
  /** El agente propio (`qm-barra --instalar-arranque`) y el de `brew services`. */
  readonly agentes: readonly AgenteLaunchd[];
  /** Dónde escribe brew el log del servicio, si existe. */
  readonly rutaLog: string | null;
  readonly log: Dato;
}

/** El PID y la hora de arranque de cada proceso, sin la casa. */
function conArranque(pids: readonly string[]): string[] {
  return pids.map((pid) => {
    const cuando = correr('ps', ['-o', 'lstart=', '-p', pid]);
    return 'valor' in cuando ? `pid ${pid} · ${tr('desde', 'since')} ${cuando.valor}` : `pid ${pid}`;
  });
}

export function barraMac(): BarraMac {
  const binario = join(directorioCache(), 'qm-barra');
  const compilada = existsSync(binario);
  // El lanzador hace `exec` del binario compilado, así que el proceso vivo es
  // ése. El patrón exige el final del nombre: así no cuenta un `swiftc` que
  // está compilando `qm-barra.swift`.
  const pg = correr('pgrep', ['-f', 'quartermaster/qm-barra( |$)']);
  const pids = 'valor' in pg ? pg.valor.split('\n').map((p) => p.trim()).filter((p) => /^\d+$/.test(p)) : [];
  const procesos = conArranque(pids);
  const logs = ['/opt/homebrew/var/log/quartermaster.log', '/usr/local/var/log/quartermaster.log'];
  const rutaLog = logs.find((r) => existsSync(r)) ?? null;
  return {
    compilada,
    binario: compilada ? edad(binario) : no(tr('nunca se compiló en esta máquina', 'never built on this machine')),
    procesos,
    corriendo: procesos.length > 0 ? val(procesos.join('\n')) : no(tr('no está corriendo', 'not running')),
    agentes: [ETIQUETA_BARRA, ...ETIQUETAS_BREW].map(agente),
    rutaLog,
    log: rutaLog === null
      ? no(tr('sin log: sólo `brew services` guarda uno', 'no log: only `brew services` keeps one'))
      : colaDeLog(rutaLog),
  };
}

// ── la bandeja de Windows ────────────────────────────────────────────────

export interface BandejaWindows {
  /** PowerShell corrió: si `procesos` está vacío, es que la bandeja no corre. */
  readonly consultada: boolean;
  readonly procesos: readonly string[];
  readonly corriendo: Dato;
  /** El acceso directo que el instalador deja en Inicio si se marcó la tarea. */
  readonly alIniciar: boolean;
  readonly log: Dato;
}

export function bandejaWindows(): BandejaWindows {
  // La bandeja es un powershell.exe con `-File …\qm-tray.ps1`: el nombre del
  // proceso no dice nada, la línea de comandos sí. CIM es la forma de leerla
  // sin permisos de administrador. Arrancar PowerShell tarda: el plazo es más
  // largo que el del resto de las sondas.
  const consulta =
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' or Name='pwsh.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*qm-tray.ps1*' } | " +
    "ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CreationDate.ToString('s') }; 'listo'";
  // El `'listo'` del final separa «PowerShell corrió y no hay bandeja» de «no
  // se pudo correr PowerShell»: sin él las dos son una salida vacía.
  const ps = correr('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', consulta], 15_000);
  const procesos = 'valor' in ps
    ? ps.valor.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+ /.test(l))
        .map((l) => { const [pid, cuando] = l.split(' '); return `pid ${pid} · ${tr('desde', 'since')} ${cuando}`; })
    : [];
  const appdata = process.env['APPDATA'];
  const alIniciar = appdata !== undefined &&
    existsSync(join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'quartermaster.lnk'));
  const local = process.env['LOCALAPPDATA'];
  return {
    consultada: 'valor' in ps,
    procesos,
    corriendo: procesos.length > 0
      ? val(procesos.join('\n'))
      : 'valor' in ps ? no(tr('no está corriendo', 'not running')) : ps,
    alIniciar,
    log: local ? colaDeLog(join(local, 'quartermaster', 'bandeja.log')) : no(tr('LOCALAPPDATA vacío', 'LOCALAPPDATA empty')),
  };
}
