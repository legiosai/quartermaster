#!/usr/bin/env node
// qm · cuánta cuota te queda, en todos tus perfiles.
//
// Tres fuentes, de la más barata a la más cara:
//
//   1. `cachedUsageUtilization` en .claude.json — la última respuesta de cuota
//      que recibió Claude Code. Sin red, sin credencial, y funciona aunque el
//      token esté vencido. Es el camino por defecto.
//   2. el endpoint, sólo con --refrescar, para el perfil cuyo cache quedó viejo.
//   3. las transcripciones locales, que no dicen el límite pero no fallan nunca.
//
// La 3 no es un fallback opcional: es el piso. Si no hay número de cuota, igual
// hay consumo — y además una frase que dice por qué falta el otro.

import { homedir } from 'node:os';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { estadoCredencial } from '../adapters/credenciales.ts';
import { consumoDesde, transcripciones } from '../adapters/transcripciones.ts';
import { cuotaEnCache } from '../adapters/cache-cuota.ts';
import { anotar, claveBarra, muestras, type Lectura } from '../adapters/historial.ts';
import { proyectar, type Proyeccion } from '../core/proyeccion.ts';
import { consultarCuota } from '../adapters/cuota.ts';
import { codexEnCache, consultarCodex, duenoCodex, hayCodex, DIRECTORIO_CODEX } from '../adapters/codex.ts';
import { endpointEnCache, guardarEndpoint, masNueva } from '../adapters/cache-endpoint.ts';
import {
  frase,
  nombreVentana,
  paraMostrar,
  peor,
  totalTokens,
  type Perfil,
  type ResultadoCuota,
  type VentanaCuota,
} from '../core/tipos.ts';
import {
  barra,
  duracion,
  negrita,
  relleno,
  rojo,
  tenue,
  tokens,
  verde,
  amarillo,
} from '../render/barras.ts';

interface Opciones {
  json: boolean;
  watch: number | null;
  refrescar: boolean;
  dias: number;
  ventanaH: number;
  umbral: number | null;
  redactado: boolean;
  breve: boolean;
  codex: boolean;
}

/**
 * Cuánto vale el cache de Codex antes de volver a preguntar. Codex no deja la
 * cuota en el disco, así que el cache es nuestro: si está viejo se refresca
 * solo, salvo en --breve, que tiene que seguir tardando milisegundos.
 */
const CODEX_FRESCO_MS = 5 * 60_000;

const AYUDA = `qm · cuánta cuota te queda, en todos tus perfiles de Claude Code

  qm                  cuota y consumo de cada perfil. Sin red y sin credencial:
                      lee la cuota que Claude Code ya dejó en .claude.json
  qm --refrescar      además pide el número al endpoint (necesita token vigente)
  qm --json           lo mismo, para scripts y statuslines
  qm --watch [seg]    se redibuja cada N segundos (mínimo 30, por defecto 60)
  qm --dias=N         ventana del consumo local (por defecto 7)
  qm --umbral=N       sale con código 3 si alguna barra pasa el N %
  qm --redactado      con --json, saca mails y rutas de casa: para comitear
  qm --breve          un renglón y nada más. No lee transcripciones, así que
                      tarda milisegundos: es lo que va en una statusline
  qm --sin-codex      no mira la cuenta de Codex
  qm --calentar       refresca el endpoint de cada perfil y el de Codex, guarda
                      lo que vuelve y no imprime nada. Es lo que corre la barra
  qm --calentar-codex igual pero sólo Codex, sin tocar el llavero

Nunca refresca un token. Si una credencial venció, lo dice y sigue con el
resto de los perfiles — la cuota igual se lee, porque sale del disco.`;

