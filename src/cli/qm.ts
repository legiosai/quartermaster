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
import { fileURLToPath } from 'node:url';
import { ofrecerBarra } from '../adapters/barra.ts';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { estadoCredencial } from '../adapters/credenciales.ts';
import { consumoDesde, transcripciones, ultimaActividad } from '../adapters/transcripciones.ts';
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
  ultimaActividadCodex,
} from '../adapters/codex.ts';
import { endpointEnCache, frenadoHasta, guardarEndpoint, masNueva } from '../adapters/cache-endpoint.ts';
import { decidirConsulta } from '../core/pedir.ts';
import * as entorno from '../adapters/entorno.ts';
import { cuentaPedida, leerConfigUsuario, RUTA_CONFIG, seleccionar, type Config } from '../core/config.ts';
import {
  DIAS_DORMIDA,
  elQueFrena,
  ordenarPorRelevancia,
  relevancia,
  type Relevancia,
} from '../core/relevancia.ts';
import {
  consumoOpencode,
  hayOpencode,
  limitesOpencode,
  ultimoUsoOpencode,
  type LimiteOpencode,
} from '../adapters/opencode.ts';
import { consultarCuotaZai, PROVEEDORES_ZAI } from '../adapters/zai.ts';
import {
  esPreocupante,
  frase,
  nombreVentana,
  paraMostrar,
  peor,
  semanal,
  sesion,
  totalTokens,
  vencida as vencidaVentana,
  type Perfil,
  type ResultadoCuota,
  type VentanaCuota,
} from '../core/tipos.ts';
import {
  barra,
  barraSinColor,
  duracion,
  negrita,
  relleno,
  rojo,
  tenue,
  tokens,
  verde,
  amarillo,
  reinicio,
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
  qm --calentar       refresca el endpoint de cada perfil, el de Codex y el de
                      z.ai (si hay una cuenta en opencode), guarda
                      lo que vuelve y no imprime nada. Es lo que corre la barra
  qm --cuentas=a,b    con --calentar: sólo esas cuentas. Cada una que se saltea
                      es un pedido menos a un endpoint que no es nuestro
  qm --calentar-codex igual pero sólo Codex, sin tocar el llavero
  qm --diagnostico    todo lo que hace falta para reportar un bug, en un solo
                      comando y ya redactado: pegalo tal cual en el issue

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
  /**
   * Cuándo fue la última actividad local de esta cuenta, según sus
   * transcripciones. null si no se pudo medir.
   *
   * No es decoración: es la única señal que dice si un número se está
   * MOVIENDO. El nivel dice cuánto queda; la actividad dice si va a cambiar.
   */
  ultimoUso: Date | null;
  /** false cuando no hay de dónde medirlo: informar 0 sería mentir. */
  localMedido: boolean;
  /**
   * La credencial está vencida.
   *
   * Existe como booleano y no leyendo `veredicto` porque `veredicto` es un
   * texto para mostrar: una regla del núcleo que lo compare con la cadena
   * 'vencida' se rompe el día que alguien mejore la redacción.
   */
  credencialVencida: boolean;
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
    // La credencial la administra codex: desde acá no se puede saber si venció.
    credencialVencida: false,
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
    // La fecha del rollout más nuevo. Cuesta un stat por archivo y ningún
    // parseo, así que también vale en --breve — que es donde más hace falta,
    // porque es el modo que corren todas las barras.
    ultimoUso: ultimaActividadCodex(),
  };
}

/**
 * Las dos formas del mismo proveedor. opencode no usa un `providerID` estable
 * entre instalaciones: en la máquina donde se escribió esto la base guarda
 * `zai` a secas, y el mapa original sólo tenía `zai-coding-plan` — así que la
 * fila se llamaba `zai` y el nombre lindo no se aplicaba nunca. Verificado
 * contra la base: los providerID reales son zai, openai, amazon-bedrock,
 * anthropic y opencode-go.
 *
 * Vive acá afuera y no adentro de `filasOpencode()` porque `--calentar` filtra
 * con `--cuentas=` por el nombre que ve el usuario —`glm`, no `zai`—, y dos
 * copias del mapa serían dos respuestas distintas a «¿esta cuenta la pediste?».
 */
const NOMBRE_OPENCODE: Readonly<Record<string, string>> = {
  zai: 'glm',
  'zai-coding-plan': 'glm',
  minimax: 'minimax',
  'minimax-coding-plan': 'minimax',
  kimi: 'kimi',
  'kimi-for-coding': 'kimi',
  xai: 'grok',
  'opencode-go': 'opencode-go',
};

