// Qué capa de la red falló, en una frase.
//
// POR QUÉ EXISTE. En noviembre de 2026, en una Mac, cada refresco de la cuota
// falló durante tres días con una sola línea: «couldn't get the quota: fetch
// failed». La causa era un firewall de aplicaciones —una extensión de filtro
// de red de macOS— que descartaba las conexiones de node a api.anthropic.com.
// `fetch failed` es el mensaje de undici para CUALQUIER falla antes de la
// respuesta: no dice si fue el DNS, la conexión o el TLS, y eso es justo lo
// que hace falta para saber a quién mirar.
//
// Lo que sí lo dice viaja colgado del error: undici pone la causa en
// `error.cause`, con el `code` del sistema, y cuando prueba varias direcciones
// (IPv6 e IPv4) la causa es un AggregateError con un error por dirección. Lo
// que dejó ese filtro, medido en esa Mac con node 26:
//
//   TypeError: fetch failed
//     cause: ConnectTimeoutError  code UND_ERR_CONNECT_TIMEOUT
//       cause: AggregateError     code ETIMEDOUT
//         errors: connect ETIMEDOUT 2607:6bc0::10:443
//                 connect EBADF 160.79.104.10:443
//
// El código de arriba dice «timeout» y es el menos informativo de los cuatro:
// el que delata al filtro es el EBADF, que un connect() no devuelve nunca por
// la red —sólo cuando algo en la máquina le saca el socket de abajo—. Por eso
// se junta TODA la cadena y gana el código más específico, no el primero.
//
// Es pura a propósito: recibe el error y el host, y no sabe de qué adaptador
// vino. La usan los cuatro lugares que salen a la red y el diagnóstico.

import { tr } from './idioma.ts';

/** La capa que falló, de la más específica a la más vaga. */
export type FallaRed =
  | 'filtrada'
  | 'certificado'
  | 'tls'
  | 'dns'
  | 'rechazada'
  | 'cortada'
  | 'tiempo'
  | 'sin-ruta';

export interface CausaRed {
  readonly tipo: FallaRed;
  /** El código que la decidió: `EBADF`, `ENOTFOUND`, … Va en la frase para quien reporta. */
  readonly codigo: string;
}