function parsearArgs(argv: readonly string[]): Opciones | string {
  const o: Opciones = {
    json: false,
    watch: null,
    refrescar: false,
    dias: 7,
    ventanaH: 5,
    umbral: null,
    redactado: false,
    breve: false,
    codex: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--json') o.json = true;
    else if (a === '--redactado') o.redactado = true;
    else if (a === '--breve') o.breve = true;
    else if (a === '--sin-codex') o.codex = false;
    else if (a === '--refrescar' || a === '--red') o.refrescar = true;
    // --sin-red era el nombre viejo de lo que ahora es el comportamiento por
    // defecto. Se acepta sin decir nada para no romper a quien ya lo escribió.
    else if (a === '--sin-red' || a === '--offline') o.refrescar = false;
    else if (a === '--watch' || a.startsWith('--watch=')) {
      const crudo = a.includes('=') ? a.split('=')[1]! : argv[++i];
      const n = crudo === undefined ? 60 : Number(crudo);
      if (!Number.isFinite(n)) return `--watch espera segundos, no "${crudo}"`;
      // Menos de 30 s no aporta nada y castiga un endpoint que no es nuestro.
      o.watch = Math.max(30, n);
    } else if (a.startsWith('--dias=')) {
      const n = Number(a.split('=')[1]);
      if (!Number.isFinite(n) || n <= 0) return '--dias espera un número de días';
      o.dias = n;
    } else if (a.startsWith('--umbral=')) {
      const n = Number(a.split('=')[1]);
      if (!Number.isFinite(n) || n < 0 || n > 100) return '--umbral espera un porcentaje 0..100';
      o.umbral = n;
    } else if (a === '-h' || a === '--help') return AYUDA;
    else return `opción desconocida: ${a}\n\n${AYUDA}`;
  }
  return o;
}

interface FilaPerfil {
  /** De qué producto es esta fila. Lo único que distingue una cuenta de otra. */
  producto: 'claude' | 'codex';
  perfil: Perfil;
  veredicto: string;
  cuota: ResultadoCuota;
  /** Por qué no se usó el número del endpoint, cuando se pidió y no salió. */
  notaRefresco: string | null;
  /** Hacia dónde va la barra que más apremia. null si no hay barra. */
  proyeccion: Proyeccion | null;
  archivos: number;
  requests: number;
  tokens: number;
  tokensVentana: number;
  porModelo: [string, number][];
  /** false cuando no hay de dónde medirlo: informar 0 sería mentir. */
  localMedido: boolean;
}

/**
 * La cuenta de Codex como una fila más.
 *
 * Se le da forma de Perfil para que el render, el JSON y la proyección no
 * tengan que saber que existen dos productos: lo único que cambia es de dónde
 * salió el número, y eso ya lo dice `origen`.
 */
async function filaCodex(o: Opciones): Promise<FilaPerfil | null> {
  if (!hayCodex()) return null;

  // El cache primero, como siempre. La diferencia con Claude es que este cache
  // lo escribimos nosotros, porque Codex no deja ninguno.
  let { cuota, info } = codexEnCache();
  const edad =
    cuota.estado === 'ok' ? Date.now() - cuota.medidoEn.getTime() : Number.POSITIVE_INFINITY;
  // --breve no habla con nadie: tiene que seguir tardando milisegundos.
  const conviene = o.refrescar || (!o.breve && edad > CODEX_FRESCO_MS);
  let notaRefresco: string | null = null;
  if (conviene) {
    const fresca = await consultarCodex();
    if (fresca.cuota.estado === 'ok') ({ cuota, info } = fresca);
    else if (cuota.estado !== 'ok') cuota = fresca.cuota;
    else notaRefresco = frase(fresca.cuota, 'codex');
  }

  const dueno = duenoCodex();
  const perfil: Perfil = {
    directorio: DIRECTORIO_CODEX,
    nombre: 'codex',
    porDefecto: false,
    cuenta: {
      email: dueno?.email ?? info?.accountId ?? null,
      organizacion: null,
      plan: info?.plan ?? dueno?.plan ?? null,
    },
  };

  let proyeccion: Proyeccion | null = null;
  if (cuota.estado === 'ok') {
    try {
      anotar(
        cuota.ventanas.map((v) => ({
          perfil: 'codex',
          barra: claveBarra(v.clave, v.alcance),
          medidoEn: (cuota as { medidoEn: Date }).medidoEn,
          porcentaje: v.porcentaje,
        })),
      );
    } catch {
      // Igual que con Claude: sin historial se pierde la proyección, nada más.
    }
    const p = peor(paraMostrar(cuota.ventanas));
    if (p !== null) {
      proyeccion = proyectar(muestras('codex', claveBarra(p.clave, p.alcance)), p.porcentaje, p.reinicia);
    }
  }

  return {
    producto: 'codex',
    // No hay adaptador de transcripciones para Codex: decir 0 sería afirmar
    // que no consumiste nada, y lo cierto es que no lo medimos.
    localMedido: false,
    perfil,
    veredicto: info === null ? 'la pone codex' : `la pone codex · ${info.creditosReset} reset(s) sin usar`,
    cuota,
    notaRefresco,
    proyeccion,
    archivos: 0,
    requests: 0,
    tokens: 0,
    tokensVentana: 0,
    porModelo: [],
  };
}

