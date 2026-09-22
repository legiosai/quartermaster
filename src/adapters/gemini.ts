// Gemini CLI, el asistente de Google en la misma máquina.
//
// POR QUÉ EXISTE ESTE ARCHIVO.
// La primera exploración en BITACORA.md (h6) descartó a Gemini diciendo que en
// ~/.gemini no había ningún lugar donde contara tokens. Fue un error de
// búsqueda: se miró la raíz de ~/.gemini y ~/.gemini/history (que sólo guarda
// .project_root), pero los transcripts reales viven en ~/.gemini/tmp/*/chats/.
//
// Cada turno de respuesta ("type": "gemini") guarda:
//   · tokens: { input, output, cached, thoughts, tool, total }
//   · model: e.g. "gemini-3-flash-preview"
//   · timestamp e id de turno
//
// Lo que se puede y lo que no, con el vocabulario de SOUL:
//   · El piso, SÍ. Las sesiones en ~/.gemini/tmp/*/chats/session-*.jsonl
//     guardan tokens locales, sin red y sin credencial.
//   · La cuota en porcentaje, NO. Google OAuth personal no informa un
//     porcentaje ni un reinicio en disco ni por endpoint: se reporta
//     `sin-cuota-legible`, exactamente igual que opencode para planes por API key.
//   · Deduplicación obligatoria: cada turno escribe al menos dos líneas con el
//     mismo `id` (al generar el tool call y al completarlo). Deduplicar por
//     `id` es lo único que evita duplicar el consumo real.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONSUMO_VACIO, type Consumo, type EstadoCredencial, type Perfil } from '../core/tipos.ts';

export const DIRECTORIO_GEMINI = join(homedir(), '.gemini');

export interface DuenoGemini {
  readonly email: string | null;
  readonly plan: string | null;
  readonly expiraEn: Date | null;
}

/** ¿Hay instalación de Gemini CLI en esta máquina? */
export function hayGemini(dirGemini = DIRECTORIO_GEMINI): boolean {
  return existsSync(dirGemini);
}

/**
 * De quién es la cuenta activa y qué método de autenticación usa.
 *
 * Lee `google_accounts.json` y `settings.json`. Si no están, devuelve nulls
 * sin tirar error: el monitor no puede morir por un archivo a medio escribir.
 */
export function duenoGemini(dirGemini = DIRECTORIO_GEMINI): DuenoGemini {
  let email: string | null = null;
  let plan: string | null = null;
  let expiraEn: Date | null = null;

  try {
    const rAcc = join(dirGemini, 'google_accounts.json');
    if (existsSync(rAcc)) {
      const j = JSON.parse(readFileSync(rAcc, 'utf8')) as Record<string, unknown>;
      if (typeof j['active'] === 'string' && j['active'].length > 0) {
        email = j['active'];
      }
    }
  } catch {
    // archivo corrupto o inaccesible
  }

  try {
    const rSet = join(dirGemini, 'settings.json');
    if (existsSync(rSet)) {
      const j = JSON.parse(readFileSync(rSet, 'utf8')) as Record<string, unknown>;
      const sec = j['security'] as Record<string, unknown> | undefined;
      const auth = sec?.['auth'] as Record<string, unknown> | undefined;
      if (typeof auth?.['selectedType'] === 'string') {
        plan = auth['selectedType'];
      }
    }
  } catch {
    // ignorar
  }

  try {
    const rCred = join(dirGemini, 'oauth_creds.json');
    if (existsSync(rCred)) {
      const j = JSON.parse(readFileSync(rCred, 'utf8')) as Record<string, unknown>;
      if (typeof j['expiry_date'] === 'number') {
        expiraEn = new Date(j['expiry_date']);
      }
    }
  } catch {
    // ignorar
  }

  return { email, plan, expiraEn };
}

/**
 * Estado de la credencial en `oauth_creds.json`.
 *
 * Nunca lee ni copia el access_token ni el refresh_token: sólo mira la
 * presencia y la fecha de expiración (`expiry_date` en ms).
 */
export function estadoCredencialGemini(dirGemini = DIRECTORIO_GEMINI): EstadoCredencial {
  const ruta = join(dirGemini, 'oauth_creds.json');
  if (!existsSync(ruta)) {
    // Que el archivo NO ESTE no es un error de lectura, y la diferencia se ve
    // en pantalla: con `error` puesto, quien muestra esto dice «ilegible», que
    // afirma que el archivo esta corrupto cuando en realidad no existe. Misma
    // convencion que `credenciales.ts`: ausente es `error: null`, y `vencida`
    // en false porque no hay ninguna fecha que haya pasado.
    return {
      presente: false,
      ubicacion: '~/.gemini/oauth_creds.json',
      expiraEn: null,
      vencida: false,
      error: null,
    };
  }

  try {
    const j = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>;
    const expMs = typeof j['expiry_date'] === 'number' ? j['expiry_date'] : null;
    const expiraEn = expMs !== null ? new Date(expMs) : null;
    const vencida = expiraEn !== null ? expiraEn.getTime() <= Date.now() : false;
    return {
      presente: true,
      ubicacion: '~/.gemini/oauth_creds.json',
      expiraEn,
      vencida,
      error: null,
    };
  } catch (e) {
    // Ilegible tampoco es vencida: no se pudo leer la fecha, no se leyo una
    // fecha pasada. `error` es lo que distingue este caso del de arriba.
    return {
      presente: false,
      ubicacion: '~/.gemini/oauth_creds.json',
      expiraEn: null,
      vencida: false,
      error: e instanceof Error ? e.message : 'credencial ilegible',
    };
  }
}

