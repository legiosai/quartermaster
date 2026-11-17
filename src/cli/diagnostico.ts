// `qm --diagnostico`: todo lo que hace falta para reportar un bug, en un solo
// comando, y la conclusión.
//
// Vivía adentro de qm.ts y sólo sabía de Linux. El primer diagnóstico de una
// Mac (issue #10) mostró las tres cosas que le faltaban: imprimía la sección
// de la extensión de GNOME —que en una Mac no existe—, no miraba la barra de
// menú, y no llegaba a ninguna conclusión. Un diagnóstico que deja los datos y
// no dice qué significan obliga a quien reporta a saber lo que justamente no
// sabe. Ahora cada plataforma mira su propia superficie y todas terminan en un
// veredicto.
//
// Lo que no cambió: va REDACTADO —sin casa, sin mails, sin tokens— porque está
// hecho para pegarlo en un issue público, y contesta siempre, incluso con todo
// lo demás roto. No abre ninguna credencial ni le pregunta nada a un endpoint.
//
// Lo único que sale de la máquina es la prueba de red: un DNS, una conexión al
// 443 y un saludo TLS a api.anthropic.com, sin pedido HTTP. Entró porque una
// Mac pasó tres días con «fetch failed» en cada refresco y la causa —un
// firewall de aplicaciones— no estaba en ningún dato de este informe.
// `--sin-red` la saltea.

import { codexEnCache, hayCodex } from '../adapters/codex.ts';
import { ENDPOINT } from '../adapters/cuota.ts';
import { cuotaGuardada } from '../adapters/cuota-guardada.ts';
import * as entorno from '../adapters/entorno.ts';
import { firewallsCorriendo, probarRed, type Firewall, type Paso, type SondaRed } from '../adapters/red.ts';
import { statuslineEnCache } from '../adapters/statusline.ts';
import { leerConfigUsuario, seleccionar } from '../core/config.ts';
import { tr } from '../core/idioma.ts';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { detalleDeRed } from '../core/red.ts';
import { DIAS_DORMIDA, relevancia } from '../core/relevancia.ts';
import { frase } from '../core/tipos.ts';
import { ultimaActividad } from '../adapters/transcripciones.ts';

/** Más viejo que esto, un número ya no describe la cuota: el mismo umbral que la barra de macOS. */
export const VIEJO_MS = 6 * 3_600_000;

// ── los hechos ───────────────────────────────────────────────────────────

/** Lo que hay guardado para una cuenta, sin red. */
export interface Numero {
  readonly cuenta: string;
  /** Cuándo se midió el número; null si no hay número. */
  readonly medidoMs: number | null;
  readonly origen: string | null;
  /** Cuando no hay número: por qué, y qué hacer. */
  readonly frase: string | null;
  /** La statusline alimenta esta cuenta. Sólo tiene sentido en Claude. */
  readonly statusline: boolean | null;
  /** La escondió el usuario en su config: no es motivo de aviso. */
  readonly oculta: boolean;
  /**
   * Hace mucho que no se usa: `qm` la manda al fondo como dormida, y el
   * veredicto tampoco la reclama. Sin esto, un perfil abandonado hace siete
   * meses salía como «⚠ sin cuota guardada», que es verdad y no le importa a
   * nadie: un aviso que no hay que atender enseña a ignorar los que sí.
   */
  readonly dormida: boolean;
  /** La última actividad local. null si no se pudo medir. */
  readonly ultimoUsoMs: number | null;
}

/** La superficie gráfica de cada plataforma, en lo que el veredicto necesita saber. */
export type Superficie =
  | {
      readonly tipo: 'indicador';
      readonly corriendo: boolean;
      readonly alIniciar: boolean;
      readonly extensionInstalada: boolean;
    }
  | {
      readonly tipo: 'barra';
      readonly compilada: boolean;
      readonly corriendo: boolean;
      /** Los agentes de launchd con plist: los que la arrancan al iniciar sesión. */
      readonly alIniciar: readonly string[];
      readonly brew: boolean;
      /** La última salida de un agente cargado que no está corriendo. */
      readonly ultimaSalida: number | null;
      readonly hayLog: boolean;
    }
  | {
      readonly tipo: 'bandeja';
      /** null: no se pudo correr PowerShell para saberlo. */
      readonly corriendo: boolean | null;
      readonly alIniciar: boolean;
    };

