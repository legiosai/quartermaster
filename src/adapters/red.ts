// La red, vista desde ESTE proceso: lo que mira `qm --diagnostico` cuando un
// refresco no llega.
//
// POR QUÉ EXISTE. En una Mac, cada refresco falló tres días seguidos con
// «fetch failed», y la causa era un firewall de aplicaciones que descartaba
// las conexiones de node a api.anthropic.com. Lo primero que uno prueba
// —`curl https://api.anthropic.com/`— no sirve para esto: un firewall de
// aplicaciones decide POR PROGRAMA, y curl no es node. Medido en esa misma Mac
// después de aprobar a qm: curl seguía cortado y node pasaba. La única prueba
// que contesta la pregunta es la que hace el mismo proceso que refresca, y eso
// es lo que hay acá.
//
// Tres pasos, cada uno con su límite, y se para en el primero que falla: el
// DNS, la conexión TCP al 443, y el apretón de manos TLS. No se manda ningún
// pedido HTTP, ni credencial, ni nada de la cuenta: el TLS termina en el
// saludo. Es el mismo host al que ya le habla `--refrescar`.

import { execFileSync } from 'node:child_process';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { connect as conectarTcp, type Socket } from 'node:net';
import { connect as conectarTls } from 'node:tls';
import { tr } from '../core/idioma.ts';

export type Paso = 'dns' | 'tcp' | 'tls';

export interface ResultadoPaso {
  readonly paso: Paso;
  readonly ok: boolean;
  readonly ms: number;
  /** Si anduvo, lo que se averiguó (las direcciones, para el DNS). */
  readonly detalle?: string;
  /** Si falló, el error tal cual, para que lo clasifique `detalleDeRed()`. */
  readonly error?: unknown;
}

export interface SondaRed {
  readonly host: string;
  readonly puerto: number;
  /** En orden, hasta el primero que falló. */
  readonly pasos: readonly ResultadoPaso[];
}

export interface Tiempos {
  readonly dns: number;
  readonly tcp: number;
  readonly tls: number;
  /** El de la sección entera: ningún paso pasa de lo que queda de esto. */
  readonly total: number;
}

/**
 * Los límites, en ms. La conexión tiene el más largo a propósito: el filtro de
 * la Mac retenía cada conexión unos 3,7 s y recién ahí la descartaba con EBADF
 * (medido tres veces, entre 3,6 y 3,75 s). Con 2 s la sonda veía un timeout
 * donde estaba la prueba del firewall. El total acota la sección: un
 * diagnóstico que se cuelga no diagnostica.
 */
export const TIEMPOS: Tiempos = { dns: 1000, tcp: 4500, tls: 1500, total: 5000 };

/** Un error con `code`, como los que deja node: así lo clasifica la misma función que los de undici. */
function errorCon(code: string, mensaje: string): Error {
  return Object.assign(new Error(mensaje), { code });
}

function conLimite<T>(p: Promise<T>, ms: number, alVencer: () => Error): Promise<T> {
  return new Promise<T>((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(alVencer()), ms);
    p.then(
      (v) => {
        clearTimeout(reloj);
        resolver(v);
      },
      (e: unknown) => {
        clearTimeout(reloj);
        rechazar(e);
      },
    );
  });
}

/**
 * Un socket que todavía espera NO se destruye: se suelta.
 *
 * Medido en la Mac del firewall: `destroy()` sobre una conexión que el filtro
 * está reteniendo se queda un segundo entero adentro del close(), con el
 * bucle de eventos parado. Con dos direcciones eran dos segundos más sobre el
 * límite. Soltado (`unref`), no frena la salida, y cuando el filtro por fin
 * contesta se cierra solo o lo cierra su propio 'connect'.
 */
function soltar(s: Socket): void {
  s.unref();
}

/**
 * La primera dirección que conecta, probándolas todas a la vez.
 *
 * A la vez y no en fila, como hace el `autoSelectFamily` de node: undici en
 * fila le dio su límite entero a la IPv6 retenida y reportó el timeout de
 * ésa, con el EBADF de la IPv4 escondido dos niveles más abajo.
 */
