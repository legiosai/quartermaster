// ¿Vas a tocar el techo antes de que la ventana se reinicie?
//
// Es la pregunta que la misión pide contestar y que ni el porcentaje ni el
// consumo contestan por separado. «Vas 75 %» no dice nada sin saber a qué
// velocidad subís; «gastaste 30 M de tokens» tampoco, porque el techo no está
// en tokens.
//
// El método es deliberadamente aburrido: se guardan muestras (instante,
// porcentaje) de cada barra y se ajusta una recta por mínimos cuadrados. La
// pendiente da %/hora, y con eso se proyecta cuándo llega a 100.
//
// Lo importante no es la recta: es cuándo NO se dibuja. Con dos muestras
// pegadas, o con una ventana que recién arranca, cualquier extrapolación es un
// número inventado con cara de dato. Por eso hay mínimos explícitos y el
// resultado tiene un caso 'sin-datos' que el render tiene que saber mostrar.

/** Una lectura de una barra en un instante. */
export interface Muestra {
  /** Epoch en milisegundos. Es el `medidoEn` de la cuota, no el "ahora" de quien mira. */
  readonly t: number;
  readonly porcentaje: number;
}

export type Proyeccion =
  | {
      readonly estado: 'sube';
      /** Puntos porcentuales por hora. */
      readonly ritmo: number;
      /** Cuándo tocaría el 100 %. */
      readonly techo: Date;
      /** true si el techo llega ANTES del reinicio: eso es chocarse la pared. */
      readonly chocas: boolean;
      readonly muestras: number;
    }
  | { readonly estado: 'plano'; readonly muestras: number }
  | { readonly estado: 'sin-datos'; readonly motivo: string };

/** Mínimos para decir algo. Por debajo de esto, la recta es ruido. */
export const MINIMO_MUESTRAS = 3;
export const MINIMO_SPAN_MS = 10 * 60_000;
/** Sólo se mira el pasado reciente: el ritmo de hace 4 h no predice el de ahora. */
export const VENTANA_AJUSTE_MS = 2 * 3600_000;
/**
 * Subida mínima, en puntos, para creerle a la pendiente.
 *
 * El servidor manda porcentajes enteros. Si una barra se movió un punto entre
 * la primera y la última lectura, no hay forma de distinguir un ritmo lento de
 * un redondeo, y extrapolar eso da un techo con cara de dato. Dos puntos es lo
 * mínimo que no puede explicarse sólo por cuantización.
 *
 * A propósito NO es un piso de %/hora: un 0,6 %/h es ruido en una ventana de
 * 5 h y es llegar al techo justo en una de 7 días. El umbral tiene que estar
 * en la resolución del dato, no en la velocidad.
 */
export const SUBIDA_MINIMA_PUNTOS = 2;

/**
 * Ajusta una recta a las muestras recientes y proyecta.
 *
 * `reinicia` es cuándo se reinicia la ventana; si el 100 % cae después de eso,
 * no te chocás: la ventana se vacía antes.
 */
export function proyectar(
  muestras: readonly Muestra[],
  porcentajeActual: number,
  reinicia: Date | null,
  ahora: number = Date.now(),
): Proyeccion {
  const recientes = muestras
    .filter((m) => ahora - m.t <= VENTANA_AJUSTE_MS && m.t <= ahora)
    .sort((a, b) => a.t - b.t);

  if (recientes.length < MINIMO_MUESTRAS) {
    return {
      estado: 'sin-datos',
      motivo: `hacen falta ${MINIMO_MUESTRAS} lecturas y hay ${recientes.length}`,
    };
  }

  const primera = recientes[0]!;
  const ultima = recientes[recientes.length - 1]!;
  const span = ultima.t - primera.t;
  if (span < MINIMO_SPAN_MS) {
    return { estado: 'sin-datos', motivo: 'las lecturas cubren menos de 10 minutos' };
  }

  // Mínimos cuadrados sobre (horas desde la primera, porcentaje).
  const n = recientes.length;
  const xs = recientes.map((m) => (m.t - primera.t) / 3600_000);
  const ys = recientes.map((m) => m.porcentaje);
  const mediaX = xs.reduce((a, b) => a + b, 0) / n;
  const mediaY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mediaX;
    num += dx * (ys[i]! - mediaY);
    den += dx * dx;
  }
  if (den === 0) return { estado: 'sin-datos', motivo: 'todas las lecturas son del mismo instante' };

  const ritmo = num / den;
  const subida = ultima.porcentaje - primera.porcentaje;
  if (ritmo <= 0 || subida < SUBIDA_MINIMA_PUNTOS) return { estado: 'plano', muestras: n };

  const faltan = 100 - porcentajeActual;
  if (faltan <= 0) {
    return { estado: 'sube', ritmo, techo: new Date(ahora), chocas: true, muestras: n };
  }
  const techo = new Date(ahora + (faltan / ritmo) * 3600_000);
  const chocas = reinicia === null || techo.getTime() < reinicia.getTime();
  return { estado: 'sube', ritmo, techo, chocas, muestras: n };
}