/** Lo que le pasa a la extensión de GNOME, cuando le pasa algo. */
export type FallaExtension = 'sesion-vieja' | 'error' | null;

/** Lo que vio la prueba de red, en lo que el veredicto necesita saber. */
export interface Red {
  readonly host: string;
  /** El primer paso que falló y la causa en palabras; null si llegó hasta el TLS. */
  readonly falla: { readonly paso: Paso; readonly causa: string } | null;
  /** Los firewalls de aplicaciones corriendo; null si no se pudo mirar. */
  readonly firewalls: readonly Firewall[] | null;
}

export interface Hechos {
  readonly extension: FallaExtension;
  readonly superficie: Superficie | null;
  /** null: no se pudieron leer las cuentas, y `errorNumeros` dice por qué. */
  readonly numeros: readonly Numero[] | null;
  readonly errorNumeros?: string;
  /** null o ausente: no se miró la red (`--sin-red`). */
  readonly red?: Red | null;
}

export interface Veredicto {
  /** Algo está roto o a punto de estarlo. Cada uno con su arreglo. */
  readonly avisos: readonly string[];
  /** No está roto, pero conviene saberlo. */
  readonly notas: readonly string[];
}

// ── la conclusión ────────────────────────────────────────────────────────

const hace = (ms: number): string => entorno.duracionCorta(Math.max(0, Math.round(ms / 1000)));

function sobreLaSuperficie(s: Superficie): Veredicto {
  const avisos: string[] = [];
  const notas: string[] = [];
  if (s.tipo === 'indicador') {
    const seEspera = s.alIniciar || s.extensionInstalada;
    if (!s.corriendo && seEspera) {
      avisos.push(tr(
        '⚠ el item de GNOME tendría que estar arriba, pero qm-indicator no está corriendo.\n    → arrancalo: setsid -f qm-indicator',
        '⚠ the GNOME item should be in the top bar, but qm-indicator is not running.\n    → start it: setsid -f qm-indicator',
      ));
    } else if (s.corriendo && !s.alIniciar) {
      notas.push(tr(
        'ℹ qm-indicator está corriendo, pero no vuelve solo después de reiniciar.\n    → qm-indicator --instalar-arranque',
        'ℹ qm-indicator is running, but it won\'t come back after a restart.\n    → qm-indicator --instalar-arranque',
      ));
    }
    return { avisos, notas };
  }

  if (s.tipo === 'barra') {
    const arrancar = s.brew ? 'brew services restart quartermaster' : 'qm-barra';
    if (!s.corriendo && s.alIniciar.length > 0) {
      const salida = s.ultimaSalida !== null && s.ultimaSalida !== 0
        ? tr(` La última vez salió con código ${s.ultimaSalida}.`, ` It last exited with status ${s.ultimaSalida}.`)
        : '';
      const log = s.hayLog ? tr('\n    El log está arriba, en «la barra de menú».', '\n    The log is above, under «the menu bar».') : '';
      avisos.push(tr(
        `⚠ la barra de menú tendría que arrancar al iniciar sesión (${s.alIniciar.join(', ')}), pero no está corriendo.${salida}${log}\n    → arrancala: ${arrancar}`,
        `⚠ the menu bar should start at login (${s.alIniciar.join(', ')}), but it is not running.${salida}${log}\n    → start it: ${arrancar}`,
      ));
    } else if (!s.corriendo && s.compilada) {
      avisos.push(tr(
        '⚠ la barra de menú no está corriendo, y nada la arranca al iniciar sesión.\n    → qm-barra --instalar-arranque   (o: brew services start quartermaster)',
        '⚠ the menu bar is not running, and nothing starts it at login.\n    → qm-barra --instalar-arranque   (or: brew services start quartermaster)',
      ));
    } else if (!s.corriendo) {
      notas.push(tr(
        'ℹ la barra de menú nunca se arrancó en esta máquina: qm-barra la muestra.',
        'ℹ the menu bar has never been started on this machine: qm-barra shows it.',
      ));
    } else if (s.alIniciar.length === 0) {
      notas.push(tr(
        'ℹ la barra de menú está corriendo, pero no vuelve sola después de reiniciar.\n    → qm-barra --instalar-arranque   (o: brew services start quartermaster)',
        'ℹ the menu bar is running, but it won\'t come back after a restart.\n    → qm-barra --instalar-arranque   (or: brew services start quartermaster)',
      ));
    }
    if (s.alIniciar.length > 1) {
      notas.push(tr(
        `ℹ dos agentes la arrancan al iniciar sesión (${s.alIniciar.join(', ')}); con uno alcanza.\n    → qm-barra --sacar-arranque deja sólo el de brew`,
        `ℹ two agents start it at login (${s.alIniciar.join(', ')}); one is enough.\n    → qm-barra --sacar-arranque leaves only brew's`,
      ));
    }
    return { avisos, notas };
  }

  if (s.corriendo === null) {
    notas.push(tr(
      'ℹ no pude correr PowerShell para ver si la bandeja está corriendo.',
      'ℹ couldn\'t run PowerShell to check whether the tray is running.',
    ));
  } else if (!s.corriendo) {
    avisos.push(tr(
      '⚠ la bandeja no está corriendo.\n    → abrí «La bandeja de quartermaster» desde el menú Inicio',
      '⚠ the tray is not running.\n    → open «The quartermaster tray» from the Start menu',
    ));
  }
  if (s.corriendo !== null && !s.alIniciar) {
    notas.push(tr(
      'ℹ la bandeja no arranca sola al iniciar sesión.\n    → volvé a correr el instalador y marcá «Arrancar la bandeja al iniciar sesión»',
      'ℹ the tray does not start when you sign in.\n    → run the installer again and tick «Start the tray when you sign in»',
    ));
  }
  return { avisos, notas };
}