function conectar(direcciones: readonly LookupAddress[], puerto: number, ms: number): Promise<Socket> {
  return new Promise<Socket>((resolver, rechazar) => {
    const errores: unknown[] = direcciones.map(() => undefined);
    const sockets: Socket[] = [];
    let pendientes = direcciones.length;
    let listo = false;
    const reloj = setTimeout(() => {
      if (listo) return;
      listo = true;
      direcciones.forEach((d, i) => {
        if (errores[i] === undefined) errores[i] = errorCon('ETIMEDOUT', `connect ETIMEDOUT ${d.address}:${puerto}`);
      });
      for (const s of sockets) soltar(s);
      rechazar(new AggregateError(errores, 'connect failed'));
    }, ms);
    direcciones.forEach((d, i) => {
      const s = conectarTcp({ host: d.address, port: puerto, family: d.family });
      sockets.push(s);
      s.once('connect', () => {
        // Una que llega tarde ya está conectada: cerrarla no traba nada.
        if (listo) {
          s.destroy();
          return;
        }
        listo = true;
        clearTimeout(reloj);
        for (const otro of sockets) if (otro !== s) soltar(otro);
        resolver(s);
      });
      s.on('error', (e) => {
        if (listo) return;
        errores[i] = e;
        pendientes -= 1;
        if (pendientes === 0) {
          listo = true;
          clearTimeout(reloj);
          rechazar(new AggregateError(errores, 'connect failed'));
        }
      });
    });
  });
}

/** El saludo TLS sobre un socket ya conectado, verificando el certificado como lo hace fetch. */
function saludoTls(socket: Socket, host: string, ms: number): Promise<void> {
  return new Promise<void>((resolver, rechazar) => {
    const t = conectarTls({ socket, servername: host });
    let listo = false;
    const reloj = setTimeout(() => {
      listo = true;
      soltar(socket);
      rechazar(errorCon('ETIMEDOUT', `TLS ETIMEDOUT ${host}`));
    }, ms);
    t.once('secureConnect', () => {
      clearTimeout(reloj);
      t.destroy();
      if (!listo) resolver();
    });
    t.on('error', (e) => {
      clearTimeout(reloj);
      t.destroy();
      if (!listo) rechazar(e);
    });
  });
}

/** DNS, TCP y TLS contra `host`, desde este proceso. Nunca tira: cada falla queda en su paso. */
export async function probarRed(host: string, puerto = 443, tiempos: Tiempos = TIEMPOS): Promise<SondaRed> {
  const pasos: ResultadoPaso[] = [];
  const reloj = () => performance.now();
  const inicio = reloj();
  const limite = (paso: Paso) => Math.max(0, Math.min(tiempos[paso], tiempos.total - (reloj() - inicio)));

  let t = reloj();
  let direcciones: LookupAddress[];
  try {
    // lookup y no resolve: es el mismo resolvedor que usa fetch (getaddrinfo),
    // con el /etc/hosts y el DNS del sistema adentro.
    direcciones = await conLimite(lookup(host, { all: true }), limite('dns'), () =>
      errorCon('ETIMEOUT', `getaddrinfo ETIMEOUT ${host}`));
    if (direcciones.length === 0) throw errorCon('ENOTFOUND', `getaddrinfo ENOTFOUND ${host}`);
  } catch (e) {
    pasos.push({ paso: 'dns', ok: false, ms: reloj() - t, error: e });
    return { host, puerto, pasos };
  }
  pasos.push({ paso: 'dns', ok: true, ms: reloj() - t, detalle: direcciones.map((d) => d.address).join(', ') });

  t = reloj();
  let socket: Socket;
  try {
    socket = await conectar(direcciones.slice(0, 4), puerto, limite('tcp'));
  } catch (e) {
    pasos.push({ paso: 'tcp', ok: false, ms: reloj() - t, error: e });
    return { host, puerto, pasos };
  }
  pasos.push({ paso: 'tcp', ok: true, ms: reloj() - t, detalle: socket.remoteAddress ?? '' });

  t = reloj();
  try {
    await saludoTls(socket, host, limite('tls'));
    pasos.push({ paso: 'tls', ok: true, ms: reloj() - t });
  } catch (e) {
    pasos.push({ paso: 'tls', ok: false, ms: reloj() - t, error: e });
  }
  return { host, puerto, pasos };
}

