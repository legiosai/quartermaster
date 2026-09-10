// Las cuentas que viven adentro de opencode: GLM (zai), MiniMax, Kimi y las
// demás que uno haya conectado ahí.
//
// **No se lee su archivo de credenciales.** opencode guarda las claves en
// `auth.json`, y este adaptador no lo abre ni una vez: los proveedores se
// descubren de la base de sesiones, que dice cuáles se usaron de verdad —que
// además es más útil que cuáles están configurados—. Menos superficie, y la
// única forma de no filtrar una clave es no leerla.
//
// Lo que se puede y lo que no, con el vocabulario de SOUL:
//
//   · **El piso, sí.** `session` guarda tokens y costo por sesión, con el
//     proveedor adentro de `model`. Es consumo local, sin red y sin credencial,
//     exactamente como las transcripciones de Claude y los rollouts de Codex.
//   · **La cuota, no.** Estos son planes con API key: no dejan ningún
//     porcentaje en el disco, y el único lugar donde vive es el endpoint de
//     cada proveedor, que hay que llamar con la clave. Así que la fila trae
//     consumo y una frase que dice por qué no hay barra — nunca un 0 % que
//     parezca un dato.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = join(
  process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'),
  'opencode',
  'opencode.db',
);

/**
 * Cuándo se usó por última vez cada proveedor, sin ventana.
 *
 * El descubrimiento y el consumo son dos preguntas distintas: si sólo se
 * listara lo que gastó en los últimos 7 días, una cuenta que usaste hace diez
 * desaparecería de la lista —y «no aparece» es justo lo que este repo existe
 * para que no pase—. Aparece igual, con 0 en la ventana y la fecha real.
 */
export function ultimoUsoOpencode(): Map<string, Date> {
  const salida = new Map<string, Date>();
  if (!hayOpencode()) return salida;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(BASE, { readOnly: true });
  } catch {
    return salida;
  }
  try {
    const filas = db
      .prepare(
        `select json_extract(model,'$.providerID') as proveedor, max(time_updated) as visto
           from session where model is not null group by proveedor`,
      )
      .all() as { proveedor: string | null; visto: number }[];
    for (const f of filas) {
      if (f.proveedor !== null && f.visto) salida.set(f.proveedor, new Date(Number(f.visto)));
    }
  } catch {
    /* una base que cambió de forma no puede tumbar el resto */
  } finally {
    db.close();
  }
  return salida;
}

/** Lo último que se supo de un límite alcanzado, por proveedor. */
export interface LimiteOpencode {
  readonly proveedor: string;
  /** Cuándo opencode se comió el error. */
  readonly cuando: Date;
  /** Cuándo dice el proveedor que se libera. null si el mensaje no lo trae. */
  readonly reinicia: Date | null;
  readonly mensaje: string;
}

/**
 * Los límites que estos proveedores SÍ dejan en el disco.
 *
 * No hay porcentaje por ningún lado —se probó: ni `/models` ni una llamada real
 * devuelven cabeceras `x-ratelimit-*` en zai ni en minimax—. Pero cuando te
 * frenan, contestan un 429 con el texto y la fecha de reinicio, y **opencode
 * guarda esa respuesta**. O sea que los dos datos que de verdad importan —¿me
 * frenaron? ¿cuándo me libero?— están en la máquina, gratis y sin credencial.
 *
 * Es más pobre que una barra y es exactamente lo que hay: mejor eso que un
 * porcentaje inventado.
 */