/**
 * La red, cuando no llega. Si hay un firewall de aplicaciones corriendo y lo
 * que falló es la conexión o el TLS, se lo nombra: es lo que costó tres días
 * encontrar. Con el DNS no se lo culpa, porque estos filtran conexiones de
 * programas y el DNS lo resuelve el sistema.
 */
function sobreLaRed(r: Red): Veredicto {
  if (r.falla === null) return { avisos: [], notas: [] };
  const que = tr(`⚠ qm no llega a ${r.host}: ${r.falla.causa}`, `⚠ qm can't reach ${r.host}: ${r.falla.causa}`);
  const culpables = r.falla.paso === 'dns' ? [] : (r.firewalls ?? []);
  if (culpables.length > 0) {
    const nombres = culpables.map((f) => f.nombre);
    const quien = nombres.length === 1
      ? tr(`${nombres[0]} está corriendo: es la causa probable.`, `${nombres[0]} is running: it is the likely cause.`)
      : tr(`${nombres.join(' y ')} están corriendo: uno es la causa probable.`, `${nombres.join(' and ')} are running: one of them is the likely cause.`);
    return { avisos: [`${que}\n    ${quien}\n    ${culpables.map((f) => `→ ${f.arreglo}`).join('\n    ')}`], notas: [] };
  }
  return {
    avisos: [`${que}\n    ${tr(
      '--refrescar y --calentar van a fallar hasta que llegue; los números del disco siguen andando.',
      '--refrescar and --calentar will fail until it can; the numbers on disk still work.',
    )}`],
    notas: [],
  };
}

