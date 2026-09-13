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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { estadoCredencial } from '../adapters/credenciales.ts';
import { consumoDesde, transcripciones } from '../adapters/transcripciones.ts';
import { cuotaEnCache } from '../adapters/cache-cuota.ts';
import { anotar, claveBarra, muestras, type Lectura } from '../adapters/historial.ts';
import { proyectar, VENTANA_AJUSTE_MS, type Proyeccion } from '../core/proyeccion.ts';
import { frasePresupuesto, presupuestoDiario, type Presupuesto } from '../core/presupuesto.ts';
import { consultarCuota } from '../adapters/cuota.ts';
import {
  codexEnCache,
  codexEnDisco,
  modoCodex,
  consultarCodex,
  consumoCodex,
  duenoCodex,
  hayCodex,
  DIRECTORIO_CODEX,
} from '../adapters/codex.ts';
import { endpointEnCache, guardarEndpoint, masNueva } from '../adapters/cache-endpoint.ts';
import { leerConfigUsuario, RUTA_CONFIG, seleccionar, type Config } from '../core/config.ts';
import {
  consumoOpencode,
  hayOpencode,
  limitesOpencode,
  ultimoUsoOpencode,
  type LimiteOpencode,
} from '../adapters/opencode.ts';
import {
  esPreocupante,
  frase,
  nombreVentana,
  paraMostrar,
  peor,
  semanal,
  sesion,
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

/**
 * La versión del paquete, leída del package.json que está al lado.
 *
 * No se hardcodea: el número vive en un solo lugar y `npm version` lo mueve
 * ahí. Y si por lo que sea no se puede leer, `qm --version` contesta igual —
 * un comando que muere porque no encontró su propio package.json es la clase
 * de silencio que este repo no acepta.
 */
export const VERSION: string = (() => {
  try {
    const json = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(json) as { version?: string }).version ?? 'desconocida';
  } catch {
    return 'desconocida';
  }
})();

