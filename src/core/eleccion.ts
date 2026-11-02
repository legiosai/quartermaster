// Cuál perfil de Claude tiene más margen ahora mismo.
//
// Es lo que vuelve útil tener varios perfiles: no alcanza con saber que el
// personal va al 92 % y el de trabajo al 6 %, hay que poder ARRANCAR en el que
// tiene lugar sin mirar la tabla. `qm --mejor` contesta eso con un directorio, y
// `qm --aviso` lo usa para decir a cuál pasarte cuando el tuyo se está por
// llenar.
//
// Es puro a propósito: recibe las candidatas ya leídas y devuelve el orden. La
// lectura —disco, credencial, historial— vive en src/cli/mejor.ts.

import { paraMostrar, peor, sesion, vencida, type ResultadoCuota, type VentanaCuota } from './tipos.ts';
import type { Proyeccion } from './proyeccion.ts';

/** Lo único que importa de la credencial para elegir: si hay sesión. */
export type Credencial = 'vigente' | 'vencida' | 'sin';

export interface Candidata {
  /** `.claude`, `.claude-teams`… */
  readonly nombre: string;
  readonly directorio: string;
  /**
   * El perfil por defecto se arranca SIN `CLAUDE_CONFIG_DIR`. Con la variable
   * puesta, Claude Code lee `<dir>/.claude.json` en vez de `~/.claude.json`, y
   * en macOS deja de mirar el llavero: el mismo directorio es otro perfil.
   */
  readonly porDefecto: boolean;
  readonly credencial: Credencial;
  readonly cuota: ResultadoCuota;
  /** La proyección de `frenaVigente()` de esta cuota. La calcula quien arma la candidata. */
  readonly proyeccion: Proyeccion | null;
}

/**
 * En qué estado queda cada candidata. El orden de la lista es el orden de
 * preferencia: una cuenta con lugar y sin apuro gana siempre.
 *
 * - `libre`: tiene número y a este ritmo no toca el techo antes del reinicio.
 * - `desconocida`: tiene lecturas, pero todas son de ventanas que ya se
 *   reiniciaron. Probablemente esté vacía, pero no se sabe: no es un 0 %.
 * - `choca`: tiene lugar ahora, pero la proyección dice que llega al 100 %
 *   antes de que la ventana se reinicie.
 * - `llena`: la barra que frena ya está en 100 %.
 */
export const NIVELES = ['libre', 'desconocida', 'choca', 'llena'] as const;
export type Nivel = (typeof NIVELES)[number];

export interface Evaluada {
  readonly candidata: Candidata;
  readonly nivel: Nivel;
  /** La barra vigente que más apremia. null en `desconocida`. */
  readonly frena: VentanaCuota | null;
  /** Lo que le queda a esa barra, 0..100. null en `desconocida`. */
  readonly libre: number | null;
  /** La sesión vigente, para desempatar. null si no hay o ya se reinició. */
  readonly sesion: VentanaCuota | null;
}

export interface Descartada {
  readonly nombre: string;
  readonly motivo: string;
}

export interface Eleccion {
  /** La primera de `orden`, o null si no quedó ninguna. */
  readonly elegida: Evaluada | null;
  readonly orden: readonly Evaluada[];
  readonly descartadas: readonly Descartada[];
}

/**
 * La barra que frena, contando sólo las que todavía valen.
 *
 * `peor()` a secas no filtra las vencidas, y tiene sus razones (ver tipos.ts):
 * contesta CUÁL barra importa. Para comparar cuentas la pregunta es otra
 * —cuánto lugar hay AHORA— y el 80 % de una sesión que cerró anteayer no dice
 * nada de eso. Se filtra después de `paraMostrar()`, que ya sacó las barras
 * internas en 0 % sin reinicio que hacían que filtrar saliera mal.
 */
export function frenaVigente(ventanas: readonly VentanaCuota[], ahora = Date.now()): VentanaCuota | null {
  return peor(paraMostrar(ventanas).filter((v) => !vencida(v, ahora)));
}

/** Evalúa una candidata, o dice por qué no entra. */
export function evaluar(c: Candidata, ahora = Date.now()): Evaluada | Descartada {
  // Sin sesión no hay a dónde mandar a nadie: `claude` pediría login. Un token
  // de acceso VENCIDO, en cambio, no descarta: Claude Code lo renueva solo con
  // el refresh token al arrancar, y en esta máquina el de acceso dura ~8 h, así
  // que «vencido» casi siempre quiere decir «hoy no se usó».
  if (c.credencial === 'sin') return { nombre: c.nombre, motivo: 'sin sesión de Claude Code' };
  if (c.cuota.estado !== 'ok') return { nombre: c.nombre, motivo: 'sin cuota guardada para comparar' };

  const vs = c.cuota.ventanas;
  const frena = frenaVigente(vs, ahora);
  const ses = sesion(paraMostrar(vs).filter((v) => !vencida(v, ahora)));
  if (frena === null) return { candidata: c, nivel: 'desconocida', frena: null, libre: null, sesion: ses };

  const libre = Math.max(0, 100 - frena.porcentaje);
  const choca = c.proyeccion?.estado === 'sube' && c.proyeccion.chocas;
  const nivel: Nivel = frena.porcentaje >= 100 ? 'llena' : choca ? 'choca' : 'libre';
  return { candidata: c, nivel, frena, libre, sesion: ses };
}

const esDescartada = (x: Evaluada | Descartada): x is Descartada => 'motivo' in x;

/**
 * El orden de preferencia. Dentro del mismo nivel:
 *
 * - más lugar en la barra que frena;
 * - a igual lugar, la sesión más vacía (una sesión que se reinició cuenta como
 *   vacía: es lo que pasa cuando una ventana cierra);
 * - y entre llenas, la que se reinicia antes, que es la que vuelve primero.
 *
 * El nombre desempata al final para que dos corridas seguidas contesten lo
 * mismo: un script que alterna de perfil por un empate es peor que cualquiera
 * de los dos.
 */
function comparar(a: Evaluada, b: Evaluada): number {
  const na = NIVELES.indexOf(a.nivel);
  const nb = NIVELES.indexOf(b.nivel);
  if (na !== nb) return na - nb;
  if (a.nivel === 'llena') {
    const ra = a.frena?.reinicia?.getTime() ?? Number.POSITIVE_INFINITY;
    const rb = b.frena?.reinicia?.getTime() ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
  }
  const la = a.libre ?? 0;
  const lb = b.libre ?? 0;
  if (la !== lb) return lb - la;
  const sa = a.sesion?.porcentaje ?? 0;
  const sb = b.sesion?.porcentaje ?? 0;
  if (sa !== sb) return sa - sb;
  return a.candidata.nombre.localeCompare(b.candidata.nombre);
}

export function elegir(candidatas: readonly Candidata[], ahora = Date.now()): Eleccion {
  const orden: Evaluada[] = [];
  const descartadas: Descartada[] = [];
  for (const c of candidatas) {
    const e = evaluar(c, ahora);
    if (esDescartada(e)) descartadas.push(e);
    else orden.push(e);
  }
  orden.sort(comparar);
  return { elegida: orden[0] ?? null, orden, descartadas };
}