function sobreLosNumeros(numeros: readonly Numero[], superficieViva: boolean, ahora: number, conRed = true): Veredicto {
  const avisos: string[] = [];
  const notas: string[] = [];
  if (numeros.length === 0) {
    avisos.push(tr(
      '⚠ no encontré ningún perfil de Claude Code ni Codex para este usuario: qm no tiene nada que leer.\n    → ¿Claude Code está instalado y se usó con este mismo usuario?',
      '⚠ found no Claude Code profile and no Codex for this user: qm has nothing to read.\n    → is Claude Code installed, and has it been used by this same user?',
    ));
    return { avisos, notas };
  }
  const visibles = numeros.filter((n) => !n.oculta && !n.dormida);
  for (const n of visibles) {
    if (n.medidoMs === null && n.frase !== null) {
      // Una cuenta paga que no se usa hace semanas no es dormida —puede ser la
      // que estás esperando que se libere—, pero que no tenga número tampoco
      // es una falla: sin uso no hay lectura que guardar. Es una nota.
      const quieta = n.ultimoUsoMs !== null && ahora - n.ultimoUsoMs >= DIAS_DORMIDA * 86_400_000;
      if (quieta) {
        const dias = Math.floor((ahora - n.ultimoUsoMs!) / 86_400_000);
        notas.push(tr(
          `ℹ ${n.cuenta} no tiene número, y no se usa hace ${dias} días.\n    → para tener uno igual: qm --refrescar`,
          `ℹ ${n.cuenta} has no number, and it hasn't been used in ${dias} days.\n    → to get one anyway: qm --refrescar`,
        ));
      } else avisos.push(`⚠ ${n.cuenta}: ${n.frase}`);
    }
  }
  const conNumero = visibles.filter((n) => n.medidoMs !== null);
  if (conNumero.length > 0) {
    const masNuevo = Math.max(...conNumero.map((n) => n.medidoMs!));
    if (ahora - masNuevo > VIEJO_MS) {
      const sinStatusline = conNumero.some((n) => n.statusline === false);
      const como: string[] = [];
      if (sinStatusline) {
        como.push(tr(
          '→ poné `qm --statusline` como statusLine de Claude Code: un número nuevo en cada prompt',
          '→ set `qm --statusline` as Claude Code\'s statusLine: a fresh number on every prompt',
        ));
      }
      if (!superficieViva) {
        como.push(tr(
          '→ o dejá corriendo la superficie de arriba, que refresca sola',
          '→ or keep the surface above running: it refreshes on its own',
        ));
      }
      // Sin red, mandar a --refrescar es mandar a otro «fetch failed»: el
      // aviso de la red ya está arriba.
      if (conRed) como.push(tr('→ para uno ya: qm --refrescar', '→ for one right now: qm --refrescar'));
      avisos.push(tr(
        `⚠ el número más nuevo es de hace ${hace(ahora - masNuevo)}: nada lo está refrescando.\n    ${como.join('\n    ')}`,
        `⚠ the newest number is ${hace(ahora - masNuevo)} old: nothing is refreshing it.\n    ${como.join('\n    ')}`,
      ));
    }
  }
  return { avisos, notas };
}

/**
 * La conclusión, CALCULADA y no insinuada.
 *
 * Es pura a propósito: recibe los hechos ya leídos y no sabe en qué sistema
 * corre. Así las ramas de macOS y Windows se prueban en la CI, que es Linux —
 * que era justamente lo que no se podía hacer cuando la conclusión vivía
 * mezclada con las sondas.
 */
export function concluir(h: Hechos, ahora = Date.now()): Veredicto {
  const avisos: string[] = [];
  const notas: string[] = [];
  // Lo de la extensión es lo más caro de descubrir: va primero. La explicación
  // larga está en su sección; acá, la conclusión y el paso.
  if (h.extension === 'sesion-vieja') {
    avisos.push(tr(
      '⚠ la extensión de GNOME corre un archivo más viejo que el del disco.\n    → cerrá sesión y volvé a entrar',
      '⚠ the GNOME extension is running an older file than the one on disk.\n    → log out and back in',
    ));
  } else if (h.extension === 'error') {
    avisos.push(tr(
      '⚠ la extensión de GNOME está en ERROR con el código que corre ahora: es un bug.\n    → pegá este diagnóstico en un issue',
      '⚠ the GNOME extension is in ERROR with the code running now: it is a bug.\n    → paste this diagnostic into an issue',
    ));
  }

  const superficieViva = h.superficie !== null && h.superficie.corriendo === true;
  if (h.superficie !== null) {
    const s = sobreLaSuperficie(h.superficie);
    avisos.push(...s.avisos);
    notas.push(...s.notas);
  }
  // La red antes que los números: si no llega, es la razón de que estén viejos.
  if (h.red != null) {
    const r = sobreLaRed(h.red);
    avisos.push(...r.avisos);
    notas.push(...r.notas);
  }
  if (h.numeros === null) {
    avisos.push(tr(
      `⚠ no pude leer las cuentas: ${h.errorNumeros ?? '?'}\n    Esto es un bug: pegá este diagnóstico en un issue.`,
      `⚠ couldn't read the accounts: ${h.errorNumeros ?? '?'}\n    This is a bug: paste this diagnostic into an issue.`,
    ));
  } else {
    const n = sobreLosNumeros(h.numeros, superficieViva, ahora, h.red?.falla == null);
    avisos.push(...n.avisos);
    notas.push(...n.notas);
  }
  return { avisos, notas };
}