async function medir(o: Opciones): Promise<FilaPerfil[]> {
  const perfiles = descubrirPerfiles();
  const desde = new Date(Date.now() - o.dias * 24 * 3600_000);
  const desdeVentana = new Date(Date.now() - o.ventanaH * 3600_000);

  const claude = await Promise.all(
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

      // El cache primero: es gratis y no necesita credencial. Se toma la más
      // nueva entre la que dejó Claude Code y la que dejamos nosotros la última
      // vez que se consultó el endpoint.
      let cuota = masNueva(cuotaEnCache(perfil), endpointEnCache(perfil.nombre));
      let notaRefresco: string | null = null;
      if (o.refrescar) {
        const fresca = await consultarCuota(perfil);
        if (fresca.estado === 'ok') {
          cuota = fresca;
          guardarEndpoint(perfil.nombre, fresca);
        } else notaRefresco = frase(fresca, perfil.directorio);
      }

      // Cada lectura alimenta la serie que hace posible la proyección. Se
      // indexa por `medidoEn`, así que mirar el mismo cache diez veces deja
      // una sola muestra.
      let proyeccion: Proyeccion | null = null;
      if (cuota.estado === 'ok') {
        const lecturas: Lectura[] = cuota.ventanas.map((v) => ({
          perfil: perfil.nombre,
          barra: claveBarra(v.clave, v.alcance),
          medidoEn: cuota.medidoEn,
          porcentaje: v.porcentaje,
        }));
        try {
          anotar(lecturas);
        } catch {
          // Si el cache del usuario no es escribible, se pierde la proyección
          // y nada más. No es motivo para no mostrar el número.
        }
        const p = peor(paraMostrar(cuota.ventanas));
        if (p !== null) {
          proyeccion = proyectar(
            muestras(perfil.nombre, claveBarra(p.clave, p.alcance)),
            p.porcentaje,
            p.reinicia,
          );
        }
      }

      // En modo breve no se tocan las transcripciones: son 128 archivos y un
      // segundo entero, y una statusline se dibuja todo el tiempo.
      if (o.breve) {
        return {
          producto: 'claude',
          localMedido: false,
          perfil,
          veredicto,
          cuota,
          notaRefresco,
          proyeccion,
          archivos: 0,
          requests: 0,
          tokens: 0,
          tokensVentana: 0,
          porModelo: [],
        };
      }

      const c = await consumoDesde(perfil, desde);
      const v = await consumoDesde(perfil, desdeVentana);

      return {
        producto: 'claude',
        localMedido: true,
        perfil,
        veredicto,
        cuota,
        notaRefresco,
        proyeccion,
        archivos: transcripciones(perfil).length,
        requests: c.requests,
        tokens: totalTokens(c),
        tokensVentana: totalTokens(v),
        porModelo: [...c.porModelo].sort((a, b) => b[1] - a[1]).slice(0, 3),
      };
    }),
  );

  const codex = o.codex ? await filaCodex(o) : null;
  return codex === null ? claude : [...claude, codex];
}

const colorPct = (p: number): ((t: string) => string) => (p >= 90 ? rojo : p >= 70 ? amarillo : verde);