const CODIGOS: ReadonlyArray<readonly [FallaRed, ReadonlySet<string>]> = [
  // Un connect() que vuelve con EBADF, EPERM o EACCES no lo rechazó nadie del
  // otro lado: se lo negó algo en esta máquina. EBADF es lo que deja un filtro
  // de red de macOS (medido); EPERM, una regla que descarta en la cadena
  // OUTPUT de netfilter, en Linux.
  ['filtrada', new Set(['EBADF', 'EPERM', 'EACCES'])],
  ['certificado', new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_UNTRUSTED',
    'CERT_SIGNATURE_FAILURE',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])],
  ['tls', new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_HANDSHAKE_TIMEOUT'])],
  // ETIMEOUT (sin D) es el «el servidor DNS no contestó» del módulo dns; el
  // diagnóstico lo usa para su propio límite de tiempo en ese paso.
  ['dns', new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT'])],
  ['rechazada', new Set(['ECONNREFUSED'])],
  ['cortada', new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'])],
  ['tiempo', new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])],
  // Al final a propósito: con IPv6 sin ruta e IPv4 que no contesta, lo que
  // describe el problema es el timeout, no la dirección que nunca iba a andar.
  ['sin-ruta', new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL'])],
];

/** Todos los errores de la cadena: el error, su `cause`, la de ésa, y los `errors` de un AggregateError. */
function cadena(e: unknown, vistos = new Set<unknown>()): unknown[] {
  if (e === null || typeof e !== 'object' || vistos.has(e)) return [];
  vistos.add(e);
  const salida: unknown[] = [e];
  const o = e as { cause?: unknown; errors?: unknown };
  if (Array.isArray(o.errors)) for (const x of o.errors) salida.push(...cadena(x, vistos));
  salida.push(...cadena(o.cause, vistos));
  return salida;
}

function codigoDe(e: unknown): string | null {
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' && c !== '' ? c : null;
}

/**
 * La capa que falló, o null si el error no es de red (o es uno que no
 * conocemos). Recorre la cadena entera y gana la capa más específica.
 */
export function clasificarFallaRed(e: unknown): CausaRed | null {
  const errores = cadena(e);
  const codigos = errores.map(codigoDe).filter((c): c is string => c !== null);
  for (const [tipo, conjunto] of CODIGOS) {
    const codigo = codigos.find((c) => conjunto.has(c));
    if (codigo !== undefined) return { tipo, codigo };
  }
  // Un handshake roto que node no etiqueta con uno de los de arriba: OpenSSL
  // los nombra ERR_SSL_*.
  const ssl = codigos.find((c) => c.startsWith('ERR_SSL_'));
  if (ssl !== undefined) return { tipo: 'tls', codigo: ssl };
  // `AbortSignal.timeout()` no deja código: deja un DOMException con nombre.
  if (errores.some((x) => (x as { name?: unknown }).name === 'TimeoutError')) {
    return { tipo: 'tiempo', codigo: 'TimeoutError' };
  }
  return null;
}

/** La causa en palabras: qué capa falló, el código, y a quién mirar. */
export function fraseFallaRed(c: CausaRed, host: string): string {
  const k = c.codigo;
  switch (c.tipo) {
    case 'filtrada':
      return tr(
        `algo en esta máquina descartó la conexión a ${host} (${k}): ¿un firewall de aplicaciones?`,
        `something on this machine dropped the connection to ${host} (${k}): an application firewall?`,
      );
    case 'certificado':
      return tr(
        `el certificado de ${host} no verifica (${k}): algo intercepta el TLS, ¿un proxy o un antivirus?`,
        `${host}'s certificate doesn't verify (${k}): something is intercepting TLS, a proxy or an antivirus?`,
      );
    case 'tls':
      return tr(
        `falló el TLS con ${host} (${k}): algo lo intercepta, ¿un proxy o un antivirus?`,
        `the TLS handshake with ${host} failed (${k}): something is intercepting it, a proxy or an antivirus?`,
      );
    case 'dns':
      return tr(`sin respuesta del DNS para ${host} (${k})`, `no DNS answer for ${host} (${k})`);
    case 'rechazada':
      return tr(
        `la conexión a ${host} fue rechazada (${k}): ¿un firewall o un proxy?`,
        `the connection to ${host} was refused (${k}): a firewall or a proxy?`,
      );
    case 'cortada':
      return tr(
        `la conexión a ${host} se cortó (${k}): ¿un firewall o un proxy?`,
        `the connection to ${host} was cut (${k}): a firewall or a proxy?`,
      );
    case 'tiempo':
      return tr(
        `${host} no contestó a tiempo (${k}): ¿sin red, o un firewall que la descarta?`,
        `${host} didn't answer in time (${k}): no network, or a firewall dropping it?`,
      );
    case 'sin-ruta':
      return tr(`no hay ruta hasta ${host} (${k}): ¿se cayó la red?`, `no route to ${host} (${k}): is the network down?`);
  }
}

/**
 * Lo que se dice cuando un pedido no llegó a tener respuesta.
 *
 * Si la capa se reconoce, la frase de arriba. Si no, el mensaje de siempre más
 * lo que diga la causa más honda: «fetch failed» solo es el silencio que esto
 * vino a sacar, y la causa casi siempre dice algo.
 */
export function detalleDeRed(e: unknown, host: string): string {
  const c = clasificarFallaRed(e);
  if (c !== null) return fraseFallaRed(c, host);
  const mensaje = e instanceof Error && e.message !== '' ? e.message : tr('error de red', 'network error');
  const errores = cadena(e);
  const honda = errores.length > 1 ? errores[errores.length - 1] : null;
  if (honda === null) return mensaje;
  const extra = codigoDe(honda) ?? (honda instanceof Error ? honda.message : null);
  return extra !== null && extra !== '' && extra !== mensaje ? `${mensaje} (${extra})` : mensaje;
}
