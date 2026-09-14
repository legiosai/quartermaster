// ¿Cuánto puedo gastar por día para que la cuota me dure hasta el reinicio?
//
// El porcentaje contesta «cuánto va»; la proyección contesta «a este ritmo,
// cuándo choco». Falta la pregunta que se hace el que todavía no chocó y quiere
// no chocar: «¿cuánto me puedo gastar hoy?». Un 78 % con reinicio el sábado no
// dice si mañana hay que frenar o si sobra; repartir lo que queda por los días
// que faltan sí lo dice, y en la misma unidad que el resto de la pantalla.
//
// La cuenta es deliberadamente aburrida, y sobre todo es HACIA ADELANTE:
//
//     porDia    = (100 − porcentaje) / días hasta el reinicio
//     quedaHoy  = porDia × (horas que le quedan al día / 24)
//
// Que sea hacia adelante es lo que la hace honesta sin historial: todo lo que
// ya gastaste hoy está adentro del porcentaje actual, así que no hay que
// restarlo —ni ir a buscarlo a un JSONL que puede no cubrir la medianoche—. Si
// te pasaste de rosca a la mañana, `porDia` baja solo en la lectura siguiente y
// `quedaHoy` con él; si no tocaste nada, sube. Nunca da negativo: el piso es
// cero, que es exactamente lo que te podés gastar cuando ya no queda nada.
//
// El reparto es sobre la ventana LARGA, no sobre la que frena. Una ventana de
// 5 h se reinicia cuatro veces por día: «cuánto por día» ahí no quiere decir
// nada, y un número que no quiere decir nada al lado de uno que sí es peor que
// no mostrarlo. Cuando no hay ventana larga, esto devuelve una frase — que es
// la regla de toda la herramienta: el silencio es el bug.

import { semanal, type VentanaCuota } from './tipos.ts';

export type Presupuesto =
  | {
      readonly estado: 'ok';
      /** La ventana que se reparte: la larga. */
      readonly ventana: VentanaCuota;
      /** Puntos de cuota por día, de ahora al reinicio, para llegar justo al 100 %. */
      readonly porDia: number;
      /**
       * Puntos que le tocan a lo que queda de hoy a ritmo parejo.
       *
       * NO es «lo que te queda de la cuota de hoy»: no le resta lo que ya
       * gastaste, porque este número no sabe cuánto gastaste. Baja con el reloj
       * aunque no toques nada. Para lo otro está `gastadoHoy`.
       */
      readonly quedaHoy: number;
      /**
       * Lo que subió la barra desde la medianoche, cuando el historial alcanza
       * para saberlo. `null` es «no se pudo medir», no «no gastaste nada».
       */
      readonly gastadoHoy: number | null;
      /** `porDia − gastadoHoy`, con piso en cero. `null` si no hay `gastadoHoy`. */
      readonly restanteHoy: number | null;
      /**
       * Lo que subió la barra desde `medidoDesde`, que es la medianoche cuando
       * el día está cubierto y la primera lectura de hoy cuando no.
       *
       * Es el número que dibuja el medidor diario de las tres bandejas: el día
       * completo casi nunca está cubierto en una máquina que se apaga de noche,
       * y un medidor que no dibuja nunca no es honesto, es inútil. `null` es
       * «no hay dos lecturas de hoy»: ahí sí no se midió nada.
       */
      readonly gastadoMedido: number | null;
      /** Desde qué instante vale `gastadoMedido`. `null` si no hay medición. */
      readonly medidoDesde: number | null;
      /** Si `gastadoMedido` arranca en la medianoche —o sea, si es el día entero—. */
      readonly cubreElDia: boolean;
      /** Lo que queda en la ventana, en puntos. */
      readonly restante: number;
      /** Horas hasta el reinicio. */
      readonly horasRestantes: number;
      /** Horas que le quedan al día de hoy —o al reinicio, si llega antes—. */
      readonly horasHoy: number;
    }
  | { readonly estado: 'sin-datos'; readonly motivo: string };

