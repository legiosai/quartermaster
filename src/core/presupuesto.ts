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
      /** Puntos que podés gastar en lo que queda de hoy sin salirte de ese ritmo. */
      readonly quedaHoy: number;
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

export function presupuestoDiario(
  ventanas: readonly VentanaCuota[],
  ahora: number = Date.now(),
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
  return {
    estado: 'ok',
    ventana: v,
    porDia,
    quedaHoy: porDia * (horasHoy / 24),
    restante,
    horasRestantes,
    horasHoy,
  };
}

/** «podés gastar 12.3 %/día · hoy te queda 4.1 %». La misma frase en todas las pantallas. */
export function frasePresupuesto(p: Presupuesto): string {
  if (p.estado === 'sin-datos') return `presupuesto diario: ${p.motivo}`;
  return `podés gastar ${p.porDia.toFixed(1)} %/día · hoy te queda ${p.quedaHoy.toFixed(1)} %`;
}
