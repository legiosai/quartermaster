// Codex, el otro asiento de la misma máquina.
//
// **Corrección.** La primera versión de este archivo decía que Codex no deja la
// cuota en el disco, y estaba mal. Se había mirado `rate_limits` en tres
// rollouts de junio, que venían `null`, y se generalizó. Los rollouts nuevos
// (codex-cli 0.153.4) sí la traen: adentro de los eventos `token_count`, con la
// forma `{limit_id, primary:{used_percent, window_minutes, resets_at}, secondary}`
// y con el timestamp del evento al lado. Verificado contra ocho rollouts y
// contra el número en vivo.
//
// Eso alinea a Codex con H5 en vez de convertirlo en la excepción: **el camino
// por defecto es el disco**, gratis y sin red, y el app-server queda como
// refresco —lo que `--refrescar` es para Claude—. El número del disco es tan
// viejo como la última vez que Codex corrió, igual que el de Claude Code, así
// que se muestra la edad y listo.
//
// No tocamos su credencial: al app-server se le habla por el binario `codex`,
// que usa la suya. Es el mismo trato que el indicador y el tablero tienen con
// `qm`: pedir, no manipular.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { OrigenCuota, ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

export const DIRECTORIO_CODEX = join(homedir(), '.codex');

/**
 * Dónde está el binario `codex`.
 *
 * Existe por la misma razón que la búsqueda de Node en `bin/qm`: launchd arranca
 * la barra con `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, y `codex` vive en
 * /opt/homebrew/bin. Confiar en el PATH hacía que el refresco fallara **en
 * silencio** justo en la instalación que importa —la que corre sola— mientras
 * andaba perfecto desde una terminal. El número quedaba viejo sin que nadie
 * pudiera explicar por qué.
 */
function rutaCodex(): string | null {
  const delEntorno = process.env['QM_CODEX'];
  if (delEntorno !== undefined && delEntorno !== '' && existsSync(delEntorno)) return delEntorno;
  const esWindows = process.platform === 'win32';
  const separador = esWindows ? ';' : ':';
  const nombres = esWindows ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const delPath = (process.env['PATH'] ?? '').split(separador).filter((d) => d !== '');
  const extra = esWindows ? [] : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')];
  for (const dir of [...delPath, ...extra]) {
    for (const nombre of nombres) {
      const c = join(dir, nombre);
      if (existsSync(c)) return c;
    }
  }
  return null;
}
const CACHE = join(homedir(), '.cache', 'quartermaster', 'codex.json');
/** Si el app-server no contestó en esto, no contesta. */
const TIMEOUT_MS = 20_000;

/**
 * De quién es la cuenta, leído del id_token que Codex ya tiene guardado.
 *
 * Es un JWT: el payload va en base64url y se lee sin verificar nada, porque no
 * se está autenticando a nadie — se está poniendo un nombre arriba de una
 * barra. Nunca sale de acá otra cosa que el mail y el plan: el token no se
 * copia, no se loguea y no se toca. Como en Claude, se lee la credencial y no
 * se escribe.
 */
export interface DuenoCodex {
  readonly email: string | null;
  readonly plan: string | null;
  readonly refrescada: Date | null;
}

export function duenoCodex(): DuenoCodex | null {
  try {
    const auth = JSON.parse(readFileSync(join(DIRECTORIO_CODEX, 'auth.json'), 'utf8')) as Record<string, unknown>;
    const tokens = (auth['tokens'] as Record<string, unknown>) ?? {};
    const idToken = tokens['id_token'];
    const refrescada = typeof auth['last_refresh'] === 'string' ? new Date(auth['last_refresh']) : null;
    if (typeof idToken !== 'string') return { email: null, plan: null, refrescada };
    const payload = idToken.split('.')[1];
    if (payload === undefined) return { email: null, plan: null, refrescada };
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const extra = (json['https://api.openai.com/auth'] as Record<string, unknown>) ?? {};
    return {
      email: (json['email'] as string) ?? null,
      plan: (extra['chatgpt_plan_type'] as string) ?? null,
      refrescada,
    };
  } catch {
    return null;
  }
}