/** «cache · hace 25m». Que la edad viaje pegada al número es la mitad del punto. */
function sello(r: Extract<ResultadoCuota, { estado: 'ok' }>): string {
  const edadMs = Date.now() - r.medidoEn.getTime();
  if (r.origen === 'endpoint') return tenue('endpoint · ahora');
  const texto = `cache · hace ${duracion(edadMs)}`;
  // Seis horas es más que cualquier ventana de 5 h: a esa altura el número
  // puede describir una ventana que ya se reinició.
  return edadMs > 6 * 3600_000 ? amarillo(`${texto} — viejo`) : tenue(texto);
}

function pintarVentana(v: VentanaCuota, marca: boolean): void {
  const pct = `${v.porcentaje.toFixed(0)}%`.padStart(4);
  const resta = v.reinicia
    ? tenue(` reinicia en ${duracion(v.reinicia.getTime() - Date.now())}`)
    : '';
  const aviso = v.severidad !== 'normal' ? ` ${amarillo(v.severidad)}` : '';
  const flecha = marca ? negrita('▸ ') : '  ';
  console.log(
    `  ${relleno('', 17)}${flecha}${relleno(nombreVentana(v), 24)} ${barra(v.porcentaje / 100)} ${colorPct(v.porcentaje)(pct)}${aviso}${resta}`,
  );
}

/**
 * Hacia dónde va. La frase de 'sin-datos' importa tanto como la proyección:
 * es la diferencia entre «no vas a chocarte» y «todavía no sé si te vas a
 * chocar», y confundirlas es exactamente el error que esta herramienta evita.
 */
function fraseProyeccion(p: Proyeccion): string {
  switch (p.estado) {
    case 'sube': {
      const cuando = `${p.ritmo.toFixed(1)} pts/h · 100 % en ${duracion(p.techo.getTime() - Date.now())}`;
      return p.chocas ? rojo(`${cuando} — antes del reinicio`) : tenue(`${cuando} — después del reinicio`);
    }
    case 'plano':
      return tenue(`no sube (${p.muestras} lecturas)`);
    case 'sin-datos':
      return tenue(`todavía no sé el ritmo: ${p.motivo}`);
  }
}

function pintar(filas: readonly FilaPerfil[], o: Opciones): void {
  console.log(negrita(`\nqm · ${process.platform} · consumo de ${o.dias}d\n`));

  for (const f of filas) {
    const cuenta = f.perfil.cuenta?.email ?? 'sin cuenta';
    const plan = f.perfil.cuenta?.plan ? tenue(` · ${f.perfil.cuenta.plan}`) : '';
    const colorCred = f.producto === 'codex'
      ? tenue
      : f.veredicto.startsWith('vigente')
        ? verde
        : f.veredicto === 'vencida'
          ? amarillo
          : rojo;
    console.log(`  ${negrita(relleno(f.perfil.nombre, 18))} ${relleno(cuenta, 30)}${plan}`);
    console.log(`  ${relleno('', 18)} ${tenue('credencial: ')}${colorCred(f.veredicto)}`);

    if (f.cuota.estado === 'ok') {
      const mostrar = paraMostrar(f.cuota.ventanas);
      const p = peor(mostrar);
      console.log(`  ${relleno('', 18)} ${sello(f.cuota)}`);
      for (const v of mostrar) pintarVentana(v, p !== null && v.clave === p.clave);
    } else {
      // Sin número de cuota, una frase. Nunca un renglón en blanco.
      console.log(`  ${relleno('', 18)} ${tenue(`cuota: ${frase(f.cuota, f.perfil.directorio)}`)}`);
    }
    if (f.proyeccion !== null) {
      console.log(`  ${relleno('', 18)} ${tenue('ritmo: ')}${fraseProyeccion(f.proyeccion)}`);
    }
    if (f.notaRefresco !== null) {
      console.log(`  ${relleno('', 18)} ${tenue(`--refrescar no sirvió: ${f.notaRefresco}`)}`);
    }

    if (f.localMedido) {
      console.log(
        `  ${relleno('', 18)} ${tenue(`local: ${tokens(f.tokens)} en ${o.dias}d · ${tokens(f.tokensVentana)} en ${o.ventanaH}h · ${f.requests} requests`)}`,
      );
    }
    console.log();
  }

  // El renglón que sirve cuando no querés leer la tabla entera.
  const peores: { f: FilaPerfil; v: VentanaCuota }[] = [];
  for (const f of filas) {
    if (f.cuota.estado !== 'ok') continue;
    const v = peor(paraMostrar(f.cuota.ventanas));
    if (v !== null) peores.push({ f, v });
  }
  peores.sort((a, b) => b.v.porcentaje - a.v.porcentaje);
  const top = peores[0];
  if (top) {
    console.log(
      `  ${negrita('lo primero que te frena:')} ${top.f.perfil.nombre} · ${nombreVentana(top.v)} ${colorPct(top.v.porcentaje)(`${top.v.porcentaje.toFixed(0)}%`)}` +
        (top.v.reinicia ? tenue(` · reinicia en ${duracion(top.v.reinicia.getTime() - Date.now())}`) : ''),
    );
    console.log();
  }
}