const AYUDA = `qm · cuánta cuota te queda, en todos tus perfiles de Claude Code

  qm                  cuota y consumo de cada perfil. Sin red y sin credencial:
                      lee la cuota que Claude Code ya dejó en .claude.json
  qm --refrescar      además pide el número al endpoint (necesita token vigente)
  qm --json           lo mismo, para scripts y statuslines
  qm --watch [seg]    se redibuja cada N segundos (mínimo 30, por defecto 60)
  qm --dias=N         ventana del consumo local (por defecto 7)
  qm --umbral=N       sale con código 3 si alguna barra pasa el N %
  qm --esperar        no vuelve hasta que la cuota baje del umbral (80 por
                      defecto). Para encadenar: qm --esperar && codex ...
  qm --cuenta=NOMBRE  con --esperar: mirar sólo esa cuenta (codex, personal…)
  qm --redactado      con --json, saca mails y rutas de casa: para comitear
  qm --breve          un renglón y nada más. No lee transcripciones, así que
                      tarda milisegundos: es lo que va en una statusline
  qm --solo=a,b       mostrar SÓLO esas cuentas (personal, teams, codex…)
  qm --ocultar=a,b    mostrar todas menos esas
  qm --sin-codex      no mira la cuenta de Codex
  qm --version        la versión, y nada más
  qm --calentar       refresca el endpoint de cada perfil y el de Codex, guarda
                      lo que vuelve y no imprime nada. Es lo que corre la barra
  qm --cuentas=a,b    con --calentar: sólo esas cuentas. Cada una que se saltea
                      es un pedido menos a un endpoint que no es nuestro
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
    // La selección la lee configEfectiva() de process.argv; acá sólo se
    // aceptan para que el parser no las rechace.
    else if (a.startsWith('--solo=') || a.startsWith('--ocultar=')) continue;
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
    // Lo primero que tipea todo el mundo, y lo primero que se pide en un bug
    // report. Salía «opción desconocida» con código 2.
    else if (a === '-V' || a === '--version') return `quartermaster ${VERSION}`;
    else return `opción desconocida: ${a}\n\n${AYUDA}`;
  }
  return o;
}

interface FilaPerfil {
  /** De qué producto es esta fila. Lo único que distingue una cuenta de otra. */
  producto: 'claude' | 'codex' | 'opencode';
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

  // El disco primero, igual que en Claude: Codex deja la cuota en sus rollouts
  // y leerla no cuesta red ni credencial. Se compara con lo último que dejó el
  // app-server y gana la más nueva de las dos.
  let { cuota, info } = codexEnDisco();
  const guardada = codexEnCache();
  if (
    guardada.cuota.estado === 'ok' &&
    (cuota.estado !== 'ok' || guardada.cuota.medidoEn.getTime() > cuota.medidoEn.getTime())
  ) {
    ({ cuota, info } = guardada);
  }
  // Sólo se sale a la red cuando lo piden. Antes se refrescaba solo con el
  // cache vencido, y eso —con la barra sondeando— era pegarle al app-server
  // todo el tiempo para confirmar lo que el disco ya decía.
  let notaRefresco: string | null = null;
  if (o.refrescar) {
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
      // El modo va al final y no antes: si hay suscripción de verdad, el plan
      // que informa el rollout o el id_token es más preciso que «api key».
      plan: info?.plan ?? dueno?.plan ?? (modoCodex() === 'apikey' ? 'api key' : null),
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

  // El piso que pide SOUL: aunque el app-server se caiga y el disco no traiga
  // barras, los rollouts siguen teniendo cuántos tokens gastaste.
  const local = o.breve
    ? null
    : consumoCodex(new Date(Date.now() - o.dias * 24 * 3600_000));
  const ventana = o.breve ? null : consumoCodex(new Date(Date.now() - o.ventanaH * 3600_000));

  return {
    producto: 'codex',
    localMedido: local !== null,
    perfil,
    veredicto: info === null ? 'la pone codex' : `la pone codex · ${info.creditosReset} reset(s) sin usar`,
    cuota,
    notaRefresco,
    proyeccion,
    archivos: local?.archivos ?? 0,
    requests: local?.requests ?? 0,
    tokens: local?.tokens ?? 0,
    tokensVentana: ventana?.tokens ?? 0,
    porModelo: [],
  };
}

/**
 * Los planes que viven adentro de opencode: GLM (zai), MiniMax, Kimi…
 *
 * Traen consumo real y NO traen cuota: son planes por API key y el porcentaje
 * sólo existe del otro lado. La fila igual se muestra, con la frase que dice
 * por qué no hay barra — una cuenta que gastó 2,7 M de tokens y no aparece es
 * el bug original de este repo, con otro vendor.
 */
function filasOpencode(o: Opciones): FilaPerfil[] {
  // Antes esto salía en --breve, y con eso la fila desaparecía de TODAS las
  // pantallas: todas piden --breve. Una cuenta con una key de z.ai que se usó
  // ayer y no aparece es, literalmente, el bug que da nombre a la primera
  // sección del README. Lo que costaba era limitesOpencode() —439 ms—, así que
  // se arregló la consulta en vez de esconder la fila: opencode entero son
  // ~25 ms, que sí entran en el contrato de --breve.
  if (!hayOpencode()) return [];
  // Las dos formas del mismo proveedor. opencode no usa un `providerID` estable
  // entre instalaciones: en la máquina donde se escribió esto la base guarda
  // `zai` a secas, y el mapa original sólo tenía `zai-coding-plan` — así que la
  // fila se llamaba `zai` y el nombre lindo no se aplicaba nunca. Verificado
  // contra la base: los providerID reales son zai, openai, amazon-bedrock,
  // anthropic y opencode-go.
  const bonito: Record<string, string> = {
    zai: 'glm',
    'zai-coding-plan': 'glm',
    minimax: 'minimax',
    'minimax-coding-plan': 'minimax',
    kimi: 'kimi',
    'kimi-for-coding': 'kimi',
    xai: 'grok',
    'opencode-go': 'opencode-go',
  };
  const desde = new Date(Date.now() - o.dias * 24 * 3600_000);
  const ventana = new Date(Date.now() - o.ventanaH * 3600_000);
  const enVentana = new Map(consumoOpencode(ventana).map((c) => [c.proveedor, c.tokens]));
  const enDias = new Map(consumoOpencode(desde).map((c) => [c.proveedor, c]));
  const visto = ultimoUsoOpencode();
  const limites = limitesOpencode();

  // 30 días: una cuenta que usás cada tanto tiene que seguir estando.
  const corte = Date.now() - 30 * 24 * 3600_000;
  const proveedores = [...visto.entries()]
    .filter(([, d]) => d.getTime() >= corte)
    .sort((a, b) => (enDias.get(b[0])?.tokens ?? 0) - (enDias.get(a[0])?.tokens ?? 0));

  return proveedores.map(([prov, cuando]): FilaPerfil => {
    const c = enDias.get(prov) ?? { proveedor: prov, modelo: null, tokens: 0, sesiones: 0, costo: 0 };
    return ({
    producto: 'opencode',
    localMedido: true,
    perfil: {
      directorio: 'opencode',
      nombre: bonito[prov] ?? prov,
      porDefecto: false,
      // El plan es el proveedor, no el modelo. Acá iba `c.modelo` —el id del
      // modelo más usado— y eso ponía `glm-5.3` donde las otras filas ponen
      // `team_tier_1` o `plus`: un modelo no es un plan, y además cambia solo
      // cuando cambiás de modelo. El modelo ya se muestra en el desglose de
      // abajo, que es su lugar.
      cuenta: { email: null, organizacion: 'opencode', plan: prov },
    },
    veredicto: `vía opencode · último uso hace ${duracion(Date.now() - cuando.getTime())}`,
    cuota: cuotaDeLimite(prov, limites.get(prov)),
    notaRefresco: null,
    proyeccion: null,
    archivos: c.sesiones,
    requests: c.sesiones,
    tokens: c.tokens,
    tokensVentana: enVentana.get(c.proveedor) ?? 0,
    porModelo: c.modelo === null ? [] : [[c.modelo, c.tokens]],
  });
  });
}

/**
 * Lo que se puede afirmar de un plan por API key.
 *
 * No hay porcentaje —se probó: ni `/models` ni una llamada real devuelven
 * cabeceras de límite en zai ni en minimax—. Pero cuando el proveedor te frena
 * contesta un 429 con la fecha de reinicio, y opencode guarda esa respuesta.
 * Con eso alcanza para lo único que se hace con el número: saber si estás
 * frenado y cuándo te liberás.
 *
 * Si el reinicio ya pasó, no se afirma nada: se dice que no hay barra y cuándo
 * fue la última vez que te frenaron. Un límite de la semana pasada no dice nada
 * de hoy.
 */
function cuotaDeLimite(prov: string, lim: LimiteOpencode | undefined): ResultadoCuota {
  const sinBarra = (extra: string): ResultadoCuota => ({
    estado: 'sin-cuota-legible',
    detalle: `plan por API key: el porcentaje no está en esta máquina${extra}`,
  });
  if (lim === undefined) return sinBarra('');
  if (lim.reinicia !== null && lim.reinicia.getTime() > Date.now()) {
    // Evidencia directa: el proveedor dijo que te frenó y cuándo se libera.
    return {
      estado: 'ok',
      origen: 'cache',
      medidoEn: lim.cuando,
      ventanas: [
        {
          clave: 'plan',
          alcance: null,
          grupo: 'weekly',
          porcentaje: 100,
          severidad: 'warning',
          activa: true,
          reinicia: lim.reinicia,
        },
      ],
    };
  }
  return sinBarra(` · último límite hace ${duracion(Date.now() - lim.cuando.getTime())}`);
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
  const todas = [...claude, ...(codex === null ? [] : [codex]), ...filasOpencode(o)];
  // Descubrir todo y mostrar todo no son lo mismo: lo primero es la misión,
  // lo segundo es una preferencia.
  const { filas, nota } = seleccionar(todas, configEfectiva());
  if (nota !== null && !o.json && !o.breve) console.error(tenue(`  (${nota} · ${RUTA_CONFIG})`));
  return filas;
}

/** La config del archivo, con --solo / --ocultar pisándola. */
function configEfectiva(): Config {
  const base = leerConfigUsuario();
  const arg = (n: string): string[] | null => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a === undefined ? null : a.slice(n.length + 3).split(',').filter((x) => x !== '');
  };
  const solo = arg('solo');
  const ocultar = arg('ocultar');
  return {
    mostrar: solo ?? base.mostrar,
    ocultar: ocultar ?? base.ocultar,
  };
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
    // El ritmo dice hacia dónde vas; el presupuesto, a cuánto tenés que ir.
    if (f.cuota.estado === 'ok') {
      const pre = presupuestoDiario(f.cuota.ventanas);
      console.log(
        `  ${relleno('', 18)} ${tenue('presupuesto: ')}` +
          (pre.estado === 'ok'
            ? `${frasePresupuesto(pre)}${tenue(` · ${nombreVentana(pre.ventana)}`)}`
            : tenue(pre.motivo)),
      );
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

/** Las muestras recientes de la barra que frena, ya recortadas a la ventana de ajuste. */
function historiaDe(f: FilaPerfil): { t: number; porcentaje: number }[] {
  if (f.cuota.estado !== 'ok') return [];
  const v = peor(paraMostrar(f.cuota.ventanas));
  if (v === null) return [];
  const ahora = Date.now();
  return muestras(f.perfil.nombre, claveBarra(v.clave, v.alcance))
    .filter((m) => ahora - m.t <= VENTANA_AJUSTE_MS && m.t <= ahora)
    .sort((a, b) => a.t - b.t)
    .map((m) => ({ t: m.t, porcentaje: m.porcentaje }));
}

function ventanaJson(v: VentanaCuota): Record<string, unknown> {
  return {
    clave: v.clave,
    alcance: v.alcance,
    grupo: v.grupo,
    porcentaje: v.porcentaje,
    severidad: v.severidad,
    activa: v.activa,
    reinicia: v.reinicia?.toISOString() ?? null,
    nombre: nombreVentana(v),
    preocupa: esPreocupante(v),
  };
}

const ventanaJson0 = (v: VentanaCuota | null): Record<string, unknown> | null =>
  v === null ? null : ventanaJson(v);

/**
 * El presupuesto diario, masticado igual que `frena` y `semanal`: qué ventana se
 * repartió, cuánto por día y cuánto queda de hoy. Los que dibujan no dividen
 * nada — la cuenta, incluido CUÁL ventana se reparte, vive en el núcleo.
 */
function presupuestoJson(cuota: ResultadoCuota): Record<string, unknown> {
  if (cuota.estado !== 'ok') return { estado: 'sin-datos', motivo: 'esta cuenta no tiene número de cuota' };
  const p: Presupuesto = presupuestoDiario(cuota.ventanas);
  if (p.estado !== 'ok') return { estado: 'sin-datos', motivo: p.motivo };
  const un = (n: number): number => Number(n.toFixed(1));
  return {
    estado: 'ok',
    barra: nombreVentana(p.ventana),
    clave: p.ventana.clave,
    alcance: p.ventana.alcance,
    porDia: un(p.porDia),
    quedaHoy: un(p.quedaHoy),
    restante: un(p.restante),
    horasHoy: un(p.horasHoy),
    horasRestantes: un(p.horasRestantes),
  };
}

/**
 * La versión del CONTRATO de `qm --json`, que no es la del paquete.
 *
 * Sube cuando un campo cambia de significado o desaparece; agregar un campo
 * nuevo no la mueve. Existe porque este JSON dejó de ser nuestro: lo leen las
 * cuatro superficies del repo, la statusline, el módulo de waybar y cualquiera
 * que escriba la suya. Sin un número, la única forma que tiene un consumidor de
 * enterarse de que cambió algo es que se le rompa la pantalla — que es
 * exactamente el silencio que este repo no acepta.
 *
 * Documentado en docs/esquema-json.md.
 */
const ESQUEMA_JSON = 1;

function comoJson(filas: readonly FilaPerfil[], o: Opciones): unknown {
  return {
    esquema: ESQUEMA_JSON,
    version: VERSION,
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
              ventanas: f.cuota.ventanas.map(ventanaJson),
              // Las respuestas ya masticadas. Existen para que los que dibujan
              // NO reimplementen las reglas: `peor()` y `paraMostrar()` llegaron
              // a estar copiadas en Python, JavaScript y Swift, y una regla
              // copiada tres veces vale distinto en cada pantalla en cuanto
              // alguien toca el núcleo.
              mostrar: paraMostrar(f.cuota.ventanas).map(ventanaJson),
              frena: ventanaJson0(peor(paraMostrar(f.cuota.ventanas))),
              sesion: ventanaJson0(sesion(paraMostrar(f.cuota.ventanas))),
              semanal: ventanaJson0(semanal(paraMostrar(f.cuota.ventanas))),
              // La serie de la barra que frena, para que se pueda DIBUJAR el
              // ritmo en vez de sólo afirmarlo. «100 % en 21m» pide creerle a
              // un número sin nada atrás; la curva se mira y se entiende sola,
              // y además muestra las mesetas, que es cuando la recta no aplica.
              historia: historiaDe(f),
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
      // Cuánto se puede gastar por día para que la ventana larga llegue entera
      // al reinicio, y cuánto de eso queda hoy. Va al lado de la proyección
      // porque contesta la otra mitad de la misma pregunta: el ritmo dice hacia
      // dónde vas, el presupuesto a cuánto tendrías que ir.
      presupuesto: presupuestoJson(f.cuota),
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
  // --cuentas=a,b limita a quiénes se les pregunta. Cada cuenta que se salta
  // es un pedido menos a un endpoint que no es nuestro.
  const filtro = process.argv.find((a) => a.startsWith('--cuentas='));
  const cuentas = filtro === undefined ? null : new Set(filtro.slice('--cuentas='.length).split(','));
  let bien = false;
  if (!soloCodex) {
    for (const perfil of descubrirPerfiles()) {
      if (cuentas !== null && !cuentas.has(perfil.nombre)) continue;
      const r = await consultarCuota(perfil);
      if (r.estado === 'ok') {
        guardarEndpoint(perfil.nombre, r);
        bien = true;
      }
    }
  }
  const c = cuentas !== null && !cuentas.has('codex')
    ? { cuota: { estado: 'no-consultada' as const } }
    : await consultarCodex();
  process.exit(c.cuota.estado === 'ok' || bien ? 0 : 1);
}

/**
 * `--esperar`: no volver hasta que se pueda trabajar.
 *
 * Es la otra mitad de `--umbral`. Ese contesta «¿estoy pasado?» y sirve para
 * abortar; este contesta «avisame cuándo pueda» y sirve para encadenar:
 *
 *     qm --esperar --cuenta=codex && codex exec "seguí donde quedaste"
 *
 * Duerme hasta el reinicio de la barra que frena —no hace polling ciego— con
 * un piso de 60 s, que es el mismo piso que tiene todo lo que sale a la red.
 */
if (process.argv.includes('--esperar')) {
  const arg = (n: string): string | null =>
    process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const cuenta = arg('cuenta');
  const umbral = Number(arg('umbral') ?? 80);
  const opts = { ...(parsearArgs([]) as Opciones), breve: true };
  for (;;) {
    const filas = (await medir(opts)).filter((f) => cuenta === null || f.perfil.nombre.includes(cuenta));
    if (filas.length === 0) {
      console.error(cuenta === null ? 'no hay ninguna cuenta' : `no encontré la cuenta "${cuenta}"`);
      process.exit(2);
    }
    let peorPct = 0;
    let cuando: Date | null = null;
    for (const f of filas) {
      if (f.cuota.estado !== 'ok') continue;
      const v = peor(paraMostrar(f.cuota.ventanas));
      if (v === null) continue;
      if (v.porcentaje > peorPct) {
        peorPct = v.porcentaje;
        cuando = v.reinicia;
      }
    }
    if (peorPct < umbral) {
      console.log(`libre: la barra que más apremia va ${peorPct} % (umbral ${umbral} %)`);
      process.exit(0);
    }
    // Dormir hasta el reinicio, no sondear a ciegas.
    const faltan = cuando === null ? 60_000 : Math.max(60_000, cuando.getTime() - Date.now() + 5_000);
    console.error(
      `${peorPct} % · esperando ${duracion(faltan)}` +
        (cuando === null ? '' : ` (reinicia ${cuando.toLocaleTimeString()})`),
    );
    await new Promise((r) => setTimeout(r, faltan));
  }
}

const opciones = parsearArgs(process.argv.slice(2));
if (typeof opciones === 'string') {
  console.log(opciones);
  // La ayuda y la versión son respuestas, no errores: salen 0. Lo único que
  // sale 2 es una opción que no existe.
  process.exit(opciones === AYUDA || opciones.startsWith('quartermaster ') ? 0 : 2);
}

const unaVuelta = async (): Promise<number> => {
  const filas = await medir(opciones);
  if (filas.length === 0) {
    // --json es un contrato, y tiene que devolver JSON también cuando la
    // respuesta es «ninguna». Antes escupía una frase en castellano, así que
    // cualquier statusline o script que lo parseara se rompía justo en la
    // máquina donde todavía no hay nada instalado — que es la primera vez que
    // alguien lo corre.
    if (opciones.json) console.log(JSON.stringify(comoJson(filas, opciones), null, 2));
    else console.log('No se encontró ninguna cuenta de Claude Code ni de Codex en esta máquina.');
    // Y no es un error: que no haya cuentas es una respuesta, no una falla.
    return 0;
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
