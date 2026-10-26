// Adónde se va la cuota: el desglose de una ventana de consumo.
//
// `qm` dice cuánto queda; esto dice en qué se gastó. Salió de un análisis
// hecho a mano el 2026-10-26 con tres scripts de Python sobre una semana de
// transcripciones, y se trae acá para poder repetirlo cada semana con un
// comando en vez de con una tarde.
//
// Lo que este archivo sabe es aritmética sobre requests ya leídos. No sabe de
// qué producto vienen, dónde viven ni cómo se deduplican: eso es de los
// adaptadores, que entregan `Uso`s ya limpios.

/**
 * Cuánto pesa cada clase de token, relativo a un token de entrada.
 *
 * Son los precios relativos de la API (lectura de cache 0,1×, escritura de
 * cache 1,25× con TTL de 5 minutos y 2× con TTL de 1 hora, salida 5×). **No son
 * la cuota**: ningún proveedor publica cómo pondera una suscripción. Son la
 * mejor aproximación pública de cuánto drena cada token, y alcanzan para la
 * pregunta que importa — qué parte del gasto es qué — porque esa pregunta es
 * de proporciones, no de valores absolutos.
 */
export const PESOS = {
  entrada: 1,
  escrituraCache5m: 1.25,
  escrituraCache1h: 2,
  lecturaCache: 0.1,
  salida: 5,
} as const;

export type Clase = keyof typeof PESOS;

/** El orden en que se muestran: de la que más suele pesar a la que menos. */
export const CLASES: readonly Clase[] = ['lecturaCache', 'escrituraCache1h', 'escrituraCache5m', 'salida', 'entrada'];

/**
 * Los tramos de tamaño del prompt. El borde de abajo es inclusivo y el de
 * arriba no: 50 000 tokens exactos van a `50–100k`.
 */
export const TRAMOS: readonly { readonly nombre: string; readonly desde: number; readonly hasta: number | null }[] = [
  { nombre: '<50k', desde: 0, hasta: 50_000 },
  { nombre: '50–100k', desde: 50_000, hasta: 100_000 },
  { nombre: '100–200k', desde: 100_000, hasta: 200_000 },
  { nombre: '200–400k', desde: 200_000, hasta: 400_000 },
  { nombre: '400–700k', desde: 400_000, hasta: 700_000 },
  { nombre: '>700k', desde: 700_000, hasta: null },
];

/** Desde acá un contexto es «grande». Es el número que conviene mirar semana a semana. */
export const CONTEXTO_GRANDE = 400_000;

/**
 * Cuánto cache tiene que escribir un request que no es el primero de su hilo
 * para contar como reconstrucción. Debajo de esto es el crecimiento normal de
 * una conversación —el turno nuevo se agrega al cache—; arriba, se reescribió
 * un prefijo que ya estaba.
 */
export const RECONSTRUCCION_MIN = 20_000;

/** Por qué se reconstruyó, según cuánto tiempo pasó desde el request anterior. */
export type Hueco = '>60m' | '5–60m' | 'sin hueco';
export const HUECOS: readonly Hueco[] = ['>60m', '5–60m', 'sin hueco'];

/**
 * Un request, ya deduplicado, como lo entrega un adaptador.
 *
 * `entrada` es SÓLO lo que no salió del cache: la suma de las cuatro de
 * entrada es el tamaño del prompt.
 */
export interface Uso {
  /** La conversación a la que pertenece. Un subagente comparte la de quien lo lanzó. */
  readonly sesion: string;
  /** null en el hilo principal; si no, el tipo de agente (general-purpose, Explore…). */
  readonly agente: string | null;
  /** El directorio de trabajo, tal cual. Redactar es cosa de quien lo muestra. */
  readonly proyecto: string | null;
  /** Epoch en ms. */
  readonly cuando: number;
  /**
   * Cuánto pasó desde el request anterior del MISMO hilo, contado o no. null si
   * es el primero: ese escribe el cache entero porque no había ninguno, y no es
   * una reconstrucción.
   */
  readonly huecoMs: number | null;
  readonly entrada: number;
  readonly lecturaCache: number;
  readonly escrituraCache5m: number;
  readonly escrituraCache1h: number;
  readonly salida: number;
}

