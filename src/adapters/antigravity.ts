// Antigravity, el IDE agéntico de Google, en la misma máquina.
//
// POR QUÉ ESTE ARCHIVO REEMPLAZA AL DE GEMINI CLI.
// 0.1.17 leyó Gemini CLI: `~/.gemini/tmp/*/chats/session-*.jsonl`. Anda, y
// midió 10,7M en 271 requests — pero el último turno con tokens de esa
// herramienta en la máquina donde se escribió esto es del 14 de junio de 2026.
// Lo que se usa hoy es Antigravity, que comparte `~/.gemini` pero NO escribe
// ahí: guarda una base SQLite por conversación en
// `~/.gemini/antigravity/conversations/<uuid>.db`. Medir la herramienta que no
// se usa y no la que sí es peor que no medir: el panel decía «0 en 7d» mientras
// se gastaban seis millones de tokens.
//
// DE DÓNDE SALE EL NÚMERO. Cada base tiene una tabla `gen_metadata` con un
// protobuf por request. Los nombres de campo no viajan en el formato binario,
// así que lo que hay son números de campo, y su significado está INFERIDO —
// medido sobre 190 requests de una conversación y 545 de un día:
//
//   1.4.1    constante por modelo (1318)   el prompt de sistema
//   1.4.2    crece con la conversación     entrada
//   1.4.3    chico y variable              salida
//   1.4.9    chico y variable              pensamiento
//   1.4.10   chico y variable              herramientas
//   1.9.10.4 256000                        la ventana de contexto del modelo
//
// ESO ES UNA APUESTA, Y SE DEFIENDE COMO TAL. Google puede reordenar esos
// campos en cualquier update y los números pasarían a estar mal EN SILENCIO,
// que es el modo de fallar que el resto del repo existe para no tener. Por eso
// `formaConocida()` comprueba la forma antes de creerle a los números, y
// `consumoAntigravity` devuelve `formaRota: true` en vez de un número inventado
// cuando deja de cumplirse. Un número que no se puede sostener no se muestra.
//
// LA CUOTA, NO. Se buscó: `antigravity_state.pbtxt` no la trae, y el único
// rastro en los logs del IDE es `quota undefined`. El plan de Google no publica
// porcentaje ni reinicio en disco, así que se reporta `sin-cuota-legible`,
// igual que los planes por API key de opencode.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONSUMO_VACIO, type Consumo, type EstadoCredencial, type Perfil } from '../core/tipos.ts';

export const DIRECTORIO_GEMINI = join(homedir(), '.gemini');
export const DIRECTORIO_ANTIGRAVITY = join(DIRECTORIO_GEMINI, 'antigravity');