/**
 * Los artefactos que se comitean no llevan direcciones de mail ni la ruta de
 * casa de nadie. En la terminal se muestran enteros: es la máquina del dueño.
 */
function redactar(o: Opciones, texto: string | null): string | null {
  if (!o.redactado || texto === null) return texto;
  const arroba = texto.lastIndexOf('@');
  if (arroba >= 0 && !texto.includes('/')) return `***${texto.slice(arroba)}`;
  return texto.replace(homedir(), '~');
}

/** `.claude-teams` → `teams`; el por defecto → `main`. Para que entre en una línea. */
function nombreCorto(n: string): string {
  const sin = n.replace(/^\.claude-?/, '');
  return sin.length === 0 ? 'main' : sin;
}

/**
 * Un renglón, pensado para una statusline: sólo la barra que más apremia de
 * cada perfil que tenga número. Los perfiles sin cuota no se listan — en una
 * línea de 80 columnas, decir «no sé» de tres perfiles tapa el que sí sabés.
 */
function pintarBreve(filas: readonly FilaPerfil[]): void {
  const partes: string[] = [];
  for (const f of filas) {
    if (f.cuota.estado !== 'ok') continue;
    const v = peor(paraMostrar(f.cuota.ventanas));
    if (v === null) continue;
    const viejo = Date.now() - f.cuota.medidoEn.getTime() > 6 * 3600_000 ? '~' : '';
    // El «!» ya no es sólo severidad: también avisa que a este ritmo tocás el
    // techo antes de que la ventana se reinicie, que es lo que duele.
    const chocas = f.proyeccion?.estado === 'sube' && f.proyeccion.chocas;
    const aviso = v.severidad !== 'normal' || chocas ? '!' : '';
    // Dos números, dos preguntas: la sesión dice si podés seguir AHORA, y la
    // barra que frena antes dice si llegás al final de la ventana larga. Una
    // sola de las dos deja media respuesta.
    const sesion = paraMostrar(f.cuota.ventanas).find((w) => w.grupo === 'session' || w.clave === 'session');
    const cifra =
      sesion === undefined || sesion.clave === v.clave
        ? `${v.porcentaje.toFixed(0)}%`
        : `${sesion.porcentaje.toFixed(0)}/${v.porcentaje.toFixed(0)}%`;
    partes.push(
      `${nombreCorto(f.perfil.nombre)} ${colorPct(v.porcentaje)(`${viejo}${cifra}${aviso}`)}`,
    );
  }
  console.log(partes.length === 0 ? 'sin cuota en cache' : partes.join(tenue(' · ')));
}

