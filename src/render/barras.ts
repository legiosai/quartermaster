// Todo lo que se imprime pasa por acá. Sin dependencias: una barra es texto.
// (El `import type` de abajo se borra al compilar: no agrega una dependencia
// en runtime, sólo nombra la forma de lo que se rinde.)

import type { EstadoCredencial } from '../core/tipos.ts';

const COLOR = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const c = (codigo: string, texto: string): string => (COLOR ? `\x1b[${codigo}m${texto}\x1b[0m` : texto);
export const tenue = (t: string): string => c('2', t);
export const negrita = (t: string): string => c('1', t);
export const verde = (t: string): string => c('32', t);
export const amarillo = (t: string): string => c('33', t);
export const rojo = (t: string): string => c('31', t);

// Las secuencias de color ocupan bytes pero no columnas. Medir con .length
// desalinea cualquier tabla que pinte una celda, y sólo se ve cuando alguien
// mira la salida en una terminal de verdad.
const ANSI = /\x1b\[[0-9;]*m/g;

/** Ancho en columnas de terminal: el texto sin las secuencias de color. */
export function anchoVisible(texto: string): number {
  return texto.replace(ANSI, '').length;
}

/** Los bloques solos, sin color: para pintarlos en tenue cuando el número ya no vale. */
export function barraSinColor(fraccion: number, ancho = 15): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraccion) ? fraccion : 0));
  const llenos = Math.round(f * ancho);
  return '█'.repeat(llenos) + '░'.repeat(ancho - llenos);
}

/** Barra de bloques. `fraccion` fuera de [0,1] se recorta. */
export function barra(fraccion: number, ancho = 15): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraccion) ? fraccion : 0));
  const cuerpo = barraSinColor(f, ancho);
  if (f >= 0.9) return rojo(cuerpo);
  if (f >= 0.7) return amarillo(cuerpo);
  return verde(cuerpo);
}

/** 1234567 → "1,2M". Los números grandes en tokens no se leen sin esto. */
export function tokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace('.', ',')}G`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.', ',')}k`;
  return String(n);
}

/** Una duración en milisegundos → "2h14m", "38m", "12s". */
export function duracion(ms: number): string {
  if (ms < 0) return 'vencido';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  // Arriba de un día se pasa a días: «213h21m» es un número que hay que
  // dividir a mano para entenderlo, y aparece en cosas como «último uso».
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
  }
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * El estado de una credencial, en una línea.
 *
 * Existe porque el mismo ternario estaba escrito dos veces en `qm.ts` y se
 * estaba por escribir una tercera, y porque tenía dos bordes mal:
 *
 *   · `error` se miraba ANTES que `presente`, así que un adaptador que marcara
 *     «falta el archivo» como error imprimía «ilegible», que afirma algo
 *     distinto y falso: que el archivo está pero no se puede leer.
 *   · `(expiraEn?.getTime() ?? 0) - Date.now()` con `expiraEn` nulo da un
 *     negativo enorme, y `duracion()` lo rinde como «vencido». La línea
 *     resultante era «vigente (vencido)», que se contradice sola. Una
 *     credencial presente y sin fecha es, simplemente, «vigente».
 *
 * `preflight.ts` ya lo hacía bien; esto es esa versión, sin color.
 */
export function veredictoCredencial(cred: EstadoCredencial): string {
  if (cred.error !== null) return `ilegible · ${cred.error}`;
  if (!cred.presente) return 'sin credencial';
  if (cred.vencida) return 'vencida';
  if (cred.expiraEn === null) return 'vigente';
  return `vigente (${duracion(cred.expiraEn.getTime() - Date.now())})`;
}

/**
 * «reinicia en 2h14m» o, cuando ya pasó, «reinició hace 1d9h».
 *
 * «reinicia en vencido» no es castellano, y el indicador de GNOME y la bandeja
 * de Windows ya lo decían bien; la terminal era la única pantalla que seguía
 * imprimiéndolo. Cuando el reinicio ya pasó, se dice que pasó y hace cuánto:
 * eso es lo que le dice al que mira que el porcentaje de al lado es de una
 * ventana que ya cerró.
 */
export function reinicio(ms: number): string {
  return ms < 0 ? `reinició hace ${duracion(-ms)}` : `reinicia en ${duracion(ms)}`;
}

/** Rellena a `ancho` COLUMNAS, no a `ancho` bytes: el color no cuenta. */
export function relleno(texto: string, ancho: number): string {
  const visible = anchoVisible(texto);
  return visible >= ancho ? texto : texto + ' '.repeat(ancho - visible);
}