/**
 * Cómo está autenticado Codex: con la cuenta de ChatGPT o con una API key.
 *
 * Es la señal AUTORITATIVA de si hay suscripción, y hay que mirarla antes que
 * los rollouts. Encontrado en la máquina donde se escribió esto: ocho rollouts
 * que decían `plan_type: "plus"` con barras de hasta el 94 %, todos de mayo, y
 * un `auth.json` que decía `auth_mode: "apikey"`. La suscripción existió y se
 * dio de baja; los rollouts de cuando existía siguen en el disco para siempre.
 * Sin mirar el modo, qm reportaba un plan que ya no está y unas barras de hace
 * 127 días como si fueran de ahora — y peor, en una cuenta que no tiene barras
 * porque paga por uso.
 *
 * Es el mismo caso que las filas de opencode: un plan por API key cuyo
 * porcentaje sólo existe del otro lado.
 */
export type ModoCodex = 'apikey' | 'chatgpt' | null;

/**
 * La decisión sola, sin tocar el disco. Exportada para poder probarla, igual
 * que `parsearRateLimits`: es donde vive la regla que se puede romper sin que
 * nadie se entere.
 */
export function modoDeAuth(auth: Record<string, unknown>): ModoCodex {
  const modo = auth['auth_mode'];
  if (modo === 'apikey' || modo === 'chatgpt') return modo;
  // Los auth.json viejos no traían auth_mode: se deduce de qué guardaron.
  const tokens = (auth['tokens'] as Record<string, unknown>) ?? {};
  if (typeof tokens['id_token'] === 'string') return 'chatgpt';
  if (typeof auth['OPENAI_API_KEY'] === 'string') return 'apikey';
  return null;
}

export function modoCodex(): ModoCodex {
  try {
    return modoDeAuth(JSON.parse(readFileSync(join(DIRECTORIO_CODEX, 'auth.json'), 'utf8')) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export interface CuentaCodex {
  readonly plan: string | null;
  readonly accountId: string | null;
  /** Los «full reset» sin usar que regala OpenAI. Es plata en la mano. */
  readonly creditosReset: number;
}

/** Los rollouts, del más nuevo al más viejo. Es donde Codex deja todo. */
function rollouts(desde?: Date): string[] {
  const raiz = join(DIRECTORIO_CODEX, 'sessions');
  if (!existsSync(raiz)) return [];
  const encontrados: { ruta: string; mtime: number }[] = [];
  const caminar = (dir: string, hondo: number): void => {
    if (hondo > 4) return;
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) caminar(ruta, hondo + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const m = statSync(ruta).mtimeMs;
          if (desde === undefined || m >= desde.getTime()) encontrados.push({ ruta, mtime: m });
        } catch {
          /* un archivo que se fue mientras mirábamos no es motivo de nada */
        }
      }
    }
  };
  caminar(raiz, 0);
  return encontrados.sort((a, b) => b.mtime - a.mtime).map((e) => e.ruta);
}

/**
 * Recorre un rollout buscando un campo, y devuelve la última aparición.
 *
 * Se filtra por el CAMPO y no por el nombre del evento a propósito: Codex
 * escribe las mismas barras en `event_msg/token_count` y en
 * `token_usage_record`, y filtrar por uno de los dos se pierde las del otro.
 *
 * Y hace falta un `valido` además de que el campo exista, porque Codex escribe
 * **varios baldes de límites**: después del bueno (`limit_id: "codex"`) manda
 * uno de `limit_id: "premium"` con `primary: null`. Quedarse con el último a
 * secas devolvía ese, y descartar el evento descartaba el archivo entero — con
 * el número bueno adentro, unos milisegundos antes.
 */
function ultimoConCampo(
  ruta: string,
  campo: string,
  valido: (v: Record<string, unknown>) => boolean = () => true,
): { evento: Record<string, unknown> | null; veces: number } {
  let texto: string;
  try {
    texto = readFileSync(ruta, 'utf8');
  } catch {
    return { evento: null, veces: 0 };
  }
  const marca = `"${campo}"`;
  let evento: Record<string, unknown> | null = null;
  let veces = 0;
  for (const linea of texto.split('\n')) {
    // El chequeo de string primero: parsear cada línea de 138 archivos cuesta,
    // y la enorme mayoría no tiene nada que ver.
    if (!linea.includes(marca)) continue;
    try {
      const d = JSON.parse(linea) as Record<string, unknown>;
      const p = (d['payload'] as Record<string, unknown>) ?? d;
      const dentro = (p[campo] ?? d[campo]) as unknown;
      if (typeof dentro !== 'object' || dentro === null) continue;
      if (!valido(dentro as Record<string, unknown>)) continue;
      veces += 1;
      evento = { ...p, [campo]: dentro, timestamp: d['timestamp'] ?? p['timestamp'] };
    } catch {
      /* una línea cortada al final del archivo es normal */
    }
  }
  return { evento, veces };
}