export function limitesOpencode(): Map<string, LimiteOpencode> {
  const salida = new Map<string, LimiteOpencode>();
  if (!hayOpencode()) return salida;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(BASE, { readOnly: true });
  } catch {
    return salida;
  }
  // Acotado por fecha, y eso no es una optimización de adorno: sin el `where`
  // sobre time_updated hay que hacer json_extract del blob de CADA mensaje
  // —10 173 en esta máquina— y la consulta tarda 135 ms en frío. Con el corte
  // son 3 ms. Medido, no supuesto. Y no se pierde nada que se use: lo único
  // que produce una barra es un límite cuyo reinicio todavía no pasó, y ningún
  // proveedor reinicia en más de un mes.
  const corte = Date.now() - 30 * 24 * 3600_000;
  try {
    const filas = db
      .prepare(
        `select json_extract(s.model,'$.providerID') as proveedor,
                m.time_updated as cuando,
                coalesce(json_extract(m.data,'$.error.data.message'),
                         json_extract(m.data,'$.error.name')) as mensaje
           from message m join session s on s.id = m.session_id
          where m.time_updated >= ?
            and json_extract(m.data,'$.error') is not null
          order by m.time_updated desc
          limit 400`,
      )
      .all(corte) as { proveedor: string | null; cuando: number; mensaje: string | null }[];

    for (const f of filas) {
      if (f.proveedor === null || f.mensaje === null) continue;
      if (!/limit/i.test(f.mensaje)) continue;
      // Sólo el más nuevo de cada proveedor: la consulta ya viene ordenada.
      if (salida.has(f.proveedor)) continue;
      salida.set(f.proveedor, {
        proveedor: f.proveedor,
        cuando: new Date(Number(f.cuando)),
        reinicia: fechaDeReinicio(f.mensaje),
        mensaje: f.mensaje,
      });
    }
  } catch {
    /* nada */
  } finally {
    db.close();
  }
  return salida;
}

/**
 * «… will reset at 2026-09-11 18:35:24» -> Date.
 *
 * Los proveedores mandan la fecha adentro de una oración en inglés, sin zona
 * horaria. Se interpreta como hora local, que es lo que se ve en la práctica:
 * el reinicio que informó zai coincidía con el reloj de la máquina.
 */
export function fechaDeReinicio(mensaje: string): Date | null {
  const m = /reset at\s+(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)/i.exec(mensaje);
  if (m === null) return null;
  const d = new Date(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface CuentaOpencode {
  /** `zai-coding-plan`, `minimax-coding-plan`, … tal cual lo nombra opencode. */
  readonly proveedor: string;
  /** El modelo más usado en la ventana, para mostrar algo reconocible. */
  readonly modelo: string | null;
  readonly tokens: number;
  readonly sesiones: number;
  readonly costo: number;
}

export function hayOpencode(): boolean {
  return existsSync(BASE);
}

/** Cuándo se tocó la base por última vez. Sirve para mostrar la edad. */
export function medidoEnOpencode(): Date | null {
  try {
    return new Date(statSync(BASE).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Consumo por proveedor en la ventana pedida.
 *
 * Se abre en sólo-lectura: opencode puede estar corriendo, y esto no tiene por
 * qué molestarlo ni bloquearlo.
 */
export function consumoOpencode(desde: Date): CuentaOpencode[] {
  if (!hayOpencode()) return [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(BASE, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const filas = db
      .prepare(
        `select model,
                sum(coalesce(tokens_input,0) + coalesce(tokens_output,0)
                    + coalesce(tokens_cache_write,0)) as tokens,
                count(*) as sesiones,
                sum(coalesce(cost,0)) as costo
           from session
          where time_updated > ?
          group by model`,
      )
      .all(desde.getTime()) as { model: string; tokens: number; sesiones: number; costo: number }[];

    // `model` es un JSON con providerID adentro. Se agrupa por proveedor, que
    // es la unidad que le importa a alguien que paga un plan.
    const porProveedor = new Map<string, CuentaOpencode>();
    for (const f of filas) {
      let proveedor = 'desconocido';
      let modelo: string | null = null;
      try {
        const m = JSON.parse(f.model) as Record<string, unknown>;
        proveedor = (m['providerID'] as string) ?? proveedor;
        modelo = (m['id'] as string) ?? null;
      } catch {
        // Un `model` que no es JSON no debería tirar abajo el resto.
      }
      const previo = porProveedor.get(proveedor);
      porProveedor.set(proveedor, {
        proveedor,
        // Se queda el modelo del grupo con más tokens.
        modelo: previo === undefined || f.tokens > previo.tokens ? modelo : previo.modelo,
        tokens: (previo?.tokens ?? 0) + Number(f.tokens ?? 0),
        sesiones: (previo?.sesiones ?? 0) + Number(f.sesiones ?? 0),
        costo: (previo?.costo ?? 0) + Number(f.costo ?? 0),
      });
    }
    return [...porProveedor.values()].sort((a, b) => b.tokens - a.tokens);
  } catch {
    return [];
  } finally {
    db.close();
  }
}
