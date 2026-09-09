// Todo lo que se imprime pasa por acá. Sin dependencias: una barra es texto.

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

/** Barra de bloques. `fraccion` fuera de [0,1] se recorta. */
export function barra(fraccion: number, ancho = 15): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraccion) ? fraccion : 0));
  const llenos = Math.round(f * ancho);
  const cuerpo = '█'.repeat(llenos) + '░'.repeat(ancho - llenos);
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

/** Rellena a `ancho` COLUMNAS, no a `ancho` bytes: el color no cuenta. */
export function relleno(texto: string, ancho: number): string {
  const visible = anchoVisible(texto);
  return visible >= ancho ? texto : texto + ' '.repeat(ancho - visible);
}