/** El `state.vscdb` del IDE, que es un fork de VS Code y guarda donde ellos. */
export const RUTA_ESTADO = ((): string => {
  const casa = homedir();
  if (process.platform === 'darwin') {
    return join(casa, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(casa, 'AppData', 'Roaming');
    return join(appdata, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  }
  return join(casa, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
})();

/** Las ventanas de contexto que un modelo de esta familia puede declarar. */
const VENTANAS_CONOCIDAS = new Set([32_768, 65_536, 128_000, 200_000, 256_000, 1_000_000, 2_000_000]);

export interface DuenoAntigravity {
  readonly email: string | null;
  readonly plan: string | null;
}

/** ¿Hay Antigravity en esta máquina? */
export function hayAntigravity(dirAg = DIRECTORIO_ANTIGRAVITY): boolean {
  return existsSync(join(dirAg, 'conversations'));
}

/**
 * De quién es la cuenta. Antigravity comparte `~/.gemini` con Gemini CLI y no
 * guarda identidad propia: el mail sale de `google_accounts.json`, que escriben
 * los dos.
 */
export function duenoAntigravity(dirGemini = DIRECTORIO_GEMINI): DuenoAntigravity {
  let email: string | null = null;
  try {
    const r = join(dirGemini, 'google_accounts.json');
    if (existsSync(r)) {
      const j = JSON.parse(readFileSync(r, 'utf8')) as Record<string, unknown>;
      if (typeof j['active'] === 'string' && j['active'].length > 0) email = j['active'];
    }
  } catch {
    // archivo a medio escribir: el monitor no puede morir por eso
  }
  return { email, plan: planAntigravity() ?? 'antigravity' };
}

/**
 * Estado de la credencial compartida en `~/.gemini/oauth_creds.json`.
 *
 * Nunca lee ni copia el access_token ni el refresh_token: sólo la presencia y
 * `expiry_date`. Misma convención que `credenciales.ts` — ausente es
 * `error: null` y `vencida: false`, porque no hay ninguna fecha que haya pasado.
 */
export function estadoCredencialAntigravity(dirGemini = DIRECTORIO_GEMINI): EstadoCredencial {
  const ruta = join(dirGemini, 'oauth_creds.json');
  const ubicacion = '~/.gemini/oauth_creds.json';
  if (!existsSync(ruta)) {
    return { presente: false, ubicacion, expiraEn: null, vencida: false, error: null };
  }
  try {
    const j = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
    const expMs = typeof j['expiry_date'] === 'number' ? j['expiry_date'] : null;
    const expiraEn = expMs !== null ? new Date(expMs) : null;
    return {
      presente: true,
      ubicacion,
      expiraEn,
      vencida: expiraEn !== null && expiraEn.getTime() <= Date.now(),
      error: null,
    };
  } catch (e) {
    return {
      presente: false,
      ubicacion,
      expiraEn: null,
      vencida: false,
      error: e instanceof Error ? e.message : 'credencial ilegible',
    };
  }
}

/** Las bases de conversación, una por charla. */
export function conversacionesAntigravity(dirAg = DIRECTORIO_ANTIGRAVITY): string[] {
  const dir = join(dirAg, 'conversations');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((e) => e.endsWith('.db'))
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
}

/** Cuándo se usó Antigravity por última vez, sin abrir ninguna base. */
export function ultimaActividadAntigravity(dirAg = DIRECTORIO_ANTIGRAVITY): Date | null {
  let masNuevo = 0;
  for (const b of conversacionesAntigravity(dirAg)) {
    try {
      const m = statSync(b).mtimeMs;
      if (m > masNuevo) masNuevo = m;
    } catch {
      // una base que desaparece entre el listado y el stat
    }
  }
  return masNuevo === 0 ? null : new Date(masNuevo);
}

// ─── El protobuf ───────────────────────────────────────────────────────────
//
// Un recorredor mínimo: alcanza para sacar varints por ruta de campo
// («1.4.2»), que es lo único que hace falta acá. No valida el mensaje ni
// reconstruye tipos; un blob que no parsea devuelve lo que alcanzó a leer y el
// que llama se queda sin los campos que busca, que es exactamente lo que
// `formaConocida()` necesita ver para desconfiar.

function leerVarint(b: Uint8Array, i: number): [number, number] | null {
  let r = 0;
  let desp = 0;
  while (i < b.length) {
    const x = b[i]!;
    r += (x & 0x7f) * 2 ** desp;
    i += 1;
    desp += 7;
    if ((x & 0x80) === 0) return [r, i];
    if (desp > 63) return null;
  }
  return null;
}

/** Los varints del mensaje, indexados por su ruta de campo («1.4.2»). */
export function camposVarint(b: Uint8Array, prof = 0, salida = new Map<string, number>(), ruta = ''): Map<string, number> {
  let i = 0;
  while (i < b.length) {
    const clave = leerVarint(b, i);
    if (!clave) return salida;
    const [k, siguiente] = clave;
    i = siguiente;
    const campo = Math.floor(k / 8);
    const tipo = k & 7;
    if (tipo === 0) {
      const v = leerVarint(b, i);
      if (!v) return salida;
      const nombre = `${ruta}${campo}`;
      if (!salida.has(nombre)) salida.set(nombre, v[0]);
      i = v[1];
    } else if (tipo === 2) {
      const largo = leerVarint(b, i);
      if (!largo) return salida;
      const [n, desde] = largo;
      if (desde + n > b.length) return salida;
      if (prof < 4) camposVarint(b.subarray(desde, desde + n), prof + 1, salida, `${ruta}${campo}.`);
      i = desde + n;
    } else if (tipo === 5) {
      i += 4;
    } else if (tipo === 1) {
      i += 8;
    } else {
      return salida;
    }
  }
  return salida;
}

/** Las cadenas del mensaje, indexadas por su ruta de campo. */
export function camposTexto(b: Uint8Array, prof = 0, salida = new Map<string, string>(), ruta = ''): Map<string, string> {
  let i = 0;
  while (i < b.length) {
    const clave = leerVarint(b, i);
    if (!clave) return salida;
    const [k, siguiente] = clave;
    i = siguiente;
    const campo = Math.floor(k / 8);
    const tipo = k & 7;
    if (tipo === 0) {
      const v = leerVarint(b, i);
      if (!v) return salida;
      i = v[1];
    } else if (tipo === 2) {
      const largo = leerVarint(b, i);
      if (!largo) return salida;
      const [n, desde] = largo;
      if (desde + n > b.length) return salida;
      const cuerpo = b.subarray(desde, desde + n);
      const nombre = `${ruta}${campo}`;
      // Un submensaje y una cadena se ven igual en el alambre. Se guarda como
      // texto cuando es imprimible, y ADEMÁS se baja, porque el mismo campo
      // puede ser las dos cosas en mensajes distintos.
      const t = Buffer.from(cuerpo).toString('utf8');
      if (n > 0 && !/[\u0000-\u0008\u000e-\u001f]/.test(t) && !salida.has(nombre)) salida.set(nombre, t);
      if (prof < 6) camposTexto(cuerpo, prof + 1, salida, `${nombre}.`);
      i = desde + n;
    } else if (tipo === 5) {
      i += 4;
    } else if (tipo === 1) {
      i += 8;
    } else {
      return salida;
    }
  }
  return salida;
}

/**
 * ¿El protobuf sigue teniendo la forma sobre la que se infirieron los campos?
 *
 * La evidencia OBLIGATORIA es el grupo `1.4.*` completo: es de donde salen los
 * números, y si Google renumera esos campos dejan de estar y no hay nada que
 * sumar. Eso solo ya hace ruido si el formato cambia.
 *
 * `1.9.10.4` —la ventana de contexto— CORROBORA cuando está, y no se exige
 * cuando no: medido sobre 566 requests de una semana, 152 traen el grupo
 * completo y ninguna ventana. Exigirla tiraba el 27 % del consumo real y lo
 * presentaba como si no hubiera existido, que es el mismo error en silencio
 * que este gate existe para evitar, sólo que hacia el otro lado. Pero si está
 * y dice cualquier cosa, entonces lo que se está leyendo ya no es lo que se
 * creía, y ahí sí se desconfía.
 */
export function formaConocida(campos: Map<string, number>): boolean {
  for (const c of ['1.4.1', '1.4.2', '1.4.3', '1.4.9', '1.4.10']) {
    if (!campos.has(c)) return false;
  }
  const ventana = campos.get('1.9.10.4');
  return ventana === undefined || VENTANAS_CONOCIDAS.has(ventana);
}

/**
 * El plan de Google, leído del estado del IDE.
 *
 * Antigravity es un fork de VS Code y guarda su estado en el `state.vscdb` de
 * siempre. La clave `antigravityUnifiedStateSync.userStatus` trae un base64 que
 * envuelve OTRO base64 (el sobre tiene `userStatusSentinelKey` y el contenido
 * va en `1.2.1`), y adentro, en el campo 36, está la suscripción: `36.1` el id
 * del tier (`g1-pro-tier`) y `36.2` el nombre para mostrar (`Google AI Pro`).
 *
 * POR QUÉ ESTO Y NO LA CUOTA. Se buscó la cuota en serio y NO ESTÁ: las 120
 * claves del estado, el leveldb del Local Storage, `antigravity_state.pbtxt` y
 * los logs del IDE, donde el único rastro es `quota undefined`. Lo más cercano
 * es `modelCredits`, que guarda dos centinelas —`availableCredits` en 0 y un
 * mínimo de 50— que no se mueven con el uso. Así que el porcentaje sigue sin
 * existir en disco, pero el PLAN sí, y decir «Google AI Pro» en vez de un
 * genérico es la diferencia entre no saber y no haber mirado.
 *
 * NUNCA se lee `antigravityAuthStatus`: esa clave guarda el access token en
 * texto plano. Acá no hace falta y no se toca.
 */
export function planAntigravity(rutaEstado = RUTA_ESTADO): string | null {
  if (!existsSync(rutaEstado)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(rutaEstado, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const fila = db
      .prepare('select value from ItemTable where key = ?')
      .get('antigravityUnifiedStateSync.userStatus') as { value?: unknown } | undefined;
    const v = fila?.value;
    const texto = typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : null;
    if (!texto) return null;

    const sobre = camposTexto(new Uint8Array(Buffer.from(texto, 'base64')));
    const dentro = sobre.get('1.2.1');
    if (!dentro) return null;

    const campos = camposTexto(new Uint8Array(Buffer.from(dentro, 'base64')));
    return campos.get('36.2') ?? campos.get('36.1') ?? null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ya cerrada */
    }
  }
}

interface Acumulador {
  entrada: number;
  creacionCache: number;
  lecturaCache: number;
  salida: number;
  pensamiento: number;
  requests: number;
  porModelo: Map<string, number>;
  primero: Date | null;
  ultimo: Date | null;
}

/**
 * Consumo de Antigravity desde `desde` (inclusive).
 *
 * El corte es por mtime de la base, no por request: el protobuf no trae una
 * fecha por generación que se pueda leer sin adivinar otro campo, y adivinar
 * dos cosas para afinar una es peor que decir la verdad más gruesa. Una
 * conversación tocada dentro de la ventana cuenta entera. `granularidad` lo
 * dice, para que quien muestre el número no lo presente como si fuera exacto.
 */
export function consumoAntigravity(
  desde: Date,
  dirAg = DIRECTORIO_ANTIGRAVITY,
): { consumo: Consumo; bases: number; formaRota: boolean; granularidad: 'conversacion' } {
  const acc: Acumulador = {
    entrada: 0,
    creacionCache: 0,
    lecturaCache: 0,
    salida: 0,
    pensamiento: 0,
    requests: 0,
    porModelo: new Map(),
    primero: null,
    ultimo: null,
  };
  const corte = desde.getTime();
  const bases = conversacionesAntigravity(dirAg);
  let vistas = 0;
  let rotas = 0;

  for (const ruta of bases) {
    let cuando: number;
    try {
      cuando = statSync(ruta).mtimeMs;
    } catch {
      continue;
    }
    if (cuando < corte) continue;

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(ruta, { readOnly: true });
    } catch {
      // Una base abierta por el IDE, a medio escribir, o de una versión que ya
      // no se puede leer. Saltarla es correcto; morir, no.
      continue;
    }
    try {
      const filas = db.prepare('select data from gen_metadata').all() as { data: unknown }[];
      for (const f of filas) {
        const d = f.data;
        if (!(d instanceof Uint8Array)) continue;
        const campos = camposVarint(d);
        if (!formaConocida(campos)) {
          rotas += 1;
          continue;
        }
        const entrada = campos.get('1.4.2') ?? 0;
        const salida = campos.get('1.4.3') ?? 0;
        const pensamiento = campos.get('1.4.9') ?? 0;
        const herramientas = campos.get('1.4.10') ?? 0;

        acc.entrada += entrada;
        acc.salida += salida + pensamiento + herramientas;
        acc.pensamiento += pensamiento;
        acc.requests += 1;

        const total = entrada + salida + pensamiento + herramientas;
        acc.porModelo.set('antigravity', (acc.porModelo.get('antigravity') ?? 0) + total);
      }
      vistas += 1;
      const fecha = new Date(cuando);
      if (!acc.primero || fecha < acc.primero) acc.primero = fecha;
      if (!acc.ultimo || fecha > acc.ultimo) acc.ultimo = fecha;
    } catch {
      // `gen_metadata` que no existe: otra versión del formato.
      rotas += 1;
    } finally {
      try {
        db.close();
      } catch {
        /* ya cerrada */
      }
    }
  }

  // Si NO se contó ni un request y hubo blobs que no tenían la forma esperada,
  // el formato cambió. Eso no es «cero consumo»: es «no sé», y decir cero sería
  // mentir con un número redondo.
  const formaRota = acc.requests === 0 && rotas > 0;
  if (acc.requests === 0) {
    return { consumo: CONSUMO_VACIO, bases: vistas, formaRota, granularidad: 'conversacion' };
  }
  return { consumo: acc, bases: vistas, formaRota: false, granularidad: 'conversacion' };
}

/** Antigravity con la forma de Perfil que espera el núcleo de qm. */
export function perfilAntigravity(dirGemini = DIRECTORIO_GEMINI): Perfil {
  const d = duenoAntigravity(dirGemini);
  return {
    directorio: DIRECTORIO_ANTIGRAVITY,
    nombre: 'antigravity',
    porDefecto: false,
    cuenta: { email: d.email, organizacion: 'google', plan: d.plan },
  };
}
