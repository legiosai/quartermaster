#!/usr/bin/env node
// qm · cuánta cuota te queda, en todos tus perfiles.
//
// Dos fuentes, en este orden:
//   1. el endpoint de cuota, que sabe el LÍMITE y cuándo se reinicia (H2);
//   2. las transcripciones locales, que saben el CONSUMO y no fallan nunca.
//
// La segunda no es un fallback opcional: es el piso. Si el endpoint no
// contesta, o el token venció, o la cuenta no tiene suscripción, igual hay un
// número — y además una frase que dice por qué falta el otro.

import { descubrirPerfiles } from '../core/perfiles.ts';
import { estadoCredencial } from '../adapters/credenciales.ts';
import { consumoDesde, transcripciones } from '../adapters/transcripciones.ts';
import { consultarCuota } from '../adapters/cuota.ts';
import { frase, totalTokens, type Perfil, type ResultadoCuota } from '../core/tipos.ts';
import { barra, duracion, negrita, relleno, rojo, tenue, tokens, verde, amarillo } from '../render/barras.ts';

interface Opciones {
  json: boolean;
  watch: number | null;
  red: boolean;
  dias: number;
  ventanaH: number;
}

function parsearArgs(argv: readonly string[]): Opciones | string {
  const o: Opciones = { json: false, watch: null, red: true, dias: 7, ventanaH: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--json') o.json = true;
    else if (a === '--sin-red' || a === '--offline') o.red = false;
    else if (a === '--watch' || a.startsWith('--watch=')) {
      const crudo = a.includes('=') ? a.split('=')[1]! : argv[++i];
      const n = crudo === undefined ? 60 : Number(crudo);
      if (!Number.isFinite(n)) return `--watch espera segundos, no "${crudo}"`;
      // Menos de 30 s no aporta nada y castiga un endpoint que no es nuestro.
      o.watch = Math.max(30, n);
    } else if (a.startsWith('--dias=')) {
      const n = Number(a.split('=')[1]);
      if (!Number.isFinite(n) || n <= 0) return `--dias espera un número de días`;
      o.dias = n;
    } else if (a === '-h' || a === '--help') return AYUDA;
    else return `opción desconocida: ${a}\n\n${AYUDA}`;
  }
  return o;
}

const AYUDA = `qm · cuánta cuota te queda, en todos tus perfiles de Claude Code

  qm                  una foto: cuota (si hay) y consumo local de cada perfil
  qm --json           lo mismo, para scripts y statuslines
  qm --watch [seg]    se redibuja cada N segundos (mínimo 30, por defecto 60)
  qm --sin-red        no consulta el endpoint: sólo transcripciones locales
  qm --dias=N         ventana del consumo local (por defecto 7)

Nunca refresca un token. Si una credencial venció, lo dice y sigue con el
resto de los perfiles.`;

interface FilaPerfil {
  perfil: Perfil;
  ubicacion: string;
  veredicto: string;
  cuota: ResultadoCuota;
  archivos: number;
  requests: number;
  tokens: number;
  tokensVentana: number;
  porModelo: [string, number][];
}

async function medir(o: Opciones): Promise<FilaPerfil[]> {
  const perfiles = descubrirPerfiles();
  const desde = new Date(Date.now() - o.dias * 24 * 3600_000);
  const desdeVentana = new Date(Date.now() - o.ventanaH * 3600_000);

  return Promise.all(
    perfiles.map(async (perfil): Promise<FilaPerfil> => {
      const cred = estadoCredencial(perfil);
      const veredicto =
        cred.error !== null
          ? `ilegible · ${cred.error}`
          : !cred.presente
            ? 'sin credencial'
            : cred.vencida
              ? 'vencida'
              : `vigente (${duracion((cred.expiraEn?.getTime() ?? 0) - Date.now())})`;

      const cuota: ResultadoCuota = o.red
        ? await consultarCuota(perfil)
        : { estado: 'no-consultada' };

      const c = await consumoDesde(perfil, desde);
      const v = await consumoDesde(perfil, desdeVentana);

      return {
        perfil,
        ubicacion: cred.ubicacion,
        veredicto,
        cuota,
        archivos: transcripciones(perfil).length,
        requests: c.requests,
        tokens: totalTokens(c),
        tokensVentana: totalTokens(v),
        porModelo: [...c.porModelo].sort((a, b) => b[1] - a[1]).slice(0, 3),
      };
    }),
  );
}

