// La pregunta de la barra de menú, en la primera corrida de `qm` en una Mac.
//
// POR QUÉ EXISTE. La barra es el punto entero del programa y ninguna vía de
// instalación la puede mostrar sola: `brew install` corre en un sandbox que no
// deja escribir en ~/Library ni en ~/.cache, y el postinstall de npm dejó de
// registrar el LaunchAgent a propósito (ver scripts/instalar-barra.mjs: un
// paquete que lee tokens OAuth no registra agentes que nadie pidió). Así que
// quedaba a un comando que había que leer en un caveat — y nadie lo lee.
//
// La salida es preguntar. Una vez, en una terminal, después de mostrar los
// números: quien acaba de instalar ve la pregunta en el primer `qm`, y el
// consentimiento es explícito, que es lo que el postinstall no tenía.
//
// Nunca pregunta donde una pregunta rompe algo: --json, --breve, --watch y
// --umbral los leen scripts y statuslines, y sin terminal el proceso quedaría
// colgado esperando una respuesta que no va a llegar.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { RUTA_CONFIG } from '../core/config.ts';

/** Lo que hace falta saber de la máquina para decidir si se pregunta. */
export interface Situacion {
  readonly plataforma: string;
  /** stdin y stdout son una terminal: hay alguien para contestar. */
  readonly terminal: boolean;
  readonly ci: boolean;
  /** `qm` a secas, sin --json, --breve, --watch ni --umbral. */
  readonly modoNormal: boolean;
  readonly yaPreguntado: boolean;
  /** Existe bin/qm-barra al lado de este paquete. */
  readonly hayBarra: boolean;
  /** Las Command Line Tools: sin swiftc la barra no compila. */
  readonly compilador: boolean;
  readonly arranqueInstalado: boolean;
  readonly corriendo: boolean;
}

export function debeOfrecer(s: Situacion): boolean {
  return (
    s.plataforma === 'darwin' &&
    s.terminal &&
    !s.ci &&
    s.modoNormal &&
    !s.yaPreguntado &&
    s.hayBarra &&
    s.compilador &&
    !s.arranqueInstalado &&
    !s.corriendo
  );
}

export type Arranque =
  | { readonly via: 'brew'; readonly brew: string; readonly lanzador: string }
  | { readonly via: 'lanzador'; readonly lanzador: string };

/**
 * Por dónde se arranca, según dónde vive el paquete.
 *
 * En brew, `qm` corre desde `<prefijo>/Cellar/quartermaster/<versión>/libexec`.
 * El plist que escribe `qm-barra --instalar-arranque` apunta a la ruta del
 * lanzador, y esa lleva la versión adentro: el primer `brew upgrade` la borra y
 * la barra deja de arrancar sin decir nada. Por eso ahí va `brew services`, que
 * usa la ruta `opt/` estable. El lanzador por `opt/` queda de repuesto para una
 * fórmula instalada antes de que tuviera el bloque `service`.
 */
export function comoArrancar(raiz: string): Arranque {
  const cellar = /^(.*)\/Cellar\/quartermaster\/[^/]+\/libexec\/?$/.exec(raiz);
  if (cellar !== null) {
    const prefijo = cellar[1]!;
    return {
      via: 'brew',
      brew: join(prefijo, 'bin', 'brew'),
      lanzador: join(prefijo, 'opt', 'quartermaster', 'libexec', 'bin', 'qm-barra'),
    };
  }
  return { via: 'lanzador', lanzador: join(raiz, 'bin', 'qm-barra') };
}

/** Dónde queda anotado que ya se preguntó. Es config, no cache: no se borra sola. */
const RUTA_RESPUESTA = join(dirname(RUTA_CONFIG), 'barra-ofrecida.json');

/** Los tres agentes que pueden estar arrancando la barra: el propio y los de brew. */
const AGENTES = [
  'com.legios.quartermaster.barra.plist',
  'sh.brew.quartermaster.plist',
  'homebrew.mxcl.quartermaster.plist',
].map((f) => join(homedir(), 'Library', 'LaunchAgents', f));

function sale0(cmd: string, args: readonly string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

const corriendo = (): boolean => sale0('pgrep', ['-f', 'quartermaster/qm-barra']);

export function situacionActual(raiz: string, modoNormal: boolean): Situacion {
  const darwin = process.platform === 'darwin';
  return {
    plataforma: process.platform,
    terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ci: Boolean(process.env['CI']),
    modoNormal,
    yaPreguntado: existsSync(RUTA_RESPUESTA),
    hayBarra: existsSync(join(raiz, 'bin', 'qm-barra')),
    // Lo caro va al final y sólo en macOS: en Linux esto no corre ni un proceso.
    compilador: darwin && sale0('xcode-select', ['-p']),
    arranqueInstalado: darwin && AGENTES.some((a) => existsSync(a)),
    corriendo: darwin && corriendo(),
  };
}

function anotar(respuesta: 'si' | 'no'): void {
  try {
    mkdirSync(dirname(RUTA_RESPUESTA), { recursive: true });
    writeFileSync(RUTA_RESPUESTA, `${JSON.stringify({ respuesta, cuando: new Date().toISOString() })}\n`);
  } catch {
    // Sin poder anotarlo se vuelve a preguntar la próxima vez. Molesta, pero no
    // deja a nadie sin números.
  }
}

/** Arranca la barra y que arranque sola al iniciar sesión. Devuelve si se pudo pedir. */
function arrancar(a: Arranque): boolean {
  if (a.via === 'brew' && sale0(a.brew, ['services', 'start', 'quartermaster'])) return true;
  // `brew services` falla si la fórmula instalada es anterior al bloque
  // `service`: ahí va el lanzador por la ruta opt/, que sobrevive a un upgrade.
  return existsSync(a.lanzador) && sale0(a.lanzador, ['--instalar-arranque']);
}

/**
 * La pregunta, si corresponde. Nunca tira y nunca cambia el código de salida de
 * `qm`: es un ofrecimiento, no parte de la respuesta.
 */
export async function ofrecerBarra(raiz: string, modoNormal: boolean): Promise<void> {
  if (!debeOfrecer(situacionActual(raiz, modoNormal))) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let texto: string;
  try {
    texto = await rl.question('¿Mostrar esto en la barra de menú, y que arranque solo al iniciar sesión? [S/n] ');
  } catch {
    // Ctrl-D o ctrl-c: la pregunta se aborta y readline tira ABORT_ERR. Eso no
    // es un «no» —nadie contestó—, así que no se anota y se vuelve a ofrecer la
    // próxima vez. Lo que no puede pasar es que `qm` muera con un stack trace
    // después de haber mostrado bien los números.
    console.log();
    return;
  } finally {
    rl.close();
  }
  const a = comoArrancar(raiz);
  const comando = a.via === 'brew' ? 'brew services start quartermaster' : `${a.lanzador} --instalar-arranque`;

  if (/^\s*n/i.test(texto)) {
    anotar('no');
    console.log(`Listo, no se vuelve a preguntar. Si cambiás de idea: ${comando}`);
    return;
  }
  anotar('si');
  if (!arrancar(a)) {
    console.log(`No pude arrancarla. A mano: ${comando}`);
    return;
  }
  // La primera vez compila bin/qm-barra.swift, que tarda unos segundos. Se
  // espera a verla corriendo para no decir «listo» de algo que no apareció.
  process.stdout.write('arrancando la barra…');
  for (let i = 0; i < 60; i += 1) {
    if (corriendo()) {
      console.log(' listo: arriba a la derecha.');
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(` no la veo corriendo después de un minuto. Probá: ${comando}`);
}
