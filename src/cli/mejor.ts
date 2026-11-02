// qm --mejor: el perfil de Claude con más margen, para arrancar ahí sin mirar.
//
//   qm --mejor              imprime el directorio y nada más
//   qm --mejor -- claude    arranca `claude` en ese perfil
//   qm --mejor --json       el orden entero y por qué
//
// La segunda forma existe porque la primera no alcanza para el perfil por
// defecto. Con `CLAUDE_CONFIG_DIR` puesta —aunque apunte a `~/.claude`— Claude
// Code lee `<dir>/.claude.json` en vez de `~/.claude.json`, y en macOS deja de
// mirar el llavero: `CLAUDE_CONFIG_DIR=~/.claude claude` es OTRO perfil, sin
// sesión. Leído en el binario de Claude Code 2.1.316. Así que el perfil por
// defecto se arranca sacando la variable, y eso un `$(…)` no lo puede hacer.
//
// Sólo disco: nada de red y nada de transcripciones, igual que `--breve`.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { estadoCredencial } from '../adapters/credenciales.ts';
import { cuotaGuardada, proyeccionDe } from '../adapters/cuota-guardada.ts';
import { nombreCorto, seleccionar, type Config } from '../core/config.ts';
import { elegir, frenaVigente, type Candidata, type Evaluada } from '../core/eleccion.ts';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { nombreVentana, type Perfil } from '../core/tipos.ts';

/** Lo que hace falta de un perfil para compararlo: credencial, cuota guardada y su proyección. */
export function candidata(perfil: Perfil, ahora = Date.now()): Candidata {
  const cred = estadoCredencial(perfil);
  const cuota = cuotaGuardada(perfil);
  const frena = cuota.estado === 'ok' ? frenaVigente(cuota.ventanas, ahora) : null;
  return {
    nombre: perfil.nombre,
    directorio: perfil.directorio,
    porDefecto: perfil.porDefecto,
    credencial: !cred.presente ? 'sin' : cred.vencida ? 'vencida' : 'vigente',
    cuota,
    proyeccion: proyeccionDe(perfil.nombre, frena, ahora),
  };
}

/** Los perfiles que la configuración deja ver: `--mejor` no elige uno que escondiste. */
export function perfilesVisibles(cfg: Config): Perfil[] {
  return seleccionar(descubrirPerfiles().map((perfil) => ({ perfil })), cfg).filas.map((f) => f.perfil);
}

/** `~/.claude-teams` en vez de la ruta entera: es para leer, no para copiar a ciegas. */
export function conTilde(dir: string): string {
  const casa = homedir();
  return dir === casa || dir.startsWith(`${casa}/`) ? `~${dir.slice(casa.length)}` : dir;
}

/** El comando que arranca Claude Code en ese perfil, para mostrarlo. */
export function comoArrancar(c: Candidata): string {
  if (!c.porDefecto) return `CLAUDE_CONFIG_DIR=${conTilde(c.directorio)} claude`;
  return process.platform === 'win32' ? 'qm --mejor -- claude' : 'env -u CLAUDE_CONFIG_DIR claude';
}

function evaluadaJson(x: Evaluada): Record<string, unknown> {
  const c = x.candidata;
  return {
    perfil: c.nombre,
    directorio: c.directorio,
    porDefecto: c.porDefecto,
    nivel: x.nivel,
    libre: x.libre,
    frena:
      x.frena === null
        ? null
        : {
            clave: x.frena.clave,
            alcance: x.frena.alcance,
            nombre: nombreVentana(x.frena),
            porcentaje: x.frena.porcentaje,
            reinicia: x.frena.reinicia?.toISOString() ?? null,
          },
    sesion: x.sesion?.porcentaje ?? null,
    credencial: c.credencial,
    medidoEn: c.cuota.estado === 'ok' ? c.cuota.medidoEn.toISOString() : null,
  };
}

/**
 * Arranca el comando en el perfil elegido y devuelve su código de salida.
 *
 * Ctrl-C y Ctrl-\ le llegan a todo el grupo de procesos de la terminal, o sea
 * también a este. Si este proceso muriera con el Ctrl-C que Claude Code usa
 * para interrumpir, la shell recuperaría la terminal con Claude Code todavía
 * leyéndola. Así que mientras el hijo vive, esas dos señales se ignoran acá.
 */
function lanzar(c: Candidata, comando: readonly string[]): number {
  const env = { ...process.env };
  if (c.porDefecto) delete env['CLAUDE_CONFIG_DIR'];
  else env['CLAUDE_CONFIG_DIR'] = c.directorio;
  const nada = (): void => {};
  process.on('SIGINT', nada);
  process.on('SIGQUIT', nada);
  const r = spawnSync(comando[0]!, comando.slice(1), {
    stdio: 'inherit',
    env,
    // `claude` en Windows es un .cmd: sin shell, spawn no lo encuentra.
    shell: process.platform === 'win32',
  });
  if (r.error !== undefined) {
    console.error(`qm --mejor: no se pudo arrancar ${comando[0]}: ${r.error.message}`);
    return 127;
  }
  return r.status ?? 1;
}

export function correrMejor(cfg: Config, argv: readonly string[], ahora = Date.now()): number {
  const corte = argv.indexOf('--');
  const propios = corte < 0 ? argv : argv.slice(0, corte);
  const comando = corte < 0 ? [] : argv.slice(corte + 1);

  const e = elegir(perfilesVisibles(cfg).map((p) => candidata(p, ahora)), ahora);

  if (propios.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          esquema: 1,
          elegida: e.elegida === null ? null : evaluadaJson(e.elegida),
          orden: e.orden.map(evaluadaJson),
          descartadas: e.descartadas.map((d) => ({ perfil: d.nombre, motivo: d.motivo })),
        },
        null,
        2,
      ),
    );
    return e.elegida === null ? 1 : 0;
  }

  if (e.elegida === null) {
    // Nada en stdout: un `CLAUDE_CONFIG_DIR=$(qm --mejor)` que recibe una
    // frase la usaría como directorio. La frase va a stderr y el código dice
    // que no hubo respuesta.
    const porque = e.descartadas.map((d) => `${nombreCorto(d.nombre)}: ${d.motivo}`).join(' · ');
    console.error(
      `qm --mejor: ninguna cuenta de Claude tiene un número para comparar${porque === '' ? '' : ` (${porque})`}. ` +
        'Poné `qm --statusline` como statusLine de Claude Code, o corré `qm --refrescar`.',
    );
    return 1;
  }

  if (comando.length === 0) {
    console.log(e.elegida.candidata.directorio);
    return 0;
  }

  const x = e.elegida;
  const margen = x.libre === null ? 'se reinició desde la última lectura' : `${Math.round(x.libre)} % libre`;
  console.error(`qm · ${nombreCorto(x.candidata.nombre)} (${margen})`);
  return lanzar(x.candidata, comando);
}