// ── las sondas que faltaban en el CLI ────────────────────────────────────

/** Lo guardado de cada cuenta, del disco. Nunca tira: si algo falla, lo dice. */
function leerNumeros(): { numeros: Numero[] | null; error?: string } {
  try {
    const cfg = leerConfigUsuario();
    const numeros: Numero[] = [];
    for (const perfil of descubrirPerfiles()) {
      const c = cuotaGuardada(perfil);
      // Sólo con lo que hay en el disco: sin credencial y sin contar requests,
      // que `relevancia()` trata como «no lo medí» y no como cero.
      const ultimoUso = ultimaActividad(perfil);
      const { dormida } = relevancia({
        plan: perfil.cuenta?.plan ?? null,
        ultimoUso,
        requests: null,
        ventanaDias: null,
        credencialVencida: false,
      });
      numeros.push({
        cuenta: perfil.nombre,
        medidoMs: c.estado === 'ok' ? c.medidoEn.getTime() : null,
        origen: c.estado === 'ok' ? c.origen : null,
        frase: c.estado === 'ok' ? null : entorno.redactar(frase(c, entorno.sinCasa(perfil.directorio))),
        statusline: statuslineEnCache(perfil.nombre) !== null,
        oculta: false,
        dormida,
        ultimoUsoMs: ultimoUso?.getTime() ?? null,
      });
    }
    if (hayCodex()) {
      const c = codexEnCache().cuota;
      numeros.push({
        cuenta: 'codex',
        medidoMs: c.estado === 'ok' ? c.medidoEn.getTime() : null,
        origen: c.estado === 'ok' ? c.origen : null,
        frase: c.estado === 'ok' ? null : frase(c, 'codex'),
        statusline: null,
        oculta: false,
        dormida: false,
        ultimoUsoMs: null,
      });
    }
    const visibles = new Set(seleccionar(numeros.map((n) => ({ perfil: { nombre: n.cuenta } })), cfg).filas.map((f) => f.perfil.nombre));
    return { numeros: numeros.map((n) => ({ ...n, oculta: !visibles.has(n.cuenta) })) };
  } catch (e) {
    return { numeros: null, error: entorno.redactar(e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * La lectura del estado de la extensión, en palabras.
 *
 * Existe porque los dos datos que hacen falta —el estado y las dos fechas— por
 * separado no dicen nada a quien no conoce GNOME. Juntos dicen exactamente qué
 * hacer, y es una sola cosa: cerrar sesión.
 */
export function fallaExtension(x: ReturnType<typeof entorno.extension>, e: ReturnType<typeof entorno.escritorio>): FallaExtension {
  if (!x.instalada) return null;
  const enError = 'valor' in x.estado && x.estado.valor.includes('ERROR');
  if (!enError) return null;
  const masNuevaQueLaSesion = x.tocadoMs !== null && e.arrancoMs !== null && x.tocadoMs > e.arrancoMs;
  return masNuevaQueLaSesion ? 'sesion-vieja' : 'error';
}

export function veredictoExtension(x: ReturnType<typeof entorno.extension>, e: ReturnType<typeof entorno.escritorio>): string[] {
  const falla = fallaExtension(x, e);
  if (falla === 'sesion-vieja') {
    const horas = ((x.tocadoMs! - e.arrancoMs!) / 3_600_000).toFixed(1);
    return tr(
      [
        '',
        `  ⚠ extension.js es ${horas} h MÁS NUEVO que la sesión gráfica.`,
        '    El shell carga el módulo una vez y lo deja en memoria: lo que está',
        '    corriendo es el archivo viejo, y el ERROR de arriba es de ESE. En',
        '    Wayland no hay forma de recargarlo —`ReloadExtension` está declarado',
        '    en DBus y devuelve UnknownMethod— así que:',
        '',
        '      → cerrá sesión y volvé a entrar. Es el único paso que falta.',
        '',
        '    Hasta entonces el item lo dibuja AppIndicator y el panel es un menú de',
        '    GTK, que no sostiene el agarre y se cierra apenas lo tocás.',
      ].join('\n'),
      [
        '',
        `  ⚠ extension.js is ${horas} h NEWER than the graphical session.`,
        '    The shell loads the module once and keeps it in memory: what is',
        '    running is the old file, and the ERROR above is from THAT one. On',
        '    Wayland there is no way to reload it —`ReloadExtension` is declared',
        '    on DBus and returns UnknownMethod— so:',
        '',
        '      → log out and back in. It is the only step left.',
        '',
        '    Until then AppIndicator draws the item and the panel is a GTK menu,',
        '    which does not hold the grab and closes as soon as you touch it.',
      ].join('\n'),
    ).split('\n');
  }
  if (falla === 'error') {
    return tr(
      [
        '',
        '  ⚠ la extensión está en ERROR y su archivo NO es más nuevo que la sesión:',
        '    el error de arriba es del código que está corriendo ahora. Esto es un',
        '    bug de verdad — pegá este diagnóstico en un issue.',
      ].join('\n'),
      [
        '',
        '  ⚠ the extension is in ERROR and its file is NOT newer than the session:',
        '    the error above is from the code running right now. This is a real',
        '    bug — paste this diagnostic into an issue.',
      ].join('\n'),
    ).split('\n');
  }
  return [];
}

/** La prueba de red, en los hechos del veredicto: el primer paso que falló, en palabras. */
export function hechosDeRed(sonda: SondaRed, firewalls: readonly Firewall[] | null): Red {
  const fallo = sonda.pasos.find((p) => !p.ok);
  return {
    host: sonda.host,
    falla: fallo === undefined ? null : { paso: fallo.paso, causa: detalleDeRed(fallo.error, sonda.host) },
    firewalls,
  };
}

/** Lo que el informe sale a mirar afuera del disco. Se inyecta para poder probarlo sin red. */
export interface Sondas {
  /** null: no salir a la red (`--sin-red`). */
  readonly red?: ((host: string) => Promise<SondaRed>) | null;
  readonly firewalls?: (host: string) => readonly Firewall[] | null;
}

// ── el informe ───────────────────────────────────────────────────────────

const duracionMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * El orden no es decorativo: arriba va lo que más veces resultó ser la causa, y
 * al final la conclusión, que es lo único que mucha gente va a leer.
 */
export async function diagnostico(
  version: string,
  plataforma: NodeJS.Platform = process.platform,
  sondas: Sondas = {},
): Promise<string> {
  const l: string[] = [];
  const t = entorno.texto;
  const titulo = (s: string) => l.push('', `── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);
  const campo = (k: string, v: string) => l.push(`  ${k.padEnd(18)} ${v.split('\n').join(`\n  ${' '.repeat(19)}`)}`);
  const bloque = (encabezado: string, d: entorno.Dato) => {
    if ('valor' in d) {
      l.push(`  ${encabezado}:`);
      for (const linea of d.valor.split('\n')) l.push(`    ${linea}`);
    } else campo(encabezado, t(d));
  };
  const siNo = (b: boolean) => (b ? tr('sí', 'yes') : 'no');

  l.push(`quartermaster ${version} · ${tr('diagnóstico', 'diagnostic')}`);
  l.push(tr(
    `generado ${new Date().toISOString()} · redactado: sin rutas de casa, sin mails, sin tokens`,
    `generated ${new Date().toISOString()} · redacted: no home paths, no emails, no tokens`,
  ));

  titulo(tr('la máquina', 'the machine'));
  const e = entorno.escritorio();
  campo('node', process.version);
  campo(tr('sistema', 'system'), e.so);
  // El escritorio, la sesión y el shell gráfico son preguntas de Linux: en una
  // Mac o en Windows sólo agregaban «— (vacío)» a un informe que hay que leer.
  if (plataforma === 'linux') {
    campo(tr('escritorio', 'desktop'), t(e.escritorio));
    campo(tr('sesión', 'session'), t(e.sesion));
    campo('shell', t(e.shell).split('\n')[0] ?? '—');
    campo(tr('sesión arrancó', 'session started'), t(e.arrancoLaSesion));
  }

  let extension: FallaExtension = null;
  let superficie: Superficie | null = null;

  if (plataforma === 'linux') {
    titulo(tr('la extensión de GNOME', 'the GNOME extension'));
    const x = entorno.extension();
    campo(tr('instalada', 'installed'), x.instalada ? tr('sí', 'yes') : 'NO');
    campo(tr('estado', 'state'), t(x.estado));
    campo('extension.js', t(x.archivoTocado));
    campo(tr('latido', 'heartbeat'), t(x.latido));
    bloque(tr('último error', 'last error'), x.ultimoError);
    // La conclusión de la extensión se imprime acá, al lado de sus datos —es
    // el caso que costó una tarde— y vuelve a aparecer en el veredicto.
    for (const linea of veredictoExtension(x, e)) l.push(linea);
    extension = fallaExtension(x, e);

    titulo(tr('el indicador', 'the indicator'));
    const ind = entorno.indicador();
    const alIniciar = entorno.indicadorAlIniciar();
    campo(tr('corriendo', 'running'), t(ind));
    campo(tr('al iniciar sesión', 'at login'), siNo(alIniciar));
    superficie = { tipo: 'indicador', corriendo: 'valor' in ind, alIniciar, extensionInstalada: x.instalada };
  } else if (plataforma === 'darwin') {
    titulo(tr('la barra de menú', 'the menu bar'));
    const b = entorno.barraMac();
    campo(tr('binario', 'binary'), b.compilada ? tr(`compilado ${t(b.binario)}`, `built ${t(b.binario)}`) : t(b.binario));
    campo(tr('corriendo', 'running'), t(b.corriendo));
    const conPlist = b.agentes.filter((a) => a.plist);
    for (const a of b.agentes) {
      if (!a.plist && !a.cargado) continue;
      const estado = [
        a.plist ? tr('arranca al iniciar sesión', 'starts at login') : tr('sin plist', 'no plist'),
        a.cargado ? tr('cargado', 'loaded') : tr('no cargado', 'not loaded'),
        ...(a.ultimaSalida !== null ? [tr(`última salida ${a.ultimaSalida}`, `last exit ${a.ultimaSalida}`)] : []),
      ].join(' · ');
      campo(a.etiqueta, estado);
    }
    if (b.agentes.every((a) => !a.plist && !a.cargado)) campo(tr('al iniciar sesión', 'at login'), 'no');
    if (b.rutaLog !== null) bloque(`log (${b.rutaLog})`, b.log);
    else campo('log', t(b.log));
    const caido = b.agentes.find((a) => a.cargado && a.pid === null && a.ultimaSalida !== null);
    superficie = {
      tipo: 'barra',
      compilada: b.compilada,
      corriendo: b.procesos.length > 0,
      alIniciar: conPlist.map((a) => (a.brew ? 'brew services' : a.etiqueta)),
      brew: conPlist.some((a) => a.brew),
      ultimaSalida: caido?.ultimaSalida ?? null,
      hayLog: b.rutaLog !== null && 'valor' in b.log,
    };
  } else if (plataforma === 'win32') {
    titulo(tr('la bandeja', 'the tray'));
    const b = entorno.bandejaWindows();
    campo(tr('corriendo', 'running'), t(b.corriendo));
    campo(tr('al iniciar sesión', 'at sign-in'), siNo(b.alIniciar));
    bloque('log', b.log);
    superficie = { tipo: 'bandeja', corriendo: b.consultada ? b.procesos.length > 0 : null, alIniciar: b.alIniciar };
  }

  titulo(tr('los números', 'the numbers'));
  const { numeros, error } = leerNumeros();
  const ahora = Date.now();
  if (numeros === null) l.push(`  — (${error ?? '?'})`);
  else if (numeros.length === 0) l.push(tr('  (ninguna cuenta)', '  (no accounts)'));
  else {
    for (const n of numeros) {
      const partes: string[] = [];
      if (n.medidoMs !== null) partes.push(`${n.origen} · ${tr(`hace ${hace(ahora - n.medidoMs)}`, `${hace(ahora - n.medidoMs)} ago`)}`);
      else {
        partes.push(tr('sin número', 'no number'));
        if (n.ultimoUsoMs !== null) partes.push(tr(`usada hace ${hace(ahora - n.ultimoUsoMs)}`, `last used ${hace(ahora - n.ultimoUsoMs)} ago`));
      }
      if (n.statusline === false) partes.push(tr('sin statusline', 'no statusline'));
      if (n.oculta) partes.push(tr('oculta por config', 'hidden by config'));
      else if (n.dormida) partes.push(tr('dormida', 'dormant'));
      campo(n.cuenta, partes.join(' · '));
    }
  }

  // La red, después de los números: es lo que explica que uno esté viejo
  // cuando el resto da bien. Se corre acá y no en paralelo con lo de arriba:
  // las sondas de arriba son síncronas, frenan el bucle de eventos, y los
  // límites de tiempo de la prueba vencerían mientras tanto.
  titulo(tr('la red', 'the network'));
  const host = new URL(ENDPOINT).hostname;
  const probar = sondas.red === undefined ? probarRed : sondas.red;
  let red: Red | null = null;
  if (probar === null) l.push(tr('  (no se miró: --sin-red)', '  (not checked: --sin-red)'));
  else {
    // `ps` antes que la sonda y no a la par: es síncrono, y correrlo con el DNS
    // en vuelo le sumaba su tiempo al del DNS.
    const firewalls = (sondas.firewalls ?? ((h: string) => firewallsCorriendo(h, plataforma)))(host);
    const sonda = await probar(host);
    red = hechosDeRed(sonda, firewalls);
    campo('host', `${sonda.host}:${sonda.puerto}`);
    const nombres: Record<Paso, string> = { dns: 'DNS', tcp: 'TCP', tls: 'TLS' };
    for (const paso of ['dns', 'tcp', 'tls'] as const) {
      const p = sonda.pasos.find((x) => x.paso === paso);
      if (p === undefined) campo(nombres[paso], tr('— (no se probó)', '— (not tried)'));
      else if (p.ok) campo(nombres[paso], `✓ ${duracionMs(p.ms)}${p.detalle ? ` · ${p.detalle}` : ''}`);
      else campo(nombres[paso], `✗ ${duracionMs(p.ms)} · ${detalleDeRed(p.error, sonda.host)}`);
    }
    campo(
      tr('firewall', 'app firewall'),
      firewalls === null
        ? tr('— (no se miró)', '— (not checked)')
        : firewalls.length === 0
          ? tr('ninguno conocido corriendo', 'none known running')
          : firewalls.map((f) => f.nombre).join(', '),
    );
  }

  titulo(tr('el cache', 'the cache'));
  for (const c of entorno.cache()) {
    l.push(`  ${c.ruta}${c.nota ? `  (${c.nota})` : ''}`);
    if (c.archivos.length === 0) l.push(tr('    (vacío o inaccesible)', '    (empty or unreachable)'));
    for (const f of c.archivos) l.push(`    ${f.nombre.padEnd(24)} ${f.edad}${f.que ? ` · ${f.que}` : ''}`);
  }

  if (plataforma === 'linux') {
    titulo(tr('lo que anotó el sistema', 'what the system logged'));
    l.push(`  ${t(entorno.journal()).split('\n').join('\n  ')}`);
  }

  titulo(tr('veredicto', 'verdict'));
  const v = concluir({ extension, superficie, numeros, red, ...(error !== undefined ? { errorNumeros: error } : {}) }, ahora);
  for (const linea of [...v.avisos, ...v.notas]) l.push(`  ${linea}`);
  if (v.avisos.length === 0) {
    const cuentan = (numeros ?? []).filter((n) => !n.oculta && !n.dormida);
    const con = cuentan.filter((n) => n.medidoMs !== null);
    const total = cuentan.length;
    const masNuevo = con.length > 0 ? Math.max(...con.map((n) => n.medidoMs!)) : null;
    l.push(tr(
      `  ✓ no encontré nada roto: ${con.length} de ${total} cuenta(s) con número${masNuevo !== null ? `, el más nuevo de hace ${hace(ahora - masNuevo)}` : ''}.`,
      `  ✓ found nothing broken: ${con.length} of ${total} account(s) with a number${masNuevo !== null ? `, the newest ${hace(ahora - masNuevo)} old` : ''}.`,
    ));
  }

  l.push('');
  return `${l.join('\n')}\n`;
}