function nombreOpencode(prov: string): string {
  return NOMBRE_OPENCODE[prov] ?? prov;
}

/**
 * Los planes que viven adentro de opencode: GLM (zai), MiniMax, Kimi…
 *
 * Traen consumo real siempre, y cuota cuando se la puede conseguir: para z.ai
 * hay un endpoint y se consulta con `--refrescar`; para el resto el porcentaje
 * sólo existe del otro lado y la fila lleva la frase que dice por qué no hay
 * barra. Lo que no pasa nunca es que la fila no esté — una cuenta que gastó
 * 2,7 M de tokens y no aparece es el bug original de este repo, con otro vendor.
 */
async function filasOpencode(o: Opciones): Promise<FilaPerfil[]> {
  // Antes esto salía en --breve, y con eso la fila desaparecía de TODAS las
  // pantallas: todas piden --breve. Una cuenta con una key de z.ai que se usó
  // ayer y no aparece es, literalmente, el bug que da nombre a la primera
  // sección del README. Lo que costaba era limitesOpencode() —439 ms—, así que
  // se arregló la consulta en vez de esconder la fila: opencode entero son
  // ~25 ms, que sí entran en el contrato de --breve.
  if (!hayOpencode()) return [];
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

  return await Promise.all(proveedores.map(async ([prov, cuando]): Promise<FilaPerfil> => {
    const c = enDias.get(prov) ?? { proveedor: prov, modelo: null, tokens: 0, sesiones: 0, costo: 0 };
    return ({
    producto: 'opencode',
    localMedido: true,
    // opencode guarda sus propias credenciales y no informa vencimiento.
    credencialVencida: false,
    perfil: {
      directorio: 'opencode',
      nombre: nombreOpencode(prov),
      porDefecto: false,
      // El plan es el proveedor, no el modelo. Acá iba `c.modelo` —el id del
      // modelo más usado— y eso ponía `glm-5.3` donde las otras filas ponen
      // `team_tier_1` o `plus`: un modelo no es un plan, y además cambia solo
      // cuando cambiás de modelo. El modelo ya se muestra en el desglose de
      // abajo, que es su lugar.
      cuenta: { email: null, organizacion: 'opencode', plan: prov },
    },
    veredicto: `vía opencode · último uso hace ${duracion(Date.now() - cuando.getTime())}`,
    cuota: await cuotaDeOpencode(prov, limites.get(prov), o),
    notaRefresco: null,
    proyeccion: null,
    archivos: c.sesiones,
    requests: c.sesiones,
    tokens: c.tokens,
    tokensVentana: enVentana.get(c.proveedor) ?? 0,
    // La fecha POR PROVEEDOR, que es la que ya se usa dos renglones más arriba
    // para el veredicto. Acá decía null con un comentario que explicaba que la
    // única fecha disponible era la de toda la base — dejó de ser cierto cuando
    // se agregó `ultimoUsoOpencode()`, que hace `max(time_updated) group by
    // proveedor`. El dato estaba, y se escribía sólo como texto.
    ultimoUso: cuando,
    porModelo: c.modelo === null ? [] : [[c.modelo, c.tokens]],
  });
  }));
}

/**
 * La cuota de una fila de opencode, de las tres fuentes que puede tener.
 *
 * Por orden de lo que cuesta, que es el orden de SOUL —primero el número que no
 * pide permiso—:
 *
 *   1. El **429 guardado** en la base. Gratis, sin credencial, y lo único que
 *      hay para los proveedores sin endpoint conocido. Dice «te frenaron» y
 *      cuándo te liberás, que es lo que se hace con el número.
 *   2. El **cache** de la última consulta al endpoint de z.ai. También gratis y
 *      sin credencial: lo escribió `--refrescar` o `--calentar` en su momento.
 *   3. El **endpoint** de z.ai, sólo con `--refrescar`. Es el único que abre
 *      `auth.json`.
 *
 * Entre las tres gana la más nueva, y eso no es una preferencia de estilo: un
 * 429 de hace dos horas describe mejor el presente que una barra al 40 % de
 * hace dos días, y una barra de recién describe mejor el presente que un 429
 * de anteayer. `masNueva()` ya era la regla para Claude y es la misma acá.
 */