export interface Compactacion {
  readonly sesion: string;
  readonly agente: string | null;
  readonly cuando: number;
}

/** Lo que entrega un adaptador para una cuenta y una ventana. */
export interface Registros {
  readonly usos: readonly Uso[];
  readonly compactaciones: readonly Compactacion[];
  /** Cuántos archivos se abrieron. Para el pie, no para la cuenta. */
  readonly archivos: number;
}

export function costo(u: Uso): number {
  return (
    u.entrada * PESOS.entrada +
    u.escrituraCache5m * PESOS.escrituraCache5m +
    u.escrituraCache1h * PESOS.escrituraCache1h +
    u.lecturaCache * PESOS.lecturaCache +
    u.salida * PESOS.salida
  );
}

/** El tamaño del prompt: todo lo que entró, venga o no del cache. */
export function contexto(u: Uso): number {
  return u.entrada + u.escrituraCache5m + u.escrituraCache1h + u.lecturaCache;
}

/** Lo que costó la escritura de cache de un request, y nada más. */
function costoEscritura(u: Uso): number {
  return u.escrituraCache5m * PESOS.escrituraCache5m + u.escrituraCache1h * PESOS.escrituraCache1h;
}

export function tipoHueco(ms: number): Hueco {
  if (ms > 60 * 60_000) return '>60m';
  if (ms > 5 * 60_000) return '5–60m';
  return 'sin hueco';
}

export function tramoDe(tokens: number): string {
  for (const t of TRAMOS) if (t.hasta === null || tokens < t.hasta) return t.nombre;
  return TRAMOS[TRAMOS.length - 1]!.nombre;
}

