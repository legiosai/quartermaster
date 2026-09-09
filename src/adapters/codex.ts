// Codex, el otro asiento de la misma máquina.
//
// La diferencia con Claude Code es la que importa para todo lo que sigue:
// **Codex no deja la cuota en el disco.** No hay un `cachedUsageUtilization`
// que leer. Su propio TUI la pide en cada arranque por JSON-RPC contra el
// app-server que él mismo levanta (`account/rateLimits/read`), y muestra lo que
// vuelve. Verificado en codex-cli 0.153.4: en `~/.codex` no hay ni un número de
// cuota, y los `rate_limits` que aparecen en los rollouts viejos vienen `null`.
//
// Eso invierte la regla de H5. Para Claude el camino barato es el disco y la
// red es el refresco; acá la red es el único camino, así que **el cache lo
// escribimos nosotros**: se guarda cada lectura en ~/.cache/quartermaster y se
// muestra la edad, exactamente como se hace con la de Claude. Un número viejo
// presentado como actual es la misma mentira en los dos lados.
//
// No tocamos la credencial de Codex ni sabemos dónde vive: se le habla al
// binario `codex`, que usa la suya. Es el mismo trato que tenemos con `qm` en
// el indicador y en el tablero — pedir, no manipular.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResultadoCuota, VentanaCuota } from '../core/tipos.ts';

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

export interface CuentaCodex {
  readonly plan: string | null;
  readonly accountId: string | null;
  /** Los «full reset» sin usar que regala OpenAI. Es plata en la mano. */
  readonly creditosReset: number;
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

function parsear(rateLimits: Record<string, unknown>, medidoEn: Date): LecturaCodex {
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
  const info: CuentaCodex = {
    plan: (rateLimits['planType'] as string) ?? null,
    accountId: (rateLimits['accountId'] as string) ?? null,
    creditosReset: (creditos['availableCount'] as number) ?? 0,
  };
  if (ventanas.length === 0) {
    return { cuota: { estado: 'sin-suscripcion' }, info };
  }
  return { cuota: { estado: 'ok', origen: 'endpoint', medidoEn, ventanas }, info };
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
        const plano = { ...rl, accountId: res?.['accountId'], rateLimitResetCredits: res?.['rateLimitResetCredits'] };
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