/** ¿Este balde de límites trae un porcentaje de verdad, o vino vacío? */
export function tieneBarras(rl: Record<string, unknown>): boolean {
  const p = rl['primary'];
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof (o['used_percent'] ?? o['usedPercent']) === 'number';
}

/**
 * La cuota que Codex ya dejó en el disco. Sin red y sin credencial.
 *
 * Se mira el rollout más nuevo primero y se corta apenas aparece una lectura:
 * el resto son sesiones viejas con números peores.
 */
export function codexEnDisco(): LecturaCodex {
  if (!hayCodex()) return { cuota: { estado: 'sin-cache' }, info: null };
  // Una API key no tiene barras de suscripción, y los rollouts de cuando SÍ
  // había suscripción no se borran. El modo manda sobre el rollout: si no,
  // se reporta un plan de baja y un porcentaje de hace meses.
  if (modoCodex() === 'apikey') return { cuota: { estado: 'sin-suscripcion' }, info: null };
  // Se miran varios y gana el evento MÁS NUEVO, no el primer archivo que traiga
  // barras: el mtime del rollout y la fecha del último token_count no siempre
  // coinciden —una sesión vieja puede reescribirse— y quedarse con el primero
  // devolvía un número de hace horas teniendo uno de hace minutos al lado.
  let mejor: { rl: Record<string, unknown>; medidoEn: Date } | null = null;
  for (const ruta of rollouts().slice(0, 12)) {
    const { evento } = ultimoConCampo(ruta, 'rate_limits', tieneBarras);
    const rl = evento?.['rate_limits'] as Record<string, unknown> | undefined;
    if (rl === undefined) continue;
    const ts = typeof evento?.['timestamp'] === 'string' ? new Date(evento['timestamp'] as string) : null;
    const medidoEn = ts !== null && !Number.isNaN(ts.getTime()) ? ts : new Date(statSync(ruta).mtimeMs);
    if (mejor === null || medidoEn.getTime() > mejor.medidoEn.getTime()) mejor = { rl, medidoEn };
  }
  if (mejor === null) return { cuota: { estado: 'sin-cache' }, info: null };
  return parsear(normalizar(mejor.rl), mejor.medidoEn, 'cache');
}

/**
 * El rollout usa snake_case (`used_percent`, `window_minutes`) y el app-server
 * camelCase (`usedPercent`, `windowDurationMins`). Es la misma respuesta con
 * dos vestidos, así que se normaliza acá y `parsear` no se entera.
 */
function normalizar(rl: Record<string, unknown>): Record<string, unknown> {
  const ventana = (v: unknown): unknown => {
    if (typeof v !== 'object' || v === null) return v;
    const o = v as Record<string, unknown>;
    return {
      usedPercent: o['usedPercent'] ?? o['used_percent'],
      windowDurationMins: o['windowDurationMins'] ?? o['window_minutes'],
      resetsAt: o['resetsAt'] ?? o['resets_at'],
    };
  };
  return {
    ...rl,
    primary: ventana(rl['primary']),
    secondary: ventana(rl['secondary']),
    planType: rl['planType'] ?? rl['plan_type'],
    // Esta faltaba, y el test la encontró: leído del disco, «ya te frenó» no
    // marcaba nada porque sólo se miraba la forma camelCase del app-server.
    rateLimitReachedType: rl['rateLimitReachedType'] ?? rl['rate_limit_reached_type'],
    rateLimitResetCredits: rl['rateLimitResetCredits'] ?? rl['rate_limit_reset_credits'],
    accountId: rl['accountId'] ?? rl['account_id'],
  };
}

/**
 * Consumo local de Codex, leído de los mismos rollouts. Es el PISO que SOUL
 * pide y que a esta cuenta le faltaba: si el app-server se cae y el disco no
 * trae barras, igual hay un número.
 *
 * Se suma el ÚLTIMO `total_token_usage` de cada rollout, que es acumulado por
 * sesión: sumar los `last_token_usage` contaría cada turno además de estar ya
 * incluido en el acumulado.
 */