function comoJson(filas: readonly FilaPerfil[], o: Opciones): unknown {
  return {
    generado: new Date().toISOString(),
    plataforma: process.platform,
    ventanaDias: o.dias,
    perfiles: filas.map((f) => ({
      producto: f.producto,
      perfil: f.perfil.nombre,
      directorio: redactar(o, f.perfil.directorio),
      cuenta: redactar(o, f.perfil.cuenta?.email ?? null),
      plan: f.perfil.cuenta?.plan ?? null,
      credencial: f.veredicto,
      cuota:
        f.cuota.estado === 'ok'
          ? {
              estado: 'ok',
              origen: f.cuota.origen,
              medidoEn: f.cuota.medidoEn.toISOString(),
              edadSegundos: Math.round((Date.now() - f.cuota.medidoEn.getTime()) / 1000),
              ventanas: f.cuota.ventanas.map((v) => ({
                clave: v.clave,
                alcance: v.alcance,
                grupo: v.grupo,
                porcentaje: v.porcentaje,
                severidad: v.severidad,
                activa: v.activa,
                reinicia: v.reinicia?.toISOString() ?? null,
              })),
            }
          : {
              estado: f.cuota.estado,
              frase: redactar(o, frase(f.cuota, f.perfil.directorio)),
            },
      proyeccion:
        f.proyeccion === null
          ? null
          : f.proyeccion.estado === 'sube'
            ? {
                estado: 'sube',
                ritmoPuntosPorHora: Number(f.proyeccion.ritmo.toFixed(3)),
                techo: f.proyeccion.techo.toISOString(),
                chocasAntesDelReinicio: f.proyeccion.chocas,
                muestras: f.proyeccion.muestras,
              }
            : f.proyeccion.estado === 'plano'
              ? { estado: 'plano', muestras: f.proyeccion.muestras }
              : { estado: 'sin-datos', motivo: f.proyeccion.motivo },
      // En --breve no se leyeron las transcripciones. Informar 0 sería decir
      // "no consumiste nada" cuando lo que pasa es "no lo medí".
      local: o.breve || !f.localMedido
        ? null
        : {
            tokens: f.tokens,
            tokensVentana: f.tokensVentana,
            requests: f.requests,
            transcripciones: f.archivos,
            porModelo: Object.fromEntries(f.porModelo),
          },
    })),
  };
}

/** El porcentaje más alto visto en cualquier perfil, para --umbral. */
function maximo(filas: readonly FilaPerfil[]): number {
  let m = 0;
  for (const f of filas) {
    if (f.cuota.estado !== 'ok') continue;
    for (const v of f.cuota.ventanas) m = Math.max(m, v.porcentaje);
  }
  return m;
}

// --calentar sale antes que nada: es lo que corre el item de la barra en su
// sondeo, para que las lecturas rápidas (--breve) encuentren números frescos
// sin tener que hablar con nadie. Refresca las dos puntas —el endpoint de cada
// perfil de Claude y Codex— y no imprime nada.
if (process.argv.includes('--calentar') || process.argv.includes('--calentar-codex')) {
  const soloCodex = !process.argv.includes('--calentar');
  let bien = false;
  if (!soloCodex) {
    for (const perfil of descubrirPerfiles()) {
      const r = await consultarCuota(perfil);
      if (r.estado === 'ok') {
        guardarEndpoint(perfil.nombre, r);
        bien = true;
      }
    }
  }
  const c = await consultarCodex();
  process.exit(c.cuota.estado === 'ok' || bien ? 0 : 1);
}

const opciones = parsearArgs(process.argv.slice(2));
if (typeof opciones === 'string') {
  console.log(opciones);
  process.exit(opciones === AYUDA ? 0 : 2);
}

const unaVuelta = async (): Promise<number> => {
  const filas = await medir(opciones);
  if (filas.length === 0) {
    console.log('No se encontró ninguna cuenta de Claude Code ni de Codex en esta máquina.');
    return 1;
  }
  if (opciones.json) console.log(JSON.stringify(comoJson(filas, opciones), null, 2));
  else if (opciones.breve) pintarBreve(filas);
  else pintar(filas, opciones);
  if (opciones.umbral !== null && maximo(filas) >= opciones.umbral) return 3;
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
