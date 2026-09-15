// Qué cuenta importa AHORA, y cuál puede esperar.
//
// EL BUG QUE ORIGINÓ ESTE ARCHIVO. Una cuenta de Codex en plan free, sin usar
// hacía semanas y clavada en 100 %, encabezaba «lo primero que te frena» en
// todas las pantallas. No era un caso raro: era el peor caso de una regla que
// ordenaba SÓLO por porcentaje. Una cuenta muerta en 100 % gana ese título para
// siempre, por construcción, porque 100 es el máximo posible. Mientras tanto la
// cuenta que la persona estaba usando de verdad quedaba en segundo lugar.
//
// Y la información para darse cuenta ya estaba toda calculada. El plan decía
// `free`, el consumo local decía 0 requests en 7 días, la última actividad no
// existía. Los tres se dibujaban en pantalla y ninguno entraba en la decisión.
// La única señal que el código sí consumía —la última actividad— se usaba para
// decidir a quién CONSULTAR, no para decidir qué MOSTRAR PRIMERO.
//
// LO QUE ESTE ARCHIVO NO HACE: esconder. Sigue estando todo, y la razón está en
// SOUL.md — el bug que originó el repo fue un monitor que no veía una cuenta.
// Una cuenta dormida baja al final de la lista y deja de encabezar; no
// desaparece, y dice por qué bajó. Esconder sigue siendo una preferencia
// explícita del usuario, en `config.json`.
//
// EL CRITERIO, Y POR QUÉ NO ALCANZA CON «ESTÁ EN 100 %». Una cuenta agotada que
// SÍ usás es exactamente la que el programa existe para señalar: bajarla sería
// el choque contra el límite que la misión promete evitar. Así que el corte no
// puede ser el número. Hacen falta las dos cosas a la vez:
//
//   1. evidencia de que no se usa, y
//   2. que no haya nada pago esperando del otro lado.
//
// Con las dos, «agotada» y «abandonada» dejan de confundirse. Sin la segunda,
// una cuenta paga que estás esperando que se libere se iría al fondo — y
// enterarte de que se liberó es el aviso más útil que da este programa.

/** Cuántos días sin usarse hacen que una cuenta cuente como quieta. */
export const DIAS_DORMIDA = 7;

/** Lo que hace falta saber de una cuenta para ubicarla. Nada de esto es de un proveedor. */
export interface Señales {
  /** `free`, `team_tier_1`, `max`… tal cual lo reporta el proveedor. null si no lo dice. */
  readonly plan: string | null;
  /** Última actividad local. null si no se pudo medir. */
  readonly ultimoUso: Date | null;
  /** Requests locales en la ventana. null cuando NO se midió (no es lo mismo que 0). */
  readonly requests: number | null;
  /**
   * Cuántos días cubre ese conteo de requests.
   *
   * Va aparte porque el usuario elige la ventana con `--dias`, y «0 requests»
   * dice cosas distintas según cuál sea: en una ventana de un día no es
   * evidencia de abandono, es evidencia de que hoy todavía no la usaste. Sin
   * este dato, un `qm --dias=1` mandaría media máquina al fondo.
   */
  readonly ventanaDias: number | null;
  /** La credencial está vencida: ni siquiera se podría usar ahora mismo. */
  readonly credencialVencida: boolean;
}

export interface Relevancia {
  /** Va al final de la lista y no encabeza el resumen. Nunca se esconde. */
  readonly dormida: boolean;
  /** Por qué, en palabras, para poder mostrarlo al lado. Vacío si no está dormida. */
  readonly porque: readonly string[];
}

const DESPIERTA: Relevancia = { dormida: false, porque: [] };

/** Un plan que no cuesta plata, o que directamente no se informa. */
function sinPagar(plan: string | null): boolean {
  if (plan === null || plan.trim() === '') return true;
  return /^(free|gratis|none|ninguno|anonymous)$/i.test(plan.trim());
}

const dias = (ms: number): number => Math.floor(ms / 86_400_000);

/**
 * Dónde va esta cuenta.
 *
 * `ahora` se inyecta porque una regla que depende del reloj y no lo recibe no
 * se puede probar: el test tendría que esperar siete días.
 */
export function relevancia(s: Señales, diasCorte = DIAS_DORMIDA, ahora = new Date()): Relevancia {
  // ── 1. ¿Hay evidencia de que no se usa? ──────────────────────────────
  //
  // «Evidencia» y «ausencia de dato» no son lo mismo, y confundirlas acá sería
  // grave: en --breve no se leen las transcripciones, así que `requests` llega
  // en null. Tomar eso por «no la usaste» mandaría al fondo a TODAS las cuentas
  // cada vez que la barra sondea. Sin dato, la cuenta se queda donde está.
  let sinUso: string | null = null;

  if (s.requests !== null && s.requests > 0) {
    // La usaste. No hay más que discutir, sin importar qué diga el resto.
    return DESPIERTA;
  }
  if (s.ultimoUso !== null) {
    const d = dias(ahora.getTime() - s.ultimoUso.getTime());
    if (d < diasCorte) return DESPIERTA;
    sinUso = `sin usar hace ${d} día${d === 1 ? '' : 's'}`;
  } else if (s.requests === 0 && s.ventanaDias !== null && s.ventanaDias >= diasCorte) {
    sinUso = `0 requests en ${s.ventanaDias} días`;
  }
  if (sinUso === null) return DESPIERTA;

  // ── 2. ¿Hay algo pago esperando del otro lado? ───────────────────────
  const nadaEnJuego: string[] = [];
  if (sinPagar(s.plan)) nadaEnJuego.push(s.plan === null ? 'sin plan informado' : `plan ${s.plan}`);
  if (s.credencialVencida) nadaEnJuego.push('credencial vencida');

  if (nadaEnJuego.length === 0) return DESPIERTA;
  return { dormida: true, porque: [sinUso, ...nadaEnJuego] };
}

/**
 * Las dormidas al final, y el resto como venía.
 *
 * El orden entre las despiertas NO se toca: es el orden de descubrimiento, y
 * cambiarlo movería cuentas de lugar en la barra por razones que nadie pidió.
 */
export function ordenarPorRelevancia<T>(filas: readonly T[], rel: (f: T) => Relevancia): T[] {
  const despiertas: T[] = [];
  const dormidas: T[] = [];
  for (const f of filas) (rel(f).dormida ? dormidas : despiertas).push(f);
  return [...despiertas, ...dormidas];
}

/**
 * Cuál frena primero, en toda la máquina.
 *
 * Vive acá y no en cada pantalla porque estaba escrita DOS veces —una en
 * TypeScript para la terminal y otra en Python para el panel de GNOME— y las
 * dos decían lo mismo sólo por casualidad. CONTRIBUTING.md lo dice así: una
 * regla que un renderer tiene que reimplementar es un bug del CLI.
 *
 * Si TODAS están dormidas igual se devuelve una. Quedarse sin encabezado
 * tampoco es una respuesta: la pantalla en blanco es el bug original.
 */
export function elQueFrena<T>(
  filas: readonly T[],
  pct: (f: T) => number | null,
  estaDormida: (f: T) => boolean,
): T | null {
  const conNumero = filas.filter((f) => pct(f) !== null);
  const masAlta = (xs: readonly T[]): T | null =>
    xs.reduce<T | null>((a, b) => (a === null || pct(b)! > pct(a)! ? b : a), null);
  return masAlta(conNumero.filter((f) => !estaDormida(f))) ?? masAlta(conNumero);
}