export function consumoCodex(desde: Date): { tokens: number; requests: number; archivos: number } {
  let tokens = 0;
  let requests = 0;
  const archivos = rollouts(desde);
  for (const ruta of archivos) {
    const { evento, veces } = ultimoConCampo(ruta, 'info', (i) => i['total_token_usage'] !== undefined);
    const info = evento?.['info'] as Record<string, unknown> | undefined;
    const total = info?.['total_token_usage'] as Record<string, unknown> | undefined;
    if (total === undefined) continue;
    const n = (k: string): number => (typeof total[k] === 'number' ? (total[k] as number) : 0);
    tokens += n('input_tokens') + n('cache_write_input_tokens') + n('output_tokens');
    requests += veces;
  }
  return { tokens, requests, archivos: archivos.length };
}

export interface LecturaCodex {
  readonly cuota: ResultadoCuota;
  readonly info: CuentaCodex | null;
}

/** ¿Hay Codex en esta máquina? Si no, no se dice nada de él. */
export function hayCodex(): boolean {
  return existsSync(DIRECTORIO_CODEX);
}

/**
 * Una ventana de Codex. El nombre sale de la duración, no de la clave: el
 * servidor manda `primary`/`secondary`, que no dicen nada, y 300 minutos es lo
 * mismo que la `session` de Claude aunque se llame distinto. Igualar los
 * nombres es lo que permite comparar las dos cuentas en la misma columna.
 */
function ventana(crudo: Record<string, unknown>, alcanzado: boolean): VentanaCuota | null {
  const pct = crudo['usedPercent'];
  const mins = crudo['windowDurationMins'];
  if (typeof pct !== 'number') return null;
  const minutos = typeof mins === 'number' ? mins : 0;
  const reinicia = typeof crudo['resetsAt'] === 'number' ? new Date(crudo['resetsAt'] * 1000) : null;
  const corta = minutos > 0 && minutos <= 24 * 60;
  return {
    clave: corta ? 'session' : 'weekly_all',
    alcance: null,
    grupo: corta ? 'session' : 'weekly',
    porcentaje: Math.round(pct),
    // Codex no manda severidad. La única que sabe es «ya te frenó»; el resto
    // lo decide el 80 % de esPreocupante, igual que para cualquier barra.
    severidad: alcanzado ? 'warning' : 'normal',
    activa: false,
    reinicia,
  };
}

/**
 * Un balde de límites de Codex -> la forma que entiende el núcleo.
 *
 * Exportada para poder probarla: es donde viven las dos decisiones que se
 * pueden romper sin que nadie se entere —el nombre de la ventana sale de su
 * duración, y las dos puntas (rollout en snake_case, app-server en camelCase)
 * tienen que dar exactamente lo mismo—.
 */
export function parsearRateLimits(
  rateLimits: Record<string, unknown>,
  medidoEn: Date,
  origen: OrigenCuota = 'endpoint',
): LecturaCodex {
  return parsear(normalizar(rateLimits), medidoEn, origen);
}

function parsear(rateLimits: Record<string, unknown>, medidoEn: Date, origen: OrigenCuota = 'endpoint'): LecturaCodex {
  const alcanzado = rateLimits['rateLimitReachedType'] != null;
  const ventanas: VentanaCuota[] = [];
  for (const clave of ['primary', 'secondary']) {
    const v = rateLimits[clave];
    if (typeof v === 'object' && v !== null) {
      const w = ventana(v as Record<string, unknown>, alcanzado);
      if (w !== null) ventanas.push(w);
    }
  }
  const creditos = (rateLimits['rateLimitResetCredits'] as Record<string, unknown>) ?? {};
  const disponibles = creditos['availableCount'] ?? creditos['available_count'];
  const info: CuentaCodex = {
    plan: (rateLimits['planType'] as string) ?? null,
    accountId: (rateLimits['accountId'] as string) ?? null,
    creditosReset: typeof disponibles === 'number' ? disponibles : 0,
  };
  if (ventanas.length === 0) {
    return { cuota: { estado: 'sin-suscripcion' }, info };
  }
  return { cuota: { estado: 'ok', origen, medidoEn, ventanas }, info };
}

