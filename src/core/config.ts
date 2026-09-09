// Qué cuentas mostrar.
//
// La herramienta descubre todo lo que hay en la máquina, y eso está bien: el
// bug original era justamente no ver una cuenta. Pero "descubrir todo" y
// "mostrar todo" no son lo mismo — con cuatro cuentas la barra de menú ya no
// entra, y una cuenta que no usás nunca es ruido permanente.
//
// Se elige por nombre corto (`personal`, `teams`, `codex`) o por el nombre
// completo del perfil. Sin config, se muestran todas: no se esconde nada sin
// que alguien lo pida.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Si está, SÓLO estas. */
  readonly mostrar: string[] | null;
  /** Estas no, aunque existan. */
  readonly ocultar: string[];
}

export const RUTA_CONFIG = join(
  process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'),
  'quartermaster',
  'config.json',
);

export function leerConfigUsuario(): Config {
  try {
    if (!existsSync(RUTA_CONFIG)) return { mostrar: null, ocultar: [] };
    const j = JSON.parse(readFileSync(RUTA_CONFIG, 'utf8')) as Record<string, unknown>;
    const lista = (v: unknown): string[] | null =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
    return { mostrar: lista(j['mostrar']), ocultar: lista(j['ocultar']) ?? [] };
  } catch {
    // Una config rota no puede dejar a nadie sin números: se ignora y se
    // muestran todas, que es el comportamiento por defecto.
    return { mostrar: null, ocultar: [] };
  }
}

/** `.claude-teams` -> `teams`; el perfil por defecto -> `main`. */
export function nombreCorto(nombre: string): string {
  const n = nombre.replace(/^\.claude/, '').replace(/^-/, '');
  return n === '' ? 'main' : n;
}

/** ¿Este nombre está en la lista? Se acepta el corto o el completo. */
function estaEn(lista: readonly string[], nombre: string): boolean {
  const corto = nombreCorto(nombre).toLowerCase();
  return lista.some((x) => {
    const q = x.trim().toLowerCase();
    return q === corto || q === nombre.toLowerCase();
  });
}

/**
 * Aplica la selección. `mostrar` gana sobre `ocultar` cuando está.
 *
 * Si el filtro dejara TODO afuera se devuelve la lista entera: es casi seguro
 * un nombre mal escrito, y quedarse con una pantalla vacía y sin explicación
 * es el bug que este repo existe para no cometer.
 */
export function seleccionar<T extends { perfil: { nombre: string } }>(
  filas: readonly T[],
  cfg: Config,
): { filas: T[]; nota: string | null } {
  let salida = [...filas];
  if (cfg.mostrar !== null) salida = salida.filter((f) => estaEn(cfg.mostrar!, f.perfil.nombre));
  salida = salida.filter((f) => !estaEn(cfg.ocultar, f.perfil.nombre));
  if (salida.length === 0 && filas.length > 0) {
    return {
      filas: [...filas],
      nota: 'el filtro de cuentas no coincidió con ninguna: se muestran todas',
    };
  }
  const escondidas = filas.length - salida.length;
  return { filas: salida, nota: escondidas > 0 ? `${escondidas} cuenta(s) ocultas por config` : null };
}