// ── los firewalls de aplicaciones ────────────────────────────────────────

export interface Firewall {
  readonly nombre: string;
  /** Qué tocar en ESE firewall para que qm pase. */
  readonly arreglo: string;
}

interface Conocido {
  readonly nombre: string;
  readonly plataforma: NodeJS.Platform;
  /** Contra cada línea de `ps -Ao comm=`: la ruta del ejecutable en macOS, el nombre en Linux. */
  readonly patron: RegExp;
  readonly arreglo: (host: string) => string;
}

const permitir = (nombre: string) => (host: string) => tr(
  `dejá pasar a node (el que corre qm) hacia ${host} en las reglas de ${nombre}`,
  `allow node (running qm) to reach ${host} in ${nombre}'s rules`,
);

/**
 * Los que filtran POR PROGRAMA, que son los que dejan a curl pasar y a qm no
 * (o al revés). Un firewall de red común corta a todos por igual y eso ya lo
 * dice la sonda sola.
 */
const CONOCIDOS: readonly Conocido[] = [
  {
    nombre: 'Blackice',
    plataforma: 'darwin',
    // La app y su extensión de filtro, tal cual las lista `ps` (medido).
    patron: /\/Blackice\.app\/|blackice\.filter/i,
    // Blackice aprueba por binario Y por script: aprobar node a secas no
    // alcanza si se aprobó con otro script. `blackice pending` lista la
    // conexión descartada con el comando exacto.
    arreglo: (host) => tr(
      `dejá pasar a node (el que corre qm) hacia ${host} en Blackice: \`blackice pending\` lo lista con el comando que lo aprueba`,
      `allow node (running qm) to reach ${host} in Blackice: \`blackice pending\` lists it with the command that approves it`,
    ),
  },
  { nombre: 'Little Snitch', plataforma: 'darwin', patron: /Little Snitch|at\.obdev\.littlesnitch/i, arreglo: permitir('Little Snitch') },
  { nombre: 'LuLu', plataforma: 'darwin', patron: /\/LuLu\.app\/|com\.objective-see\.lulu/i, arreglo: permitir('LuLu') },
  {
    nombre: 'Radio Silence',
    plataforma: 'darwin',
    patron: /Radio Silence|radiosilence/i,
    // Radio Silence no tiene reglas de «permitir»: bloquea lo que está en su lista.
    arreglo: () => tr('sacá a node de la lista de bloqueados de Radio Silence', 'take node off Radio Silence\'s blocked list'),
  },
  { nombre: 'OpenSnitch', plataforma: 'linux', patron: /(^|\/)opensnitchd$/, arreglo: permitir('OpenSnitch') },
];

/** Los firewalls conocidos que aparecen en una lista de procesos. Pura: la lista la da quien llama. */
export function firewallsEn(procesos: readonly string[], plataforma: NodeJS.Platform, host: string): Firewall[] {
  return CONOCIDOS
    .filter((c) => c.plataforma === plataforma && procesos.some((p) => c.patron.test(p.trim())))
    .map((c) => ({ nombre: c.nombre, arreglo: c.arreglo(host) }));
}

/**
 * Los que están corriendo. null si no se pudo preguntar.
 *
 * En Windows no se mira: los que filtran por programa allá (simplewall,
 * GlassWire…) no se probaron, y nombrar uno sin haberlo visto sería adivinar.
 */
export function firewallsCorriendo(host: string, plataforma: NodeJS.Platform = process.platform): Firewall[] | null {
  if (plataforma !== 'darwin' && plataforma !== 'linux') return null;
  try {
    const salida = execFileSync('ps', ['-Ao', 'comm='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return firewallsEn(salida.split('\n'), plataforma, host);
  } catch {
    return null;
  }
}