// ── el cache, que acá lo escribimos nosotros ─────────────────────────────
interface CacheCodex {
  fetchedAtMs: number;
  rateLimits: Record<string, unknown>;
}

function leerCache(): CacheCodex | null {
  try {
    const c = JSON.parse(readFileSync(CACHE, 'utf8')) as CacheCodex;
    if (typeof c.fetchedAtMs !== 'number' || typeof c.rateLimits !== 'object') return null;
    return c;
  } catch {
    return null;
  }
}

function escribirCache(c: CacheCodex): void {
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(c));
  } catch {
    // Si no se puede escribir se pierde la edad, no el número.
  }
}

/** Lo último que supimos, sin red. Es el camino por defecto. */
export function codexEnCache(): LecturaCodex {
  if (!hayCodex()) return { cuota: { estado: 'sin-cache' }, info: null };
  const c = leerCache();
  if (c === null) {
    return {
      cuota: { estado: 'sin-cache' },
      info: null,
    };
  }
  return parsear(c.rateLimits, new Date(c.fetchedAtMs));
}

/**
 * El número de verdad, hablando JSON-RPC con el app-server de Codex.
 *
 * Se le manda `initialize` y después `account/rateLimits/read`, y se lee hasta
 * que aparece la respuesta con ese id. stdin se deja abierto: si se cierra, el
 * app-server se va antes de contestar.
 */
export async function consultarCodex(): Promise<LecturaCodex> {
  if (!hayCodex()) return { cuota: { estado: 'sin-cache' }, info: null };
  // Con API key no hay límites de suscripción que pedir: levantar un
  // app-server para que conteste eso es gastar 20 s de timeout.
  if (modoCodex() === 'apikey') return { cuota: { estado: 'sin-suscripcion' }, info: null };

  return new Promise<LecturaCodex>((resolver) => {
    const binario = rutaCodex();
    if (binario === null) {
      resolver({
        cuota: {
          estado: 'error',
          detalle: 'no encontré el binario codex (probá con QM_CODEX=/ruta/a/codex)',
        },
        info: null,
      });
      return;
    }
    let hijo: ReturnType<typeof spawn>;
    try {
      hijo = spawn(binario, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolver({ cuota: { estado: 'error', detalle: `no pude correr ${binario}` }, info: null });
      return;
    }

    let terminado = false;
    const terminar = (r: LecturaCodex) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      hijo.kill();
      resolver(r);
    };

    const reloj = setTimeout(
      () => terminar({ cuota: { estado: 'error', detalle: `el app-server de codex no contestó en ${TIMEOUT_MS / 1000} s` }, info: null }),
      TIMEOUT_MS,
    );

    hijo.on('error', () =>
      terminar({ cuota: { estado: 'error', detalle: 'no pude correr `codex app-server`' }, info: null }),
    );
    hijo.on('exit', () =>
      terminar({ cuota: { estado: 'error', detalle: 'el app-server de codex se cerró sin contestar' }, info: null }),
    );

    let resto = '';
    hijo.stdout?.on('data', (trozo: Buffer) => {
      resto += trozo.toString('utf8');
      let corte: number;
      while ((corte = resto.indexOf('\n')) >= 0) {
        const linea = resto.slice(0, corte);
        resto = resto.slice(corte + 1);
        if (linea.trim() === '') continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(linea) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg['id'] !== 2) continue;
        const res = msg['result'] as Record<string, unknown> | undefined;
        const rl = res?.['rateLimits'] as Record<string, unknown> | undefined;
        if (rl === undefined) {
          terminar({ cuota: { estado: 'ilegible', detalle: 'la respuesta no traía rateLimits' }, info: null });
          return;
        }
        // El accountId y los créditos viven un nivel más arriba que las barras.
        const plano = normalizar({ ...rl, accountId: res?.['accountId'], rateLimitResetCredits: res?.['rateLimitResetCredits'] });
        const ahora = Date.now();
        escribirCache({ fetchedAtMs: ahora, rateLimits: plano });
        terminar(parsear(plano, new Date(ahora)));
        return;
      }
    });

    const pedir = (id: number, method: string, params: unknown) =>
      hijo.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');

    pedir(1, 'initialize', {
      clientInfo: { name: 'quartermaster', version: '0.0.0', title: 'quartermaster' },
    });
    pedir(2, 'account/rateLimits/read', {});
    // stdin queda abierto a propósito.
  });
}
