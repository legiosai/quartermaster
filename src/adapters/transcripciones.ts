// Consumo real leído de las transcripciones que Claude Code ya escribe. No
// necesita credenciales, no llama a ninguna API, y funciona igual en los tres
// sistemas operativos. Es el piso: siempre hay número, aunque el token esté
// vencido.
//
// Los registros que importan son los `assistant` con message.usage. Se
// deduplica por requestId porque una sesión reanudada o bifurcada reescribe
// los mismos requests en un archivo nuevo, y contarlos dos veces infla todo.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, sep } from 'node:path';
import { CONSUMO_VACIO, type Consumo, type Perfil } from '../core/tipos.ts';
import type { Compactacion, Registros, Uso } from '../core/desglose.ts';
import { lineasCon } from './lineas.ts';

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

// ─── el desglose ──────────────────────────────────────────────────────────
// `consumoDesde()` suma; esto entrega cada request por separado, con lo que el
// núcleo necesita para repartirlo: de qué hilo es, cuánto pasó desde el
// anterior, y cuánto del cache se escribió con cada TTL.

/** Las dos marcas de las líneas que importan. Las demás no se decodifican. */
const MARCAS_DESGLOSE = ['"usage"', '"compact_boundary"'];

/**
 * De qué hilo es un archivo, leído de su ruta.
 *
 * Claude Code guarda el hilo principal en `<proyecto>/<sesion>.jsonl` y cada
 * subagente en `<proyecto>/<sesion>/subagents/agent-<id>.jsonl`, con el tipo
 * de agente al lado en `agent-<id>.meta.json`. La sesión del subagente es la
 * del directorio que lo contiene: así su costo se le suma a quien lo lanzó.
 */
export function hiloDe(archivo: string): { sesion: string; agente: string | null } {
  const dir = dirname(archivo);
  if (basename(dir) === 'subagents' && basename(archivo).startsWith('agent-')) {
    let agente = 'desconocido';
    try {
      const meta = JSON.parse(readFileSync(archivo.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as Record<string, unknown>;
      if (typeof meta['agentType'] === 'string' && meta['agentType'] !== '') agente = meta['agentType'];
    } catch {
      // Sin meta el request se cuenta igual, como subagente de tipo desconocido.
    }
    return { sesion: basename(dirname(dir)), agente };
  }
  return { sesion: basename(archivo, '.jsonl'), agente: null };
}

const numero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Cada request de un perfil desde `desde`, listo para `desglosar()`.
 *
 * Tres decisiones que no se ven en el resultado:
 *
 *   · **Se deduplica por (message.id, requestId).** Un mensaje con varios
 *     bloques de contenido se escribe una vez por bloque, con el MISMO usage
 *     en cada copia: medido el 2026-10-26, 36 000 líneas con `"usage"` para
 *     16 000 requests distintos. Y una sesión reanudada reescribe los suyos en
 *     otro archivo, así que el set es por perfil, no por archivo.
 *   · **El hueco se mide contra el request anterior del mismo archivo, aunque
 *     ese esté fuera de la ventana o sea una copia.** Es el tiempo que el
 *     cache estuvo quieto, y el cache no sabe de ventanas.
 *   · **`<synthetic>` no es un request**: es un mensaje que Claude Code arma
 *     sin llamar a la API (un error, una interrupción), y su usage es cero.
 */
export function usosDesde(perfil: Perfil, desde: Date): Registros {
  const corte = desde.getTime();
  const raiz = join(perfil.directorio, 'projects');
  const usos: Uso[] = [];
  const compactaciones: Compactacion[] = [];
  const vistos = new Set<string>();
  let archivos = 0;

  // Los hilos principales primero. Un fork arranca con una copia de los
  // requests de quien lo lanzó, y el set de deduplicación se queda con la
  // primera que ve: si el fork llegara antes, esos requests se le cobrarían a
  // él y no a la sesión que los hizo. Medido el 2026-10-26 en dos cuentas: 32
  // de 783 requests de `fork` en una semana eran copias del hilo principal.
  //
  // Y el filtro por fecha va antes que `hiloDe()`: el .meta.json de un
  // subagente de hace un mes no hace falta abrirlo.
  const hilos = transcripciones(perfil)
    .filter((archivo) => {
      try {
        return statSync(archivo).mtimeMs >= corte;
      } catch {
        return false;
      }
    })
    .map((archivo) => ({ archivo, ...hiloDe(archivo) }))
    .sort((a, b) => Number(a.agente !== null) - Number(b.agente !== null));

  for (const { archivo, sesion, agente } of hilos) {
    archivos += 1;
    // El nombre codificado del directorio, por si ningún record trae `cwd`.
    const carpeta = relative(raiz, archivo).split(sep)[0] ?? null;
    let previo: number | null = null;

    for (const linea of lineasCon(archivo, MARCAS_DESGLOSE)) {
      let d: Record<string, any>;
      try {
        d = JSON.parse(linea);
      } catch {
        continue;
      }
      const cuando = typeof d['timestamp'] === 'string' ? Date.parse(d['timestamp']) : NaN;
      if (Number.isNaN(cuando)) continue;

      if (d['type'] === 'system' && d['subtype'] === 'compact_boundary') {
        if (cuando >= corte) compactaciones.push({ sesion, agente, cuando });
        continue;
      }
      if (d['type'] !== 'assistant') continue;
      const m = d['message'];
      const uso = m?.['usage'];
      if (!uso || m['model'] === '<synthetic>') continue;

      const id = typeof m['id'] === 'string' ? m['id'] : '';
      const req = typeof d['requestId'] === 'string' ? d['requestId'] : '';
      const clave = id === '' && req === '' ? null : `${id}|${req}`;

      // Una copia también mueve el reloj: tiene la hora del mismo request, así
      // que el hueco hasta el siguiente sale igual. Lo que no hace es contarse.
      const huecoMs = previo === null ? null : Math.max(0, cuando - previo);
      previo = cuando;
      if (cuando < corte) continue;
      if (clave !== null) {
        if (vistos.has(clave)) continue;
        vistos.add(clave);
      }

      // El TTL de lo escrito viene desglosado en `cache_creation`. Si falta, o
      // no suma lo mismo que el total, la diferencia va a 5 m, que es el TTL
      // por defecto de la API.
      const escrita = numero(uso['cache_creation_input_tokens']);
      const cc = uso['cache_creation'] ?? {};
      const de1h = Math.min(escrita, numero(cc['ephemeral_1h_input_tokens']));
      const de5m = escrita - de1h;

      usos.push({
        sesion,
        agente,
        proyecto: typeof d['cwd'] === 'string' && d['cwd'] !== '' ? d['cwd'] : carpeta,
        cuando,
        huecoMs,
        entrada: numero(uso['input_tokens']),
        lecturaCache: numero(uso['cache_read_input_tokens']),
        escrituraCache5m: de5m,
        escrituraCache1h: de1h,
        salida: numero(uso['output_tokens']),
      });
    }
  }
  return { usos, compactaciones, archivos };
}
