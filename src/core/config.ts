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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tr } from './idioma.ts';

/**
 * Cómo se ve el panel de GNOME. `basica` es el panel de siempre; `minimalista`
 * contesta sólo «¿cuánto me queda y cuándo vuelve?» (diseño de @knighthw,
 * issue #27). Lo decide el CLI y lo emite en `qm --json`: el indicador sólo
 * elige qué vista dibujar, como con todo lo demás.
 */
export type Apariencia = 'basica' | 'minimalista';
export const APARIENCIAS: readonly Apariencia[] = ['basica', 'minimalista'];

export function esApariencia(v: unknown): v is Apariencia {
  return typeof v === 'string' && (APARIENCIAS as readonly string[]).includes(v);
}

export interface Config {
  /** Si está, SÓLO estas. */
  readonly mostrar: string[] | null;
  /** Estas no, aunque existan. */
  readonly ocultar: string[];
  /** Sin el campo, o con un valor desconocido, es `basica`: nadie ve un cambio que no pidió. */
  readonly apariencia?: Apariencia;
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
    return {
      mostrar: lista(j['mostrar']),
      ocultar: lista(j['ocultar']) ?? [],
      apariencia: esApariencia(j['apariencia']) ? j['apariencia'] : 'basica',
    };
  } catch {
    // Una config rota no puede dejar a nadie sin números: se ignora y se
    // muestran todas, que es el comportamiento por defecto.
    return { mostrar: null, ocultar: [] };
  }
}

/**
 * Guarda la apariencia en config.json sin tocar el resto del archivo.
 *
 * Es lo primero que ESCRIBE ese archivo: hasta acá sólo se leía, y se edita a
 * mano. Por eso, si lo que hay no es un JSON que se pueda leer, no se pisa — se
 * tira con un motivo. Reemplazar una config rota por `{"apariencia": …}` borraría
 * el `mostrar` y el `ocultar` que alguien escribió y que sólo tienen una coma de
 * más.
 */
export function guardarApariencia(valor: Apariencia, ruta: string = RUTA_CONFIG): void {
  let actual: Record<string, unknown> = {};
  if (existsSync(ruta)) {
    let j: unknown;
    try {
      j = JSON.parse(readFileSync(ruta, 'utf8'));
    } catch (e) {
      throw new Error(tr(
        `${ruta} no es un JSON válido y no lo piso: ${(e as Error).message}`,
        `${ruta} is not valid JSON and I won't overwrite it: ${(e as Error).message}`,
      ));
    }
    if (typeof j !== 'object' || j === null || Array.isArray(j)) {
      throw new Error(tr(`${ruta} no es un objeto JSON y no lo piso`, `${ruta} is not a JSON object and I won't overwrite it`));
    }
    actual = j as Record<string, unknown>;
  }
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, `${JSON.stringify({ ...actual, apariencia: valor }, null, 2)}\n`);
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
 * ¿Esta cuenta está entre las de `--cuentas=`? Con el nombre completo del
 * perfil —lo que manda el indicador de GNOME— o con el corto —lo que manda la
 * barra de macOS, que es el que muestra—. Antes sólo el completo: un calentado
 * filtrado de la barra no le preguntaba a ninguna cuenta de Claude.
 */
export function cuentaPedida(cuentas: ReadonlySet<string>, nombre: string): boolean {
  return estaEn([...cuentas], nombre);
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
      nota: tr('el filtro de cuentas no coincidió con ninguna: se muestran todas', 'the account filter matched none: showing all'),
    };
  }
  const escondidas = filas.length - salida.length;
  return {
    filas: salida,
    nota: escondidas > 0 ? tr(`${escondidas} cuenta(s) ocultas por config`, `${escondidas} account(s) hidden by config`) : null,
  };
}
