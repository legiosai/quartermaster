// Cuándo se le pregunta al endpoint por una cuenta, y cuándo no.
//
// POR QUÉ EXISTE. Medido el 2026-09-14 con la 0.1.9: la barra de macOS le
// preguntaba cada ~2 minutos por las dos cuentas de Claude en uso —la cadencia
// la marcaba Codex, clavado en 100 %, y las cuentas en uso iban de arrastre— y
// el endpoint contestó HTTP 429 durante dos horas y media. El piso de 60 s de
// SOUL.md es por pedido; no decía nada de cuántas veces por cuenta, y no alcanzó.
//
// Vive en el núcleo y la aplica `qm`, no las pantallas: las cuatro calientan
// llamando a `qm --calentar`, así que la regla vale igual para todas sin
// copiarse en Python, Swift, PowerShell y JavaScript.

/** Una lectura propia más nueva que esto no se repite. */
export const MINIMO_POR_CUENTA_MS = 5 * 60_000;
/** Después de un 429, lo mínimo que se espera aunque Retry-After pida menos. */
export const FRENO_MINIMO_MS = 10 * 60_000;
/** Y lo máximo: un Retry-After absurdo no deja una cuenta muda el día entero. */
export const FRENO_MAXIMO_MS = 60 * 60_000;

export interface EstadoCuenta {
  /** Cuándo fue la última lectura del endpoint que guardamos nosotros. */
  readonly ultimaLectura: Date | null;
  /** Los reinicios de las ventanas de esa lectura. */
  readonly reinicios: readonly (Date | null)[];
  /** Hasta cuándo el endpoint pidió que no se pregunte. */
  readonly frenadoHasta: Date | null;
}

export type Decision =
  | { readonly consultar: true }
  | { readonly consultar: false; readonly porque: 'fresca' }
  | { readonly consultar: false; readonly porque: 'frenada'; readonly hasta: Date };

export function decidirConsulta(e: EstadoCuenta, ahora: number): Decision {
  // El freno gana sobre todo: el endpoint ya dijo que no, y preguntar igual es
  // pedir otro 429.
  if (e.frenadoHasta !== null && e.frenadoHasta.getTime() > ahora) {
    return { consultar: false, porque: 'frenada', hasta: e.frenadoHasta };
  }
  if (e.ultimaLectura === null) return { consultar: true };
  const lectura = e.ultimaLectura.getTime();
  if (ahora - lectura >= MINIMO_POR_CUENTA_MS) return { consultar: true };
  // Fresca, salvo que una ventana se haya reiniciado DESPUÉS de leerla: ahí el
  // número es de una ventana que ya cerró.
  const reinicioEnMedio = e.reinicios.some((r) => r !== null && r.getTime() > lectura && r.getTime() <= ahora);
  return reinicioEnMedio ? { consultar: true } : { consultar: false, porque: 'fresca' };
}

/**
 * Hasta cuándo frenar después de un 429. Retry-After puede venir en segundos o
 * como fecha HTTP; si no viene o no se entiende, el mínimo.
 */
export function frenoPor(retryAfter: string | null, ahora: number): Date {
  let espera = FRENO_MINIMO_MS;
  if (retryAfter !== null) {
    const t = retryAfter.trim();
    if (/^\d+$/.test(t)) espera = Number(t) * 1000;
    else {
      const fecha = Date.parse(t);
      if (!Number.isNaN(fecha)) espera = fecha - ahora;
    }
  }
  return new Date(ahora + Math.min(FRENO_MAXIMO_MS, Math.max(FRENO_MINIMO_MS, espera)));
}