/**
 * Menos de una hora para el reinicio y la división explota: repartir 4 puntos
 * en 20 minutos da «288 %/día», que es aritméticamente cierto y no le sirve a
 * nadie. A esa altura la pregunta ya no es cómo dosificar, es cuánto falta —y
 * ésa la contesta el reloj del reinicio, que está al lado.
 */
export const MINIMO_HORAS = 1;

/** La medianoche que viene, en hora local: donde empieza el presupuesto nuevo. */
function finDelDia(ahora: number): number {
  const d = new Date(ahora);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Lo que subió esta barra, y DESDE CUÁNDO se lo puede afirmar.
 *
 * Se suman sólo los saltos HACIA ARRIBA. Una ventana se puede reiniciar en
 * medio del día —pasó el 2026-09-13: una semanal fue de 84 % a 6 % a las pocas
 * horas— y ahí el porcentaje no es monótono. Restar la primera lectura de la
 * última daría −78 puntos, que además de absurdo es la clase de número que se
 * muestra con confianza. Sumando deltas positivos, el reinicio aporta 0 y lo
 * que se gastó después se cuenta igual.
 *
 * `cubreElDia` es lo que separa «gastaste 12 % hoy» de «gastaste 12 % desde las
 * 11:54». La máquina apagada de noche es el caso normal, no la excepción: si la
 * medición parcial no existiera, la cuenta de una portátil que se prende a la
 * mañana sería null TODOS los días y el medidor diario no dibujaría nunca. Una
 * medición que dice desde qué hora vale no es inventar —es exactamente lo que
 * se midió—; lo que no se puede hacer es llamarla «hoy».
 *
 * La línea de base es la última lectura de ayer sólo si está pegada a la
 * medianoche. Si es de hace tres días, el salto entre aquel número y el primero
 * de hoy pasó en algún momento de esos tres días, y cargárselo a hoy es
 * inventar al revés: de más.
 */
export function subidaDeHoy(
  lecturas: readonly { readonly t: number; readonly porcentaje: number }[],
  ahora: number = Date.now(),
): { readonly puntos: number; readonly desde: number; readonly cubreElDia: boolean } | null {
  const d = new Date(ahora);
  const medianoche = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const deHoy = lecturas.filter((l) => l.t >= medianoche && l.t <= ahora).sort((a, b) => a.t - b.t);
  if (deHoy.length < 2) return null;

  const anterior = lecturas.filter((l) => l.t < medianoche).sort((a, b) => a.t - b.t).pop();
  // Sirve de línea de base sólo si viene pegada a la primera de hoy: el hueco
  // entre las dos es tiempo del que no hay nada dicho.
  const pegada = anterior !== undefined && deHoy[0]!.t - anterior.t <= TOLERANCIA_ARRANQUE_MS;
  const base = pegada ? anterior! : deHoy[0]!;
  const cubreElDia = pegada || deHoy[0]!.t - medianoche <= TOLERANCIA_ARRANQUE_MS;

  let subida = 0;
  let previo = base.porcentaje;
  for (const l of deHoy) {
    if (l.porcentaje > previo) subida += l.porcentaje - previo;
    previo = l.porcentaje;
  }
  return {
    puntos: Math.round(subida * 10) / 10,
    desde: cubreElDia ? medianoche : deHoy[0]!.t,
    cubreElDia,
  };
}

/**
 * Lo que subió esta barra desde la medianoche local, o null si el historial no
 * cubre el arranque del día. Es la regla de siempre: lo que no se puede medir
 * es null, no cero. Con una primera lectura a las 03:10 no se sabe qué pasó
 * entre la medianoche y esa hora, y suponer que no pasó nada es inventar.
 *
 * Para lo que sí se midió en ese caso está `subidaDeHoy`, que dice desde qué
 * hora vale.
 */
export function gastadoDesdeMedianoche(
  lecturas: readonly { readonly t: number; readonly porcentaje: number }[],
  ahora: number = Date.now(),
): number | null {
  const s = subidaDeHoy(lecturas, ahora);
  return s === null || !s.cubreElDia ? null : s.puntos;
}

/**
 * Cuánto puede faltar entre la medianoche y la primera lectura del día para
 * seguir dando el total por bueno. Media hora: el sondeo corre cada 5 minutos
 * como mucho, así que un hueco mayor es la máquina apagada o suspendida, y ahí
 * no se sabe qué pasó.
 */
export const TOLERANCIA_ARRANQUE_MS = 30 * 60_000;

export function presupuestoDiario(
  ventanas: readonly VentanaCuota[],
  ahora: number = Date.now(),
  lecturas: readonly { readonly t: number; readonly porcentaje: number }[] = [],
): Presupuesto {
  const v = semanal(ventanas);
  if (v === null) {
    return { estado: 'sin-datos', motivo: 'esta cuenta no informa una ventana larga que repartir' };
  }
  if (v.reinicia === null) {
    return { estado: 'sin-datos', motivo: `${v.clave} no dice cuándo se reinicia` };
  }

  const msRestantes = v.reinicia.getTime() - ahora;
  if (msRestantes <= 0) {
    return { estado: 'sin-datos', motivo: 'la ventana ya se reinició: el número que hay es del período anterior' };
  }
  const horasRestantes = msRestantes / 3600_000;
  if (horasRestantes < MINIMO_HORAS) {
    return { estado: 'sin-datos', motivo: 'la ventana se reinicia en menos de una hora: repartirla por día no dice nada' };
  }

  const restante = Math.max(0, 100 - v.porcentaje);
  const porDia = restante / (horasRestantes / 24);
  // El día se corta donde corte primero: la medianoche o el reinicio.
  const horasHoy = Math.min(finDelDia(ahora) - ahora, msRestantes) / 3600_000;
  const medido = subidaDeHoy(lecturas, ahora);
  const gastadoHoy = medido !== null && medido.cubreElDia ? medido.puntos : null;
  return {
    estado: 'ok',
    ventana: v,
    porDia,
    quedaHoy: porDia * (horasHoy / 24),
    gastadoHoy,
    restanteHoy: gastadoHoy === null ? null : Math.max(0, porDia - gastadoHoy),
    gastadoMedido: medido === null ? null : medido.puntos,
    medidoDesde: medido === null ? null : medido.desde,
    cubreElDia: medido !== null && medido.cubreElDia,
    restante,
    horasRestantes,
    horasHoy,
  };
}

/**
 * La misma frase en todas las pantallas, y dice lo que calcula.
 *
 * Antes decía «hoy te queda 4.1 %» para un número que NO le restaba lo gastado:
 * era el reparto a ritmo parejo de las horas que faltaban del día. Con la
 * cuota quieta bajaba de 10,5 a 0,5 a lo largo del día sin que nadie gastara
 * nada — «te queda» prometía una resta que no ocurría, y siempre para abajo.
 *
 * Ahora hay tres frases porque hay tres cosas distintas:
 *
 *   - con historial que cubra el día: lo gastado y lo que queda DE VERDAD;
 *   - con historial que arranque más tarde: lo mismo, pero diciendo desde qué
 *     hora se lo midió. Una portátil que se prende a las 11 no tiene la mañana
 *     y eso se dice, no se esconde ni se redondea a «hoy»;
 *   - sin ninguna de las dos: el reparto por hora, dicho como lo que es.
 */
export function frasePresupuesto(p: Presupuesto): string {
  if (p.estado === 'sin-datos') return `presupuesto diario: ${p.motivo}`;
  const dia = `podés gastar ${p.porDia.toFixed(1)} %/día`;
  if (p.gastadoHoy !== null && p.restanteHoy !== null) {
    return `${dia} · gastaste ${p.gastadoHoy.toFixed(1)} % hoy · te queda ${p.restanteHoy.toFixed(1)} %`;
  }
  if (p.gastadoMedido !== null && p.medidoDesde !== null) {
    const queda = Math.max(0, p.porDia - p.gastadoMedido);
    return `${dia} · gastaste ${p.gastadoMedido.toFixed(1)} % desde las ${horaCorta(p.medidoDesde)}`
      + ` · te queda ${queda.toFixed(1)} %`;
  }
  return `${dia} · de acá a medianoche te toca ${p.quedaHoy.toFixed(1)} %`;
}

/** La hora local en HH:MM, que es toda la precisión que esta frase necesita. */
export function horaCorta(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
