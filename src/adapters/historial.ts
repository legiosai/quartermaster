// Las muestras que hacen posible la proyección.
//
// La cuota es una foto: dice 75 %, no dice a qué velocidad llegaste ahí. Para
// contestar «¿tocás el techo antes del reinicio?» hace falta una serie, y nadie
// la guarda. Así que la guardamos nosotros, en un JSONL en el directorio de
// cache del usuario.
//
// Dos decisiones que importan:
//
//   · Se indexa por `medidoEn` (el fetchedAtMs de la cuota), NO por el momento
//     en que qm miró. Leer diez veces el mismo cache tiene que dejar UNA
//     muestra: si no, la serie se llena de puntos idénticos, la recta se ancla
//     en el instante equivocado y el ritmo sale plano justo cuando más subís.
//   · Es cache, no datos: vive en XDG_CACHE_HOME y se puede borrar sin perder
//     nada más que la proyección de las próximas dos horas.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Muestra } from '../core/proyeccion.ts';

/** Más viejo que esto no lo mira nadie: la ventana de ajuste son 2 h. */
const RETENCION_MS = 24 * 3600_000;

export function directorioCache(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'quartermaster');
}

export function rutaHistorial(): string {
  return join(directorioCache(), 'historial.jsonl');
}

interface Linea {
  readonly p: string; // perfil
  readonly b: string; // barra (clave + alcance)
  readonly t: number; // medidoEn, epoch ms
  readonly v: number; // porcentaje
}

/** La identidad de una barra dentro de un perfil. */
export function claveBarra(clave: string, alcance: string | null): string {
  return alcance === null ? clave : `${clave}:${alcance}`;
}

function leerLineas(): Linea[] {
  const ruta = rutaHistorial();
  if (!existsSync(ruta)) return [];
  let texto: string;
  try {
    texto = readFileSync(ruta, 'utf8');
  } catch {
    return [];
  }
  const out: Linea[] = [];
  for (const linea of texto.split('\n')) {
    if (linea.length === 0) continue;
    try {
      const d = JSON.parse(linea) as Linea;
      if (typeof d.t === 'number' && typeof d.v === 'number' && typeof d.p === 'string') out.push(d);
    } catch {
      // Una línea cortada (apagón a mitad de escritura) no invalida el resto.
    }
  }
  return out;
}

/** Una lectura para anotar. */
export interface Lectura {
  readonly perfil: string;
  readonly barra: string;
  readonly medidoEn: Date;
  readonly porcentaje: number;
}

/**
 * Anota las lecturas que sean nuevas. Devuelve cuántas escribió.
 *
 * Va en lote a propósito: son varias barras por perfil, y una función que
 * releyera el archivo entero por cada barra sería cuadrática en algo que corre
 * cada 60 segundos.
 */
export function anotar(lecturas: readonly Lectura[]): number {
  if (lecturas.length === 0) return 0;
  const previas = leerLineas();
  const vistas = new Set(previas.map((l) => `${l.p}\u0000${l.b}\u0000${l.t}`));

  const nuevas: Linea[] = [];
  for (const l of lecturas) {
    const t = l.medidoEn.getTime();
    const id = `${l.perfil}\u0000${l.barra}\u0000${t}`;
    if (vistas.has(id)) continue;
    vistas.add(id);
    nuevas.push({ p: l.perfil, b: l.barra, t, v: l.porcentaje });
  }
  if (nuevas.length === 0) return 0;

  mkdirSync(directorioCache(), { recursive: true });
  appendFileSync(rutaHistorial(), nuevas.map((l) => `${JSON.stringify(l)}\n`).join(''));

  // Poda barata: sólo cuando el archivo ya creció bastante.
  if (previas.length > 5000) podar(previas.concat(nuevas));
  return nuevas.length;
}

function podar(lineas: readonly Linea[]): void {
  const corte = Date.now() - RETENCION_MS;
  const vivas = lineas.filter((l) => l.t >= corte);
  const tmp = `${rutaHistorial()}.tmp`;
  writeFileSync(tmp, vivas.map((l) => JSON.stringify(l)).join('\n') + (vivas.length ? '\n' : ''));
  renameSync(tmp, rutaHistorial());
}

/** Las muestras de una barra, ordenadas. */
export function muestras(perfil: string, barra: string): Muestra[] {
  return leerLineas()
    .filter((l) => l.p === perfil && l.b === barra)
    .map((l) => ({ t: l.t, porcentaje: l.v }))
    .sort((a, b) => a.t - b.t);
}
