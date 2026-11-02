// La cuota que Claude Code le pasa a la statusline, guardada por perfil.
//
// POR QUÉ EXISTE. La primera fuente del repo era `cachedUsageUtilization`, la
// última respuesta de cuota que Claude Code guardaba en el `.claude.json` de
// cada perfil. Dejó de estar: el 2026-11-01, con Claude Code 2.1.316, ninguno
// de los dos perfiles que se usan todos los días en la máquina donde se
// escribió esto lo tenía. El binario todavía sabe escribirlo, pero sólo desde
// el camino que pide la cuota a mano (`/usage`), no en cada uso. Una
// instalación nueva de qm corría `qm` y no mostraba ningún número de Claude.
//
// Lo que sí llega en cada redibujo es la entrada de la statusline. Claude Code
// le pasa por stdin un JSON que trae, para los suscriptores:
//
//   "rate_limits": {
//     "five_hour":   { "used_percentage": 23, "resets_at": 1793580000 },
//     "seven_day":   { "used_percentage": 41, "resets_at": 1794100000 },
//     "spend_limit": { … }          // sólo detrás de un gateway con tope
//   }
//
// Es la cuota de la última respuesta de la API, sin red y sin credencial: la
// promesa del repo, otra vez cumplida, y más fresca que cualquier cache porque
// se renueva con cada prompt.
//
// LO QUE NO TRAE. Sólo las dos barras con nombre. `limits[]` —weekly_scoped y
// las barras sin clave propia— no viene, y esas son justo las que pueden estar
// frenando la cuenta con un 9 % tranquilo en las otras dos (ver SOUL.md, «Read
// every bar the server sends»). Por eso esta lectura no REEMPLAZA a la que ya
// estaba guardada: se le SUPERPONE barra por barra, y cada barra que viene de
// una lectura más vieja lo dice con su propia edad.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parsearUtilizacion } from './utilizacion.ts';
import type { ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

const CACHE = (): string => join(homedir(), '.cache', 'quartermaster', 'statusline.json');

interface Guardado {
  medidoEn: string;
  ventanas: (Omit<VentanaCuota, 'reinicia' | 'medidaEn'> & { reinicia: string | null })[];
}

/**
 * El perfil que está dibujando esta statusline. Claude Code le pasa su entorno
 * al comando, así que `CLAUDE_CONFIG_DIR` es el del perfil que corre; sin esa
 * variable es el perfil por defecto. El nombre es el mismo que da
 * `descubrirPerfiles()`: el último tramo del directorio.
 */
export function perfilDeLaStatusline(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['CLAUDE_CONFIG_DIR'];
  return basename(dir ? resolve(dir) : join(homedir(), '.claude'));
}

/**
 * Las barras de la entrada de una statusline, con los nombres del endpoint.
 *
 * Se mira SÓLO `rate_limits`. El resto de la entrada también tiene campos que
 * se llaman `used_percentage` —el de `context_window`, por ejemplo— y leerlos
 * como cuota pintaría el contexto lleno como una cuenta frenada.
 *
 * `five_hour` pasa a llamarse `session` y `seven_day` `weekly_all`, que es como
 * los nombra `limits[]`. No es cosmética: el historial que alimenta la
 * proyección se indexa por nombre de barra, y con dos nombres para la misma
 * barra la serie se partiría en dos mitades que no llegan a tres lecturas.
 */
export function ventanasDeStatusline(entrada: unknown): VentanaCuota[] {
  if (typeof entrada !== 'object' || entrada === null) return [];
  const rl = (entrada as Record<string, unknown>)['rate_limits'];
  if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) return [];
  return parsearUtilizacion(rl).map((v) => {
    if (v.clave === 'five_hour') return { ...v, clave: 'session', grupo: 'session' };
    if (v.clave === 'seven_day') return { ...v, clave: 'weekly_all', grupo: 'weekly' };
    return v;
  });
}

function leerTodo(): Record<string, Guardado> {
  try {
    return JSON.parse(readFileSync(CACHE(), 'utf8')) as Record<string, Guardado>;
  } catch {
    return {};
  }
}

/**
 * Guarda lo que trajo la statusline para este perfil. Devuelve si había algo
 * que guardar: una entrada sin `rate_limits` (API key, primer prompt, una
 * sesión que todavía no habló con la API) no pisa la lectura anterior.
 */
export function guardarStatusline(perfil: string, entrada: unknown, ahora = new Date()): boolean {
  const ventanas = ventanasDeStatusline(entrada);
  if (ventanas.length === 0) return false;
  try {
    const todo = leerTodo();
    todo[perfil] = {
      medidoEn: ahora.toISOString(),
      ventanas: ventanas.map((v) => ({ ...v, reinicia: v.reinicia?.toISOString() ?? null })),
    };
    mkdirSync(join(homedir(), '.cache', 'quartermaster'), { recursive: true });
    writeFileSync(CACHE(), JSON.stringify(todo));
    return true;
  } catch {
    // Si el cache no es escribible se pierde esta lectura y nada más: la
    // statusline tiene que dibujarse igual.
    return false;
  }
}

