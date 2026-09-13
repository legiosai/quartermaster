// Consumo real leído de las transcripciones que Claude Code ya escribe. No
// necesita credenciales, no llama a ninguna API, y funciona igual en los tres
// sistemas operativos. Es el piso: siempre hay número, aunque el token esté
// vencido.
//
// Los registros que importan son los `assistant` con message.usage. Se
// deduplica por requestId porque una sesión reanudada o bifurcada reescribe
// los mismos requests en un archivo nuevo, y contarlos dos veces infla todo.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CONSUMO_VACIO, type Consumo, type Perfil } from '../core/tipos.ts';

interface Acumulador {
  entrada: number;
  creacionCache: number;
  lecturaCache: number;
  salida: number;
  pensamiento: number;
  requests: number;
  porModelo: Map<string, number>;
  primero: Date | null;
  ultimo: Date | null;
}

function nuevoAcumulador(): Acumulador {
  return {
    entrada: 0,
    creacionCache: 0,
    lecturaCache: 0,
    salida: 0,
    pensamiento: 0,
    requests: 0,
    porModelo: new Map(),
    primero: null,
    ultimo: null,
  };
}

/**
 * Cuándo se usó este perfil por última vez, SIN leer una sola línea.
 *
 * Es el mtime más nuevo de sus transcripciones: Claude Code escribe el archivo
 * en cada turno, así que «el archivo cambió» y «la cuenta se usó» son el mismo
 * hecho. La fecha de adentro del transcript diría casi exactamente lo mismo y
 * cuesta parsear todo.
 *
 * Barato a propósito. El consumidor es `qm --breve`, que existe para tardar
 * milisegundos porque corre en una statusline y en el sondeo de la barra: si
 * esto costara lo que cuesta `consumoDesde()`, no podría estar ahí — y ahí es
 * exactamente donde hace falta, porque es la barra la que decide a qué cuenta
 * le pregunta la cuota.
 */
export function ultimaActividad(perfil: Perfil): Date | null {
  let masNuevo = 0;
  for (const archivo of transcripciones(perfil)) {
    try {
      const m = statSync(archivo).mtimeMs;
      if (m > masNuevo) masNuevo = m;
    } catch {
      // un archivo que desaparece entre el listado y el stat no es un error
    }
  }
  return masNuevo === 0 ? null : new Date(masNuevo);
}

/** Todos los .jsonl de un perfil, recursivo. */
export function transcripciones(perfil: Perfil): string[] {
  const raiz = join(perfil.directorio, 'projects');
  if (!existsSync(raiz)) return [];
  const salida: string[] = [];
  const caminar = (dir: string): void => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return;
    }
    for (const entrada of entradas) {
      const ruta = join(dir, entrada);
      let st;
      try {
        st = statSync(ruta);
      } catch {
        continue;
      }
      if (st.isDirectory()) caminar(ruta);
      else if (entrada.endsWith('.jsonl')) salida.push(ruta);
    }
  };
  caminar(raiz);
  return salida;
}

/**
 * Agrega el consumo de un perfil desde `desde` (inclusive).
 *
 * La deduplicación por `requestId` es POR LLAMADA, no entre llamadas: dos
 * ventanas distintas (7 d y 5 h) son dos agregados independientes y el mismo
 * request tiene que contarse en las dos. Lo que no puede pasar —y esto es lo
 * que el set evita— es contarlo dos veces DENTRO de una, que es lo que ocurre
 * cuando una sesión reanudada reescribe sus records en un archivo nuevo.
 */
export async function consumoDesde(perfil: Perfil, desde: Date): Promise<Consumo> {
  const acc = nuevoAcumulador();
  const vistos = new Set<string>();
  const corte = desde.getTime();

  for (const archivo of transcripciones(perfil)) {
    // Si el archivo entero es más viejo que la ventana, no se abre.
    try {
      if (statSync(archivo).mtimeMs < corte) continue;
    } catch {
      continue;
    }
    const rl = createInterface({ input: createReadStream(archivo, 'utf8'), crlfDelay: Infinity });
    for await (const linea of rl) {
      if (linea.length === 0 || !linea.includes('"usage"')) continue;
      let d: Record<string, any>;
      try {
        d = JSON.parse(linea);
      } catch {
        continue;
      }
      if (d['type'] !== 'assistant') continue;
      const uso = d['message']?.['usage'];
      if (!uso) continue;

      const ts = typeof d['timestamp'] === 'string' ? new Date(d['timestamp']) : null;
      if (!ts || Number.isNaN(ts.getTime()) || ts.getTime() < corte) continue;

      const id = typeof d['requestId'] === 'string' ? d['requestId'] : null;
      if (id) {
        if (vistos.has(id)) continue;
        vistos.add(id);
      }

      const entrada = Number(uso['input_tokens'] ?? 0);
      const creacion = Number(uso['cache_creation_input_tokens'] ?? 0);
      const lectura = Number(uso['cache_read_input_tokens'] ?? 0);
      const salida = Number(uso['output_tokens'] ?? 0);
      const pensamiento = Number(uso['output_tokens_details']?.['thinking_tokens'] ?? 0);

      acc.entrada += entrada;
      acc.creacionCache += creacion;
      acc.lecturaCache += lectura;
      acc.salida += salida;
      acc.pensamiento += pensamiento;
      acc.requests += 1;

      const modelo = typeof d['message']?.['model'] === 'string' ? d['message']['model'] : 'desconocido';
      const total = entrada + creacion + lectura + salida;
      acc.porModelo.set(modelo, (acc.porModelo.get(modelo) ?? 0) + total);

      if (!acc.primero || ts < acc.primero) acc.primero = ts;
      if (!acc.ultimo || ts > acc.ultimo) acc.ultimo = ts;
    }
  }

  if (acc.requests === 0) return CONSUMO_VACIO;
  return acc;
}