function pintar(filas: readonly FilaPerfil[], o: Opciones): void {
  console.log(negrita(`\nqm · ${process.platform} · consumo de ${o.dias}d\n`));
  for (const f of filas) {
    const cuenta = f.perfil.cuenta?.email ?? 'sin cuenta';
    const plan = f.perfil.cuenta?.plan ? tenue(` · ${f.perfil.cuenta.plan}`) : '';
    const color = f.veredicto.startsWith('vigente') ? verde : f.veredicto === 'vencida' ? amarillo : rojo;
    console.log(`  ${negrita(relleno(f.perfil.nombre, 18))} ${relleno(cuenta, 30)}${plan}`);
    console.log(`  ${relleno('', 18)} ${color(f.veredicto)}`);

    if (f.cuota.estado === 'ok') {
      for (const v of f.cuota.ventanas) {
        const resta = v.reinicia ? tenue(` reinicia en ${duracion(v.reinicia.getTime() - Date.now())}`) : '';
        const pct = `${v.porcentaje.toFixed(0)}%`.padStart(4);
        console.log(`  ${relleno('', 18)} ${relleno(v.clave, 12)} ${barra(v.porcentaje / 100)} ${pct}${resta}`);
      }
    } else {
      // Sin número de cuota, una frase. Nunca un renglón en blanco.
      console.log(`  ${relleno('', 18)} ${tenue(`cuota: ${frase(f.cuota, f.perfil.directorio)}`)}`);
    }

    console.log(
      `  ${relleno('', 18)} ${tenue(`local: ${tokens(f.tokens)} en ${o.dias}d · ${tokens(f.tokensVentana)} en ${o.ventanaH}h · ${f.requests} requests · ${f.archivos} transcripciones`)}`,
    );
    console.log();
  }
}

function comoJson(filas: readonly FilaPerfil[], o: Opciones): unknown {
  return {
    generado: new Date().toISOString(),
    plataforma: process.platform,
    ventanaDias: o.dias,
    perfiles: filas.map((f) => ({
      perfil: f.perfil.nombre,
      directorio: f.perfil.directorio,
      cuenta: f.perfil.cuenta?.email ?? null,
      plan: f.perfil.cuenta?.plan ?? null,
      credencial: f.veredicto,
      cuota:
        f.cuota.estado === 'ok'
          ? {
              estado: 'ok',
              ventanas: f.cuota.ventanas.map((v) => ({
                clave: v.clave,
                porcentaje: v.porcentaje,
                reinicia: v.reinicia?.toISOString() ?? null,
              })),
            }
          : { estado: f.cuota.estado, frase: frase(f.cuota, f.perfil.directorio) },
      local: {
        tokens: f.tokens,
        tokensVentana: f.tokensVentana,
        requests: f.requests,
        transcripciones: f.archivos,
        porModelo: Object.fromEntries(f.porModelo),
      },
    })),
  };
}

const opciones = parsearArgs(process.argv.slice(2));
if (typeof opciones === 'string') {
  console.log(opciones);
  process.exit(opciones === AYUDA ? 0 : 2);
}

const unaVuelta = async (): Promise<number> => {
  const filas = await medir(opciones);
  if (filas.length === 0) {
    console.log('No se encontró ningún perfil de Claude Code en esta máquina.');
    return 1;
  }
  if (opciones.json) console.log(JSON.stringify(comoJson(filas, opciones), null, 2));
  else pintar(filas, opciones);
  return 0;
};

if (opciones.watch === null) {
  process.exit(await unaVuelta());
}

// --watch: se redibuja hasta que lo maten. Se limpia la pantalla sólo si hay
// terminal; redirigido a un archivo, un \x1b[2J cada minuto es basura.
const limpiar = process.stdout.isTTY === true;
for (;;) {
  if (limpiar) process.stdout.write('\x1b[2J\x1b[H');
  await unaVuelta();
  console.log(tenue(`  actualiza cada ${opciones.watch}s · ctrl-c para salir`));
  await new Promise((r) => setTimeout(r, opciones.watch! * 1000));
}
