// Cuándo avisar adentro de Claude Code, y cuándo ya se avisó.
//
// La misión del repo es que nadie se entere de que se quedó sin cuota chocando
// contra la pared. La barra avisa con una notificación del escritorio; esto
// avisa donde estás mirando: en la sesión de Claude Code, al mandar el prompt.
//
// Avisar en cada prompt sería no avisar: a la tercera vez se deja de leer. Las
// claves siguen las de la barra (`avisados.json`): perfil, barra, minuto del
// reinicio y escalón. El reinicio va en la clave, así que cuando la ventana se
// reinicia la clave cambia sola y el mismo escalón puede volver a sonar.

import { claveVentana, type VentanaCuota } from './tipos.ts';
import type { Proyeccion } from './proyeccion.ts';

export const UMBRAL_POR_DEFECTO = 90;
/** «A este ritmo chocás» sólo suena si el choque es dentro de esta ventana. */
export const ANTICIPO_MS = 30 * 60_000;

/**
 * Los escalones que pueden sonar con un umbral dado. Pasado el umbral, sólo
 * vuelve a sonar al cruzar uno más alto: 95, y 100, que ya no es un aviso
 * sino estar frenado.
 */
export function escalones(umbral: number): number[] {
  return [...new Set([umbral, 95, 100])].filter((u) => u >= umbral).sort((a, b) => a - b);
}

/** El minuto del reinicio, como en la barra: el servidor manda microsegundos distintos en cada lectura. */
function minuto(v: VentanaCuota): string {
  return v.reinicia === null ? 'sin-reinicio' : v.reinicia.toISOString().slice(0, 16);
}

export interface EntradaAviso {
  readonly perfil: string;
  /** La barra vigente que más apremia (`frenaVigente`). */
  readonly frena: VentanaCuota | null;
  readonly proyeccion: Proyeccion | null;
  readonly umbral: number;
  /** Las claves que ya sonaron. */
  readonly avisados: ReadonlySet<string>;
  readonly ahora: number;
}

export interface Decision {
  /** Las claves nuevas que este aviso cubre, para anotarlas. */
  readonly claves: string[];
  readonly frena: VentanaCuota;
  /** El escalón más alto cruzado, o null si suena sólo por la proyección. */
  readonly escalon: number | null;
  /** Cuándo toca el 100 % si la proyección dice que es antes del reinicio y pronto. */
  readonly techo: Date | null;
}

/** null si no hay nada nuevo que decir. */
export function decidirAviso(e: EntradaAviso): Decision | null {
  const v = e.frena;
  if (v === null) return null;
  const base = `${e.perfil}|${claveVentana(v)}|${minuto(v)}`;

  const cruzados = escalones(e.umbral).filter((u) => v.porcentaje >= u);
  const escalon = cruzados.length > 0 ? cruzados[cruzados.length - 1]! : null;

  const p = e.proyeccion;
  const techo =
    p !== null && p.estado === 'sube' && p.chocas && p.techo.getTime() - e.ahora <= ANTICIPO_MS ? p.techo : null;

  const claves: string[] = [];
  // Sólo el escalón más alto: cruzar el 95 sin haber visto el 90 no tiene que
  // dejar el 90 pendiente para el prompt siguiente.
  if (escalon !== null && !e.avisados.has(`${base}|${escalon}`)) {
    claves.push(...cruzados.map((u) => `${base}|${u}`).filter((k) => !e.avisados.has(k)));
  }
  if (techo !== null && !e.avisados.has(`${base}|choque`)) claves.push(`${base}|choque`);
  if (claves.length === 0) return null;
  return { claves, frena: v, escalon, techo };
}

/**
 * Lo que se guarda: lo anterior más lo nuevo, sin las claves de ventanas que se
 * reiniciaron hace más de una semana. Sin poda el archivo crece para siempre;
 * con poda por cantidad se podría olvidar un aviso de la ventana actual.
 */
export function podar(claves: Iterable<string>, ahora: number): string[] {
  const corte = ahora - 8 * 86_400_000;
  return [...new Set(claves)]
    .filter((k) => {
      const m = /\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\|/.exec(k);
      if (m === null) return true;
      const t = Date.parse(`${m[1]}:00.000Z`);
      return Number.isNaN(t) || t >= corte;
    })
    .sort();
}