export function statuslineEnCache(perfil: string): ResultadoCuota | null {
  const g = leerTodo()[perfil];
  if (g === undefined) return null;
  const medidoEn = new Date(g.medidoEn);
  if (Number.isNaN(medidoEn.getTime()) || !Array.isArray(g.ventanas)) return null;
  return {
    estado: 'ok',
    origen: 'statusline',
    medidoEn,
    ventanas: g.ventanas.map((v) => ({ ...v, reinicia: v.reinicia === null ? null : new Date(v.reinicia) })),
  };
}

/**
 * Qué barra describe cada ventana, con independencia del nombre que traiga.
 * `five_hour` y `session` son la misma; `seven_day` y `weekly_all` también.
 * Una barra con alcance (weekly_scoped de un modelo) nunca es la semanal de
 * todos los modelos, aunque comparta grupo.
 */
function familia(v: VentanaCuota): string {
  if (v.clave === 'five_hour' || v.clave === 'session' || (v.grupo === 'session' && v.alcance === null)) {
    return 'session';
  }
  if (v.clave === 'seven_day' || v.clave === 'weekly_all') return 'weekly_all';
  return `${v.clave}|${v.alcance ?? ''}`;
}

/** El mismo reinicio, con un minuto de holgura: el servidor redondea distinto según la vía. */
function mismaVentana(a: VentanaCuota, b: VentanaCuota): boolean {
  if (a.reinicia === null || b.reinicia === null) return false;
  return Math.abs(a.reinicia.getTime() - b.reinicia.getTime()) < 60_000;
}

/**
 * La lectura guardada, con lo que trajo la statusline encima.
 *
 * Barra por barra gana la medición más nueva. Las barras que sólo una de las
 * dos conoce se quedan, cada una con su edad: la statusline no sabe de
 * `weekly_scoped`, y el endpoint de una cuenta Ultra puede no mandar sesión.
 *
 * `medidoEn` del resultado es el de la lectura más nueva que entró, y `origen`
 * el de esa lectura. Toda barra que venga de una lectura más vieja lleva su
 * propio `medidaEn`: un número de hace dos horas al lado de uno de recién no
 * se puede presentar como si fueran del mismo momento.
 */
export function superponer(base: ResultadoCuota, sensor: ResultadoCuota | null): ResultadoCuota {
  if (sensor === null || sensor.estado !== 'ok' || sensor.ventanas.length === 0) return base;
  if (base.estado !== 'ok') return sensor;

  const sensorGana = sensor.medidoEn.getTime() > base.medidoEn.getTime();
  const nueva = sensorGana ? sensor : base;
  const deSensor = new Map(sensor.ventanas.map((v) => [familia(v), v]));
  const conEdad = (v: VentanaCuota, medida: Date): VentanaCuota =>
    medida.getTime() === nueva.medidoEn.getTime() ? v : { ...v, medidaEn: v.medidaEn ?? medida };

  const ventanas: VentanaCuota[] = [];
  const cubiertas = new Set<string>();
  for (const b of base.ventanas) {
    const f = familia(b);
    cubiertas.add(f);
    const s = deSensor.get(f);
    if (s === undefined || !sensorGana) {
      ventanas.push(conEdad(b, base.medidoEn));
      continue;
    }
    // Se queda con el nombre, el grupo, el alcance y `activa` de la base, que
    // vienen de `limits[]` y la statusline no tiene. La severidad también,
    // salvo que la ventana ya se haya reiniciado: un `warning` de la semana
    // pasada no describe la de ahora.
    ventanas.push({
      ...b,
      porcentaje: s.porcentaje,
      reinicia: s.reinicia ?? b.reinicia,
      severidad: mismaVentana(b, s) && s.porcentaje >= b.porcentaje ? b.severidad : 'normal',
    });
  }
  for (const s of sensor.ventanas) {
    if (cubiertas.has(familia(s))) continue;
    // La sesión va primero, como la ordena el servidor: agregada al final
    // quedaba abajo de las semanales y la tabla se leía al revés.
    if (familia(s) === 'session') ventanas.unshift(conEdad(s, sensor.medidoEn));
    else ventanas.push(conEdad(s, sensor.medidoEn));
  }

  return { estado: 'ok', origen: nueva.origen, medidoEn: nueva.medidoEn, ventanas };
}

/**
 * Lee la entrada de la statusline sin colgarse: si stdin es una terminal no
 * hay nada que leer, y si es un pipe que nunca se cierra se corta a los `ms`.
 * Una statusline que no dibuja porque esperó un stdin es peor que una sin
 * cuota fresca.
 */
export function leerStdin(ms = 500): Promise<string> {
  if (process.stdin.isTTY === true) return Promise.resolve('');
  return new Promise((listo) => {
    let datos = '';
    const fin = (): void => {
      clearTimeout(reloj);
      process.stdin.pause();
      listo(datos);
    };
    const reloj = setTimeout(fin, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      datos += c;
    });
    process.stdin.on('end', fin);
    process.stdin.on('error', fin);
  });
}