/** `2026-10-20`, en la hora de la máquina: un día es el del que mira, no el de UTC. */
export function diaLocal(ms: number): string {
  const d = new Date(ms);
  const dos = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

// ─── el resultado ─────────────────────────────────────────────────────────

/** Una porción del total: cuántos requests, cuánto costo, y qué parte del total es. */
export interface Porcion {
  readonly requests: number;
  readonly costo: number;
  /** 0..1 del costo total de la cuenta. 0, y no NaN, si no hubo costo. */
  readonly parte: number;
}

export interface PorClase {
  readonly clase: Clase;
  readonly tokens: number;
  readonly costo: number;
  readonly parte: number;
}

export interface PorTramo extends Porcion {
  readonly tramo: string;
  readonly desde: number;
  readonly hasta: number | null;
}

export interface PorReconstruccion extends Porcion {
  readonly hueco: Hueco;
  readonly hilo: 'principal' | 'subagente';
}

export interface PorAgente extends Porcion {
  /** null es el hilo principal. */
  readonly agente: string | null;
}

export interface PorDia extends Porcion {
  readonly dia: string;
}

export interface PorProyecto extends Porcion {
  readonly proyecto: string | null;
}

export interface Sesion {
  readonly sesion: string;
  readonly proyecto: string | null;
  /** Del hilo principal, dentro de la ventana. */
  readonly requests: number;
  readonly inicio: number | null;
  readonly fin: number | null;
  readonly contextoMax: number | null;
  readonly contextoMediana: number | null;
  readonly compactaciones: number;
  /** Costo del hilo principal. */
  readonly costo: number;
  /** Costo de los subagentes que lanzó. */
  readonly costoSubagentes: number;
  /** De (costo + costoSubagentes) sobre el total de la cuenta. */
  readonly parte: number;
  /** De costoSubagentes sobre el total de la cuenta: la parte de `parte` que fue de subagentes. */
  readonly parteSubagentes: number;
}

export interface Desglose {
  readonly requests: number;
  readonly costo: number;
  readonly porClase: readonly PorClase[];
  readonly porContexto: readonly PorTramo[];
  /** Los requests con prompt de CONTEXTO_GRANDE o más, juntos. */
  readonly contextoGrande: Porcion & { readonly parteRequests: number };
  /** Seis filas siempre (tres huecos × dos hilos), en ese orden, aunque valgan cero. */
  readonly reconstrucciones: readonly PorReconstruccion[];
  readonly reconstruccionesTotal: Porcion;
  /** El principal primero; después los agentes, de más caro a más barato. */
  readonly porAgente: readonly PorAgente[];
  readonly subagentes: Porcion;
  readonly porDia: readonly PorDia[];
  readonly proyectos: readonly PorProyecto[];
  readonly sesiones: readonly Sesion[];
}

const parte = (x: number, total: number): number => (total > 0 ? x / total : 0);

function mediana(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 1 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
}

interface Suma {
  requests: number;
  costo: number;
}
const sumar = (mapa: Map<string, Suma>, clave: string, c: number): void => {
  const s = mapa.get(clave);
  if (s === undefined) mapa.set(clave, { requests: 1, costo: c });
  else {
    s.requests += 1;
    s.costo += c;
  }
};

/**
 * El desglose de una cuenta. `sesiones` y `proyectos` vienen recortados a los
 * más caros; el resto de las listas, enteras.
 */
export function desglosar(
  r: Registros,
  limites: { sesiones?: number; proyectos?: number } = {},
): Desglose {
  const maxSesiones = limites.sesiones ?? 10;
  const maxProyectos = limites.proyectos ?? 10;

  const tokens: Record<Clase, number> = { entrada: 0, escrituraCache5m: 0, escrituraCache1h: 0, lecturaCache: 0, salida: 0 };
  const tramos = new Map<string, Suma>();
  const reconstruccion = new Map<string, Suma>();
  const agentes = new Map<string, Suma>();
  const dias = new Map<string, Suma>();
  const proyectos = new Map<string, Suma & { proyecto: string | null }>();
  const grande: Suma = { requests: 0, costo: 0 };

  interface Acum {
    proyecto: string | null;
    contextos: number[];
    inicio: number | null;
    fin: number | null;
    costo: number;
    costoSubagentes: number;
  }
  const sesiones = new Map<string, Acum>();

  let total = 0;
  for (const u of r.usos) {
    const c = costo(u);
    const ctx = contexto(u);
    total += c;
    for (const k of CLASES) tokens[k] += u[k];

    sumar(tramos, tramoDe(ctx), c);
    if (ctx >= CONTEXTO_GRANDE) {
      grande.requests += 1;
      grande.costo += c;
    }

    const escrita = u.escrituraCache5m + u.escrituraCache1h;
    if (u.huecoMs !== null && escrita > RECONSTRUCCION_MIN) {
      const hilo = u.agente === null ? 'principal' : 'subagente';
      sumar(reconstruccion, `${tipoHueco(u.huecoMs)}|${hilo}`, costoEscritura(u));
    }

    // '' no es un tipo de agente posible: es la clave del hilo principal.
    sumar(agentes, u.agente ?? '', c);
    sumar(dias, diaLocal(u.cuando), c);

    const pk = u.proyecto ?? '';
    const p = proyectos.get(pk);
    if (p === undefined) proyectos.set(pk, { proyecto: u.proyecto, requests: 1, costo: c });
    else {
      p.requests += 1;
      p.costo += c;
    }

    let s = sesiones.get(u.sesion);
    if (s === undefined) {
      s = { proyecto: null, contextos: [], inicio: null, fin: null, costo: 0, costoSubagentes: 0 };
      sesiones.set(u.sesion, s);
    }
    // El proyecto de la sesión es el de su hilo principal; el de un subagente
    // sólo si el principal no dijo ninguno.
    if (u.agente === null) {
      if (u.proyecto !== null && (s.proyecto === null || s.contextos.length === 0)) s.proyecto = u.proyecto;
      s.contextos.push(ctx);
      s.costo += c;
      if (s.inicio === null || u.cuando < s.inicio) s.inicio = u.cuando;
      if (s.fin === null || u.cuando > s.fin) s.fin = u.cuando;
    } else {
      if (s.proyecto === null) s.proyecto = u.proyecto;
      s.costoSubagentes += c;
    }
  }

  const compactaciones = new Map<string, number>();
  for (const k of r.compactaciones) {
    if (k.agente !== null) continue;
    compactaciones.set(k.sesion, (compactaciones.get(k.sesion) ?? 0) + 1);
  }

  const porcion = (s: Suma | undefined): Porcion => ({
    requests: s?.requests ?? 0,
    costo: s?.costo ?? 0,
    parte: parte(s?.costo ?? 0, total),
  });

  const reconstrucciones: PorReconstruccion[] = [];
  for (const hueco of HUECOS) {
    for (const hilo of ['principal', 'subagente'] as const) {
      reconstrucciones.push({ hueco, hilo, ...porcion(reconstruccion.get(`${hueco}|${hilo}`)) });
    }
  }
  const recTotal = reconstrucciones.reduce((a, x) => ({ requests: a.requests + x.requests, costo: a.costo + x.costo }), {
    requests: 0,
    costo: 0,
  });

  const principal = agentes.get('');
  const otros = [...agentes.entries()].filter(([k]) => k !== '').sort((a, b) => b[1].costo - a[1].costo);
  const sub = otros.reduce((a, [, x]) => ({ requests: a.requests + x.requests, costo: a.costo + x.costo }), {
    requests: 0,
    costo: 0,
  });

  return {
    requests: r.usos.length,
    costo: total,
    porClase: CLASES.map((clase) => ({
      clase,
      tokens: tokens[clase],
      costo: tokens[clase] * PESOS[clase],
      parte: parte(tokens[clase] * PESOS[clase], total),
    })),
    porContexto: TRAMOS.map((t) => ({ tramo: t.nombre, desde: t.desde, hasta: t.hasta, ...porcion(tramos.get(t.nombre)) })),
    contextoGrande: { ...porcion(grande), parteRequests: parte(grande.requests, r.usos.length) },
    reconstrucciones,
    reconstruccionesTotal: porcion(recTotal),
    porAgente: [
      ...(principal === undefined ? [] : [{ agente: null, ...porcion(principal) }]),
      ...otros.map(([agente, s]) => ({ agente, ...porcion(s) })),
    ],
    subagentes: porcion(sub),
    porDia: [...dias.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dia, s]) => ({ dia, ...porcion(s) })),
    proyectos: [...proyectos.values()]
      .sort((a, b) => b.costo - a.costo)
      .slice(0, maxProyectos)
      .map((p) => ({ proyecto: p.proyecto, ...porcion(p) })),
    sesiones: [...sesiones.entries()]
      .map(([sesion, s]): Sesion => ({
        sesion,
        proyecto: s.proyecto,
        requests: s.contextos.length,
        inicio: s.inicio,
        fin: s.fin,
        // reduce y no Math.max(...): una sesión larga tiene miles de requests.
        contextoMax: s.contextos.length === 0 ? null : s.contextos.reduce((a, b) => (b > a ? b : a)),
        contextoMediana: mediana(s.contextos),
        compactaciones: compactaciones.get(sesion) ?? 0,
        costo: s.costo,
        costoSubagentes: s.costoSubagentes,
        parte: parte(s.costo + s.costoSubagentes, total),
        parteSubagentes: parte(s.costoSubagentes, total),
      }))
      .sort((a, b) => b.costo + b.costoSubagentes - (a.costo + a.costoSubagentes))
      .slice(0, maxSesiones),
  };
}