async function cuotaDeOpencode(
  prov: string,
  lim: LimiteOpencode | undefined,
  o: Opciones,
): Promise<ResultadoCuota> {
  let cuota = masNueva(cuotaDeLimite(prov, lim), endpointEnCache(`opencode:${prov}`));
  if (o.refrescar && PROVEEDORES_ZAI.has(prov)) {
    const fresca = await consultarCuotaZai(prov);
    if (fresca.estado === 'ok') {
      guardarEndpoint(`opencode:${prov}`, fresca);
      cuota = fresca;
    }
    // Si no sirvió no se pisa nada: el cache y el 429 siguen siendo mejores
    // que una frase de error donde había un número.
  }
  return cuota;
}

/**
 * Lo que se puede afirmar de un plan por API key **sin salir a la red**.
 *
 * En el disco no hay porcentaje —se probó: ni `/models` ni una llamada real
 * devuelven cabeceras de límite en zai ni en minimax, y opencode no guarda
 * ninguna—. Pero cuando el proveedor te frena contesta un 429 con la fecha de
 * reinicio, y opencode guarda esa respuesta. Con eso alcanza para lo único que
 * se hace con el número: saber si estás frenado y cuándo te liberás.
 *
 * Para z.ai hay además una barra de verdad, pero cuesta la clave y por eso vive
 * en `zai.ts` detrás de `--refrescar`. Ésta es la que hay siempre.
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
          credencialVencida: cred.vencida,
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
          // Sí se mide incluso en --breve: es barato (un stat por transcripción,
          // sin parsear) y es justo lo que la barra necesita para decidir a qué
          // cuenta le pregunta la cuota.
          ultimoUso: ultimaActividad(perfil),
        };
      }

      const c = await consumoDesde(perfil, desde);
      const v = await consumoDesde(perfil, desdeVentana);

      return {
        producto: 'claude',
        localMedido: true,
        credencialVencida: cred.vencida,
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
        // La misma fuente que en --breve, a propósito: un solo campo con un
        // solo significado. `c.ultimo` diría casi lo mismo pero sólo existe
        // cuando se parsearon las transcripciones, y entonces el valor
        // cambiaría de origen según la bandera.
        ultimoUso: ultimaActividad(perfil),
      };
    }),
  );

  const codex = o.codex ? await filaCodex(o) : null;
  const todas = [...claude, ...(codex === null ? [] : [codex]), ...(await filasOpencode(o))];
  // Descubrir todo y mostrar todo no son lo mismo: lo primero es la misión,
  // lo segundo es una preferencia.
  const { filas, nota } = seleccionar(todas, configEfectiva());
  if (nota !== null && !o.json && !o.breve) console.error(tenue(`  (${nota} · ${RUTA_CONFIG})`));
  // Y acá, lo último: las dormidas al fondo. Ordenar es del núcleo y no de cada
  // pantalla — ninguno de los seis renderers ordena perfiles, así que con esto
  // alcanza para que el orden sea el mismo en todos.
  return ordenarPorRelevancia(filas, (f) => relevanciaDe(f, o));
}

/**
 * Dónde va esta fila: al frente o al fondo.
 *
 * Traduce lo que sabe una `FilaPerfil` a las señales que entiende el núcleo. La
 * traducción vive acá y no adentro de `relevancia()` para que el núcleo no
 * tenga que saber qué es un perfil de Claude ni una fila de Codex.
 */
