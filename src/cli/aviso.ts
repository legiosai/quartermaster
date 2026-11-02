// qm --aviso: el hook de UserPromptSubmit que avisa antes de la pared.
//
// En el settings.json del perfil:
//
//   "hooks": { "UserPromptSubmit": [{ "hooks": [
//     { "type": "command", "command": "qm --aviso" } ] }] }
//
// EL CONTRATO, leído en el binario de Claude Code 2.1.316. El hook recibe por
// stdin `{session_id, transcript_path, cwd, hook_event_name:
// "UserPromptSubmit", prompt, source, …}` y puede devolver por stdout un JSON
// con `systemMessage` —«Display a message to the user (all hooks)»—,
// `continue`, `suppressOutput`, `decision`, `reason` y `hookSpecificOutput`.
// Lo que va en `hookSpecificOutput.additionalContext`, o el texto pelado en
// stdout, le llega AL MODELO. El aviso es para vos, no para Claude: va sólo en
// `systemMessage`, nunca se bloquea el prompt y siempre se sale con 0.
//
// Sólo disco: la cuota que dejó la statusline, el endpoint o Claude Code, sin
// red y sin transcripciones. Corre en cada prompt.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cuotaGuardada, proyeccionDe } from '../adapters/cuota-guardada.ts';
import { directorioCache } from '../adapters/historial.ts';
import { leerStdin, perfilDeLaStatusline } from '../adapters/statusline.ts';
import { decidirAviso, podar, UMBRAL_POR_DEFECTO, type Decision } from '../core/aviso.ts';
import { nombreCorto, type Config } from '../core/config.ts';
import { elegir, frenaVigente, type Evaluada } from '../core/eleccion.ts';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { nombreVentana } from '../core/tipos.ts';
import { duracion } from '../render/barras.ts';
import { candidata, comoArrancar, perfilesVisibles } from './mejor.ts';
import { tr } from '../core/idioma.ts';

/**
 * Su propia memoria, con las claves de la barra. No comparte `avisados.json` a
 * propósito: que la barra haya mandado una notificación del escritorio no
 * quiere decir que la viste, y este canal es el que está adelante tuyo.
 */
const MEMORIA = (): string => join(directorioCache(), 'avisos-claude-code.json');

function leerMemoria(): Set<string> {
  try {
    const crudo = JSON.parse(readFileSync(MEMORIA(), 'utf8')) as unknown;
    return new Set(Array.isArray(crudo) ? crudo.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function guardarMemoria(claves: string[]): void {
  try {
    if (!existsSync(directorioCache())) mkdirSync(directorioCache(), { recursive: true });
    writeFileSync(MEMORIA(), JSON.stringify(claves));
  } catch {
    // Sin memoria se avisa de más, no de menos.
  }
}

export function umbralDe(argv: readonly string[]): number {
  const a = argv.find((x) => x.startsWith('--umbral='));
  const n = a === undefined ? Number.NaN : Number(a.slice('--umbral='.length));
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : UMBRAL_POR_DEFECTO;
}

const pct = (n: number): string => `${Math.round(n)} %`;

/** El renglón que ve el usuario. Puro salvo por el reloj que recibe. */
export function mensajeAviso(perfil: string, d: Decision, alternativa: Evaluada | null, ahora: number): string {
  const v = d.frena;
  const falta = v.reinicia === null ? null : v.reinicia.getTime() - ahora;
  const hay = falta !== null && falta > 0;
  const en = hay ? duracion(falta) : '';
  let texto = tr(
    `qm · ${nombreCorto(perfil)}: ${nombreVentana(v)} al ${pct(v.porcentaje)}`,
    `qm · ${nombreCorto(perfil)}: ${nombreVentana(v)} at ${pct(v.porcentaje)}`,
  );
  if (v.porcentaje >= 100) {
    texto += tr(` — frenada hasta que se reinicie${hay ? `, en ${en}` : ''}`, ` — stopped until it resets${hay ? `, in ${en}` : ''}`);
  } else if (d.techo !== null) {
    const choque = duracion(Math.max(0, d.techo.getTime() - ahora));
    texto += tr(
      ` — a este ritmo llegás al 100 % en ${choque}, antes de que se reinicie${hay ? ` (en ${en})` : ''}`,
      ` — at this pace you hit 100 % in ${choque}, before it resets${hay ? ` (in ${en})` : ''}`,
    );
  } else if (hay) {
    texto += tr(` · se reinicia en ${en}`, ` · resets in ${en}`);
  }
  // Sólo se sugiere una cuenta que de verdad tenga más lugar y no vaya a
  // chocar: mandar a alguien a otra que también está por llenarse es ruido.
  if (alternativa !== null && alternativa.nivel === 'libre' && alternativa.libre !== null) {
    const queda = Math.max(0, 100 - v.porcentaje);
    if (alternativa.libre > queda) {
      const otra = nombreCorto(alternativa.candidata.nombre);
      const libre = pct(alternativa.libre);
      const como = comoArrancar(alternativa.candidata);
      texto += tr(`. ${otra} tiene ${libre} libre: ${como}`, `. ${otra} has ${libre} free: ${como}`);
    }
  }
  return texto;
}

export async function correrAviso(cfg: Config, argv: readonly string[]): Promise<number> {
  try {
    // El JSON del hook no hace falta —el perfil sale de CLAUDE_CONFIG_DIR—,
    // pero se consume igual: un pipe sin leer puede dejar a Claude Code
    // esperando que lo tomemos.
    await leerStdin();
    const ahora = Date.now();
    const nombre = perfilDeLaStatusline();
    // El perfil actual se mira aunque la configuración lo esconda: esconderlo
    // de la tabla no es lo mismo que no querer saber que se te acaba.
    const actual = descubrirPerfiles().find((p) => p.nombre === nombre);
    if (actual === undefined) return 0;
    const cuota = cuotaGuardada(actual);
    if (cuota.estado !== 'ok') return 0;

    const frena = frenaVigente(cuota.ventanas, ahora);
    const memoria = leerMemoria();
    const d = decidirAviso({
      perfil: actual.nombre,
      frena,
      proyeccion: proyeccionDe(actual.nombre, frena, ahora),
      umbral: umbralDe(argv),
      avisados: memoria,
      ahora,
    });
    if (d === null) return 0;

    // Las otras cuentas se leen sólo cuando hay algo que decir: el caso de
    // siempre —todo bien— no paga ni una credencial más.
    const otras = perfilesVisibles(cfg)
      .filter((p) => p.nombre !== actual.nombre)
      .map((p) => candidata(p, ahora));
    const alternativa = elegir(otras, ahora).elegida;

    guardarMemoria(podar([...memoria, ...d.claves], ahora));
    process.stdout.write(
      `${JSON.stringify({ systemMessage: mensajeAviso(actual.nombre, d, alternativa, ahora), suppressOutput: true })}\n`,
    );
  } catch {
    // Un hook que revienta le muestra un error a quien está por mandar un
    // prompt. Nada de esto vale eso.
  }
  return 0;
}