/**
 * Todos los archivos de transcripción de Gemini CLI (`session-*.jsonl`).
 *
 * Gemini guarda los chats por proyecto en `~/.gemini/tmp/<shortId>/chats/`.
 * Camina recursivamente para no perder subcarpetas.
 */
export function transcripcionesGemini(dirGemini = DIRECTORIO_GEMINI): string[] {
  const dirTmp = join(dirGemini, 'tmp');
  if (!existsSync(dirTmp)) return [];
  const salida: string[] = [];

  let proyectos: string[];
  try {
    proyectos = readdirSync(dirTmp);
  } catch {
    return [];
  }

  for (const p of proyectos) {
    const chatsDir = join(dirTmp, p, 'chats');
    if (!existsSync(chatsDir)) continue;

    const caminar = (dir: string): void => {
      let entradas: string[];
      try {
        entradas = readdirSync(dir);
      } catch {
        return;
      }
      for (const entrada of entradas) {
        const ruta = join(dir, entrada);
        let st;
        try {
          st = statSync(ruta);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          caminar(ruta);
        } else if (entrada.endsWith('.jsonl')) {
          salida.push(ruta);
        }
      }
    };
    caminar(chatsDir);
  }

  return salida;
}

/**
 * Cuándo se usó Gemini CLI por última vez, sin leer el contenido de los archivos.
 * Es el mtime más nuevo de todos los `session-*.jsonl`.
 */
export function ultimaActividadGemini(dirGemini = DIRECTORIO_GEMINI): Date | null {
  let masNuevo = 0;
  for (const archivo of transcripcionesGemini(dirGemini)) {
    try {
      const m = statSync(archivo).mtimeMs;
      if (m > masNuevo) masNuevo = m;
    } catch {
      // archivo que desaparece
    }
  }
  return masNuevo === 0 ? null : new Date(masNuevo);
}

interface AcumuladorGemini {
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

function nuevoAcumulador(): AcumuladorGemini {
  return {
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
}

/**
 * Consumo local de Gemini CLI desde `desde` (inclusive).
 *
 * Mapeo aritmético de tokens:
 *   total = input + output + thoughts
 *   cached = tokens leídos de cache (subconjunto de input)
 *
 * Por ende:
 *   entrada = Math.max(0, input - cached)
 *   lecturaCache = cached
 *   salida = output + thoughts
 *   pensamiento = thoughts
 *
 * Así `totalTokens(c) = entrada + lecturaCache + salida = total` se mantiene exacto.
 */
export async function consumoGemini(
  desde: Date,
  dirGemini = DIRECTORIO_GEMINI,
): Promise<{ consumo: Consumo; archivos: number }> {
  const acc = nuevoAcumulador();
  const vistos = new Set<string>();
  const corte = desde.getTime();
  const archivos = transcripcionesGemini(dirGemini);

  for (const archivo of archivos) {
    try {
      if (statSync(archivo).mtimeMs < corte) continue;
    } catch {
      continue;
    }

    const rl = createInterface({ input: createReadStream(archivo, 'utf8'), crlfDelay: Infinity });
    for await (const linea of rl) {
      if (linea.length === 0 || !linea.includes('"tokens"')) continue;
      let d: Record<string, any>;
      try {
        d = JSON.parse(linea);
      } catch {
        continue;
      }
      if (d['type'] !== 'gemini') continue;
      const uso = d['tokens'];
      if (!uso || typeof uso !== 'object') continue;

      const ts = typeof d['timestamp'] === 'string' ? new Date(d['timestamp']) : null;
      if (!ts || Number.isNaN(ts.getTime()) || ts.getTime() < corte) continue;

      const id = typeof d['id'] === 'string' ? d['id'] : null;
      if (id) {
        if (vistos.has(id)) continue;
        vistos.add(id);
      }

      const inp = Number(uso['input'] ?? 0);
      const out = Number(uso['output'] ?? 0);
      const cached = Number(uso['cached'] ?? 0);
      const thoughts = Number(uso['thoughts'] ?? 0);

      const entrada = Math.max(0, inp - cached);
      const lectura = cached;
      const salida = out + thoughts;
      const pensamiento = thoughts;

      acc.entrada += entrada;
      acc.lecturaCache += lectura;
      acc.salida += salida;
      acc.pensamiento += pensamiento;
      acc.requests += 1;

      const modelo = typeof d['model'] === 'string' ? d['model'] : 'desconocido';
      const total = entrada + lectura + salida;
      acc.porModelo.set(modelo, (acc.porModelo.get(modelo) ?? 0) + total);

      if (!acc.primero || ts < acc.primero) acc.primero = ts;
      if (!acc.ultimo || ts > acc.ultimo) acc.ultimo = ts;
    }
  }

  if (acc.requests === 0) {
    return { consumo: CONSUMO_VACIO, archivos: archivos.length };
  }
  return { consumo: acc, archivos: archivos.length };
}

/**
 * Convierte el estado de Gemini a la forma de Perfil que espera el núcleo de qm.
 */
export function perfilGemini(dirGemini = DIRECTORIO_GEMINI): Perfil {
  const d = duenoGemini(dirGemini);
  return {
    directorio: dirGemini,
    nombre: 'gemini',
    porDefecto: false,
    cuenta: {
      email: d.email,
      organizacion: 'google',
      plan: d.plan,
    },
  };
}