function relevanciaDe(f: FilaPerfil, o: Opciones): Relevancia {
  return relevancia({
    plan: f.perfil.cuenta?.plan ?? null,
    ultimoUso: f.ultimoUso,
    // `localMedido` es la diferencia entre «cero» y «no lo medí», y el núcleo
    // trata esas dos cosas distinto a propósito.
    requests: f.localMedido ? f.requests : null,
    ventanaDias: f.localMedido ? o.dias : null,
    credencialVencida: f.credencialVencida,
  });
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

/**
 * «cache · hace 25m». Que la edad viaje pegada al número es la mitad del punto.
 *
 * La edad sale de `medidoEn` y de nada más. Acá decía `endpoint · ahora` fijo
 * para todo lo que tuviera `origen: 'endpoint'`, y eso era falso desde que
 * existe `endpointEnCache()`: una lectura del endpoint **guardada** conserva su
 * origen y se muestra con su `medidoEn` viejo, así que un número de hace tres
 * días se anunciaba como de recién. Se veía poco mientras las filas de Claude
 * tenían además el cache de `.claude.json` para ganarle; las de opencode no
 * tienen otra fuente, y ahí quedó a la vista.
 *
 * Un número viejo presentado como actual es la misma mentira que el silencio,
 * que es la frase con la que arranca `cache-cuota.ts`.
 */
function sello(r: Extract<ResultadoCuota, { estado: 'ok' }>): string {
  const edadMs = Date.now() - r.medidoEn.getTime();
  // Menos de un minuto es «ahora» y no «hace 3s»: el segundero no le sirve a
  // nadie y hace que la pantalla parezca cambiar cuando no cambió nada.
  const texto = edadMs < 60_000 ? `${r.origen} · ahora` : `${r.origen} · hace ${duracion(edadMs)}`;
  // Seis horas es más que cualquier ventana de 5 h: a esa altura el número
  // puede describir una ventana que ya se reinició.
  return edadMs > 6 * 3600_000 ? amarillo(`${texto} — viejo`) : tenue(texto);
}

function pintarVentana(v: VentanaCuota, marca: boolean): void {
  const pct = `${v.porcentaje.toFixed(0)}%`.padStart(4);
  // Una ventana cuyo reinicio ya pasó lleva un número de la ventana ANTERIOR:
  // el 13 % de una sesión que cerró anteayer no dice nada de la de hoy. No se
  // inventa un 0 % (ver `vencida()` en tipos.ts), pero tampoco se pinta como
  // vigente: barra y cifra van en tenue, sin color de nivel ni aviso de
  // severidad, y el pie dice «reinició hace» en vez de «reinicia en vencido».
  const vencida = vencidaVentana(v);
  const resta = v.reinicia ? tenue(` ${reinicio(v.reinicia.getTime() - Date.now())}`) : '';
  const aviso = !vencida && v.severidad !== 'normal' ? ` ${amarillo(v.severidad)}` : '';
  const flecha = marca ? negrita('▸ ') : '  ';
  const medidor = vencida
    ? `${tenue(barraSinColor(v.porcentaje / 100))} ${tenue(pct)}`
    : `${barra(v.porcentaje / 100)} ${colorPct(v.porcentaje)(pct)}`;
  console.log(`  ${relleno('', 17)}${flecha}${relleno(nombreVentana(v), 24)} ${medidor}${aviso}${resta}`);
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
      const pre = presupuestoDiario(f.cuota.ventanas, Date.now(), historialDe(f.cuota, f.perfil.nombre));
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
    // Por qué esta cuenta quedó al fondo. Una cuenta que baja de lugar sin
    // decir por qué es una decisión invisible, y una decisión invisible es
    // indistinguible de un bug.
    const rel = relevanciaDe(f, o);
    if (rel.dormida) {
      console.log(`  ${relleno('', 18)} ${tenue(`dormida: ${rel.porque.join(' · ')} — no encabeza`)}`);
    }
    console.log();
  }

  // El renglón que sirve cuando no querés leer la tabla entera.
  // Quién encabeza NO es «el porcentaje más alto»: una cuenta dormida en 100 %
  // ganaría siempre, porque 100 es el máximo. La regla está en el núcleo y la
  // comparten las seis pantallas.
  const lider = elQueFrena(filas, (f) => frenaDe(f)?.porcentaje ?? null, (f) => relevanciaDe(f, o).dormida);
  const top = lider === null ? undefined : { f: lider, v: frenaDe(lider)! };
  if (top) {
    console.log(
      `  ${negrita('lo primero que te frena:')} ${top.f.perfil.nombre} · ${nombreVentana(top.v)} ${colorPct(top.v.porcentaje)(`${top.v.porcentaje.toFixed(0)}%`)}` +
        (top.v.reinicia ? tenue(` · ${reinicio(top.v.reinicia.getTime() - Date.now())}`) : ''),
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
function pintarBreve(filas: readonly FilaPerfil[], o: Opciones): void {
  const partes: string[] = [];
  for (const f of filas) {
    if (f.cuota.estado !== 'ok') continue;
    const v = peor(paraMostrar(f.cuota.ventanas));
    if (v === null) continue;
    const viejo = Date.now() - f.cuota.medidoEn.getTime() > 6 * 3600_000 ? '~' : '';
    // El «!» ya no es sólo severidad: también avisa que a este ritmo tocás el
    // techo antes de que la ventana se reinicie, que es lo que duele.
    const chocas = f.proyeccion?.estado === 'sube' && f.proyeccion.chocas;
    // Una cuenta dormida no lleva «!». El signo existe para avisarte de algo
    // que te va a frenar, y una cuenta que nadie usa no te frena: en una
    // statusline de una línea, ese «!» es ruido permanente.
    const aviso = !relevanciaDe(f, o).dormida && (v.severidad !== 'normal' || chocas) ? '!' : '';
    // Dos números, dos preguntas: la sesión dice si podés seguir AHORA, y la
    // barra que frena antes dice si llegás al final de la ventana larga. Una
    // sola de las dos deja media respuesta.
    const sesion = paraMostrar(f.cuota.ventanas).find((w) => w.grupo === 'session' || w.clave === 'session');
    // Una ventana que ya se reinició no tiene número: el guardado es de la
    // anterior y el real no está en esta máquina. En una statusline eso es «?»
    // y no un 13 % que parece de ahora — el «~» ya dice que la lectura es
    // vieja, pero un número viejo de una ventana abierta y uno de una ventana
    // cerrada son cosas distintas, y sólo el segundo se sabe inútil.
    const cifraDe = (w: VentanaCuota): string => (vencidaVentana(w) ? '?' : w.porcentaje.toFixed(0));
    const cifra =
      sesion === undefined || sesion.clave === v.clave
        ? `${cifraDe(v)}%`
        : `${cifraDe(sesion)}/${cifraDe(v)}%`;
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
    // Campo agregado, no reemplazo: `porcentaje` sigue siendo el último número
    // leído. `vencida` dice que ese número es de una ventana que ya cerró, así
    // que quien dibuje sabe que no puede presentarlo como actual.
    vencida: vencidaVentana(v),
  };
}

const ventanaJson0 = (v: VentanaCuota | null): Record<string, unknown> | null =>
  v === null ? null : ventanaJson(v);

/**
 * El presupuesto diario, masticado igual que `frena` y `semanal`: qué ventana se
 * repartió, cuánto por día y cuánto queda de hoy. Los que dibujan no dividen
 * nada — la cuenta, incluido CUÁL ventana se reparte, vive en el núcleo.
 */
/**
 * Las muestras históricas de la barra larga de esta cuenta, que es la que el
 * presupuesto reparte. Sin esto `gastadoHoy` es siempre null y la frase cae al
 * modo «reparto por hora».
 */
function historialDe(cuota: ResultadoCuota, perfil: string): { t: number; porcentaje: number }[] {
  if (cuota.estado !== 'ok') return [];
  const larga = semanal(cuota.ventanas);
  if (larga === null) return [];
  return muestras(perfil, claveBarra(larga.clave, larga.alcance));
}

function presupuestoJson(cuota: ResultadoCuota, perfil: string): Record<string, unknown> {
  if (cuota.estado !== 'ok') return { estado: 'sin-datos', motivo: 'esta cuenta no tiene número de cuota' };
  const p: Presupuesto = presupuestoDiario(cuota.ventanas, Date.now(), historialDe(cuota, perfil));
  if (p.estado !== 'ok') return { estado: 'sin-datos', motivo: p.motivo };
  const un = (n: number): number => Number(n.toFixed(1));
  return {
    estado: 'ok',
    barra: nombreVentana(p.ventana),
    clave: p.ventana.clave,
    alcance: p.ventana.alcance,
    porDia: un(p.porDia),
    // El presupuesto de HOY, fijado al arrancar la medición, y lo que queda de
    // él. Los que dibujan leen estos dos: restarle lo gastado a `porDia`, que
    // ya lo tiene adentro, contaba cada punto dos veces.
    porDiaHoy: un(p.porDiaHoy),
    restanteMedido: p.restanteMedido === null ? null : un(p.restanteMedido),
    quedaHoy: un(p.quedaHoy),
    // Lo que subió la barra desde la medianoche, y lo que queda del día
    // descontándolo. `null` es «el historial no cubre el día», no «cero».
    gastadoHoy: p.gastadoHoy === null ? null : un(p.gastadoHoy),
    restanteHoy: p.restanteHoy === null ? null : un(p.restanteHoy),
    // Lo mismo, pero sin exigir que el día esté cubierto: `medidoDesde` dice
    // desde qué instante vale. Es lo que dibujan los medidores diarios de las
    // bandejas, que en una máquina que se apaga de noche no tendrían nada que
    // dibujar si el único número fuera el del día completo.
    gastadoMedido: p.gastadoMedido === null ? null : un(p.gastadoMedido),
    medidoDesde: p.medidoDesde === null ? null : new Date(p.medidoDesde).toISOString(),
    cubreElDia: p.cubreElDia,
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
    // QUIÉN ENCABEZA, ya resuelto.
    //
    // Antes no estaba, y la consecuencia era medible: la elección del perfil
    // que encabeza estaba escrita SEIS veces —terminal, GNOME, macOS, Windows,
    // tablero y waybar— y las seis decían «el `frena` con el porcentaje más
    // alto». Seis copias son seis respuestas el día que alguien cambia el
    // criterio, que es exactamente lo que pasó: bajar las cuentas dormidas
    // habría arreglado una pantalla y dejado las otras cinco como estaban.
    //
    // Es el mismo argumento que dejó escrito `frena` adentro de cada cuota, una
    // vuelta más arriba: el CLI resuelve, los renderers dibujan.
    frenaPrimero: ((): unknown => {
      const lider = elQueFrena(filas, (f) => frenaDe(f)?.porcentaje ?? null, (f) => relevanciaDe(f, o).dormida);
      if (lider === null) return null;
      return {
        perfil: lider.perfil.nombre,
        producto: lider.producto,
        ventana: ventanaJson0(frenaDe(lider)),
        // true cuando NO quedaba ninguna despierta: el encabezado es lo único
        // que había, y quien dibuja puede decirlo en vez de afirmarlo a secas.
        dormida: relevanciaDe(lider, o).dormida,
      };
    })(),
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
      presupuesto: presupuestoJson(f.cuota, f.perfil.nombre),
      // Cuándo se usó esta cuenta por última vez.
      //
      // Va AL LADO de `local` y no adentro, a propósito. `local` se anula
      // entero en --breve y está bien que así sea: son cuentas de consumo que
      // ahí no se midieron, e informar 0 sería decir «no consumiste nada»
      // cuando lo que pasa es «no lo medí».
      //
      // Esto es otra clase de hecho —cuándo, no cuánto— y se mide distinto: un
      // stat por transcripción, sin parsear nada. Así que existe en los dos
      // modos, que es lo que hace falta: el consumidor es el sondeo de la
      // barra, y el sondeo corre --breve. Adentro de `local` el campo estaba
      // escrito pero nunca llegaba a quien lo necesitaba.
      ultimoUso: f.ultimoUso?.toISOString() ?? null,
      // Dónde va esta cuenta en la lista, y por qué. `porque` es prosa para
      // mostrar al lado; no se parsea, igual que `frase`.
      relevancia: relevanciaDe(f, o),
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

/** La ventana que frena en esta fila, ya resuelta. null si no hay número. */
function frenaDe(f: FilaPerfil): VentanaCuota | null {
  return f.cuota.estado === 'ok' ? peor(paraMostrar(f.cuota.ventanas)) : null;
}

/**
 * El porcentaje más alto que IMPORTA, para --umbral.
 *
 * Las dormidas no cuentan, y no es un detalle de presentación: `--esperar` usa
 * el mismo criterio y duerme hasta el reinicio de la barra más alta. Con una
 * cuenta free abandonada en 100 % que reinicia en quince días, `qm --esperar &&
 * codex ...` se quedaba esperando quince días para correr un comando que podía
 * correr ya. El umbral tiene que mirar lo que te frena de verdad.
 *
 * Si TODAS están dormidas se las mira igual: en ese caso son lo único que hay,
 * y devolver 0 sería afirmar que no hay ninguna barra alta.
 */
function maximo(filas: readonly FilaPerfil[], o: Opciones): number {
  const cuentan = filas.filter((f) => !relevanciaDe(f, o).dormida);
  const mirar = cuentan.length > 0 ? cuentan : filas;
  let m = 0;
  for (const f of mirar) {
    if (f.cuota.estado !== 'ok') continue;
    for (const v of f.cuota.ventanas) m = Math.max(m, v.porcentaje);
  }
  return m;
}

/**
 * La lectura del estado de la extensión, en palabras.
 *
 * Existe porque los dos datos que hacen falta —el estado y las dos fechas— por
 * separado no dicen nada a quien no conoce GNOME. Juntos dicen exactamente qué
 * hacer, y es una sola cosa: cerrar sesión.
 */
function veredictoExtension(x: ReturnType<typeof entorno.extension>, e: ReturnType<typeof entorno.escritorio>): string[] {
  if (!x.instalada) return [];
  const enError = 'valor' in x.estado && x.estado.valor.includes('ERROR');
  const masNuevaQueLaSesion =
    x.tocadoMs !== null && e.arrancoMs !== null && x.tocadoMs > e.arrancoMs;

  if (enError && masNuevaQueLaSesion) {
    const horas = ((x.tocadoMs! - e.arrancoMs!) / 3_600_000).toFixed(1);
    return [
      '',
      `  ⚠ extension.js es ${horas} h MÁS NUEVO que la sesión gráfica.`,
      '    El shell carga el módulo una vez y lo deja en memoria: lo que está',
      '    corriendo es el archivo viejo, y el ERROR de arriba es de ESE. En',
      '    Wayland no hay forma de recargarlo —`ReloadExtension` está declarado',
      '    en DBus y devuelve UnknownMethod— así que:',
      '',
      '      → cerrá sesión y volvé a entrar. Es el único paso que falta.',
      '',
      '    Hasta entonces el item lo dibuja AppIndicator y el panel es un menú de',
      '    GTK, que no sostiene el agarre y se cierra apenas lo tocás.',
    ];
  }
  if (enError) {
    return [
      '',
      '  ⚠ la extensión está en ERROR y su archivo NO es más nuevo que la sesión:',
      '    el error de arriba es del código que está corriendo ahora. Esto es un',
      '    bug de verdad — pegá este diagnóstico en un issue.',
    ];
  }
  return [];
}

/**
 * Todo lo que hace falta para reportar un bug, en un solo comando.
 *
 * Va REDACTADO por defecto —las rutas de casa se vuelven `~`, y no se imprime
 * ningún mail, token ni accountUuid— porque un diagnóstico que no se puede
 * pegar en un issue público no sirve para lo único que existe.
 *
 * El orden no es decorativo: arriba va lo que más veces resultó ser la causa.
 * «La sesión arrancó ANTES de que se tocara la extensión» explica, sin que
 * haya que saber nada de GNOME, por qué un arreglo que está en el disco no
 * está corriendo.
 */
function diagnostico(): string {
  const l: string[] = [];
  const t = entorno.texto;
  const titulo = (s: string) => l.push('', `── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);
  const campo = (k: string, v: string) => l.push(`  ${k.padEnd(18)} ${v}`);

  l.push(`quartermaster ${VERSION} · diagnóstico`);
  l.push(`generado ${new Date().toISOString()} · redactado: sin rutas de casa, sin mails, sin tokens`);

  titulo('la máquina');
  const e = entorno.escritorio();
  campo('node', process.version);
  campo('sistema', e.so);
  campo('escritorio', t(e.escritorio));
  campo('sesión', t(e.sesion));
  campo('shell', t(e.shell).split('\n')[0] ?? '—');
  campo('sesión arrancó', t(e.arrancoLaSesion));

  titulo('la extensión de GNOME');
  const x = entorno.extension();
  campo('instalada', x.instalada ? 'sí' : 'NO');
  campo('estado', t(x.estado));
  campo('extension.js', t(x.archivoTocado));
  campo('latido', t(x.latido));
  if ('valor' in x.ultimoError) {
    l.push('  último error que guardó el shell:');
    for (const linea of x.ultimoError.valor.split('\n')) l.push(`    ${linea}`);
  } else {
    campo('último error', t(x.ultimoError));
  }
  // La conclusión, CALCULADA y no insinuada. Es el caso que costó una tarde:
  // el arreglo estaba en el disco, el shell corría el módulo viejo, y desde
  // afuera se veía igual que «el arreglo no sirvió».
  for (const linea of veredictoExtension(x, e)) l.push(linea);

  titulo('el indicador');
  l.push(`  ${t(entorno.indicador()).split('\n').join('\n  ')}`);

  titulo('el cache');
  const c = entorno.cache();
  if (c.length === 0) l.push('  (vacío o inaccesible)');
  for (const f of c) campo(f.nombre, f.edad);

  titulo('lo que anotó el sistema');
  l.push(`  ${t(entorno.journal()).split('\n').join('\n  ')}`);

  l.push('');
  return `${l.join('\n')}\n`;
}

// --diagnostico sale primero: tiene que contestar incluso cuando lo demás está
// roto. Es lo único que se le pide a alguien que reporta un bug.
if (process.argv.includes('--diagnostico')) {
  process.stdout.write(diagnostico());
  process.exit(0);
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
  // Por qué no se calentó cada cuenta que no se calentó. Va a stderr y no a
  // stdout: la barra manda su stderr al log, y un calentado roto que sale 1 sin
  // decir nada es un número viejo sin explicación.
  const fallas: string[] = [];
  if (!soloCodex) {
    for (const perfil of descubrirPerfiles()) {
      if (cuentas !== null && !cuentaPedida(cuentas, perfil.nombre)) continue;
      // Una cuenta con lectura propia reciente no se vuelve a preguntar, y una
      // frenada por un 429 tampoco (ver src/core/pedir.ts). Ninguna de las dos
      // es una falla: la fresca ya tiene su número, la frenada lo tendrá.
      const guardada = endpointEnCache(perfil.nombre);
      const decision = decidirConsulta({
        ultimaLectura: guardada?.estado === 'ok' ? guardada.medidoEn : null,
        reinicios: guardada?.estado === 'ok' ? guardada.ventanas.map((v) => v.reinicia) : [],
        frenadoHasta: frenadoHasta(perfil.nombre),
      }, Date.now());
      if (!decision.consultar) {
        bien = true;
        if (decision.porque === 'frenada') {
          fallas.push(`${perfil.nombre}: el endpoint pidió esperar (HTTP 429): se vuelve a preguntar a las ` +
            decision.hasta.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
        }
        continue;
      }
      const r = await consultarCuota(perfil);
      if (r.estado === 'ok') {
        guardarEndpoint(perfil.nombre, r);
        bien = true;
      } else fallas.push(`${perfil.nombre}: ${frase(r, perfil.directorio)}`);
    }
  }
  // z.ai entra por el mismo lado que los perfiles de Claude: es la otra cuota
  // que sólo existe del otro lado del cable, y sin calentarla las pantallas
  // —que todas corren --breve— nunca verían su barra.
  for (const prov of soloCodex ? [] : ultimoUsoOpencode().keys()) {
    if (!PROVEEDORES_ZAI.has(prov)) continue;
    if (cuentas !== null && !cuentaPedida(cuentas, nombreOpencode(prov))) continue;
    const r = await consultarCuotaZai(prov);
    if (r.estado === 'ok') {
      guardarEndpoint(`opencode:${prov}`, r);
      bien = true;
    } else if (r.estado !== 'sin-credencial' && r.estado !== 'sin-suscripcion') {
      // Sin clave guardada no es una falla: es una cuenta de opencode que no
      // es de z.ai, o una que nunca se autenticó.
      fallas.push(`${nombreOpencode(prov)}: ${frase(r, prov)}`);
    }
  }

  const c = cuentas !== null && !cuentas.has('codex')
    ? { cuota: { estado: 'no-consultada' as const } }
    : await consultarCodex();
  // Sin Codex instalado, o con API key, no hay nada que calentar: no es una falla.
  if (c.cuota.estado !== 'ok' && c.cuota.estado !== 'no-consultada' &&
      c.cuota.estado !== 'sin-cache' && c.cuota.estado !== 'sin-suscripcion') {
    fallas.push(`codex: ${frase(c.cuota, 'codex')}`);
  }
  const codigo = c.cuota.estado === 'ok' || bien ? 0 : 1;
  if (codigo !== 0 && fallas.length === 0) fallas.push('no hay ninguna cuenta a la que preguntarle');
  for (const f of fallas) console.error(`calentar · ${f}`);
  process.exit(codigo);
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
    // Las dormidas no hacen esperar a nadie. Si `--cuenta=` dejó SÓLO dormidas,
    // se las mira igual: pediste esa cuenta y esperar por ella es lo que
    // pediste.
    const despiertas = filas.filter((f) => !relevanciaDe(f, opts).dormida);
    const cuentan = despiertas.length > 0 ? despiertas : filas;
    let peorPct = 0;
    let cuando: Date | null = null;
    for (const f of cuentan) {
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
  else if (opciones.breve) pintarBreve(filas, opciones);
  else pintar(filas, opciones);
  if (opciones.umbral !== null && maximo(filas, opciones) >= opciones.umbral) return 3;
  return 0;
};

if (opciones.watch === null) {
  const codigo = await unaVuelta();
  // Después de los números, nunca antes: la pregunta de la barra es para quien
  // acaba de instalar y corre `qm` a secas. Ver src/adapters/barra.ts.
  const modoNormal = !opciones.json && !opciones.breve && opciones.umbral === null;
  await ofrecerBarra(fileURLToPath(new URL('../..', import.meta.url)), modoNormal);
  process.exit(codigo);
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
