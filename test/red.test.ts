// Qué capa de la red falló, en vez de «fetch failed».
//
// En una Mac, cada refresco de la cuota falló tres días con «couldn't get the
// quota: fetch failed». La causa era un firewall de aplicaciones que descartaba
// las conexiones de node, y estaba escrita en el error —en `cause`, dos niveles
// más abajo— sin que nadie la leyera. Estos tests fijan que se lea.
//
// Nada sale a la red: los errores de undici se arman con la forma medida, y los
// de verdad se provocan contra puertos de 127.0.0.1.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { test } from 'node:test';
import { clasificarFallaRed, detalleDeRed, fraseFallaRed } from '../src/core/red.ts';
import { firewallsEn, probarRed } from '../src/adapters/red.ts';
import { detalleErrorCodex } from '../src/adapters/codex.ts';

// Estos tests leen las frases en castellano. El idioma sale del locale, y el
// de CI es C.UTF-8 (inglés): se fija acá. Lo que es del inglés vive en idioma.test.ts.
process.env['QM_IDIOMA'] = 'es';

const conCodigo = (mensaje: string, code: string, extra: object = {}) => Object.assign(new Error(mensaje), { code, ...extra });

/** El error que dejó el firewall en la Mac, armado igual que undici con node 26. */
function delFirewall(): Error {
  const porDireccion = Object.assign(new AggregateError([
    conCodigo('connect ETIMEDOUT 2607:6bc0::10:443', 'ETIMEDOUT', { errno: -60, syscall: 'connect' }),
    conCodigo('connect EBADF 160.79.104.10:443', 'EBADF', { errno: -9, syscall: 'connect' }),
  ], ''), { code: 'ETIMEDOUT' });
  const timeout = Object.assign(new Error('Connect Timeout Error (attempted addresses: 2607:6bc0::10:443, 160.79.104.10:443, timeout: 10000ms)'), {
    code: 'UND_ERR_CONNECT_TIMEOUT',
    cause: porDireccion,
  });
  return new TypeError('fetch failed', { cause: timeout });
}

const fetchFallido = (causa: unknown) => new TypeError('fetch failed', { cause: causa });

// ── la clasificación ─────────────────────────────────────────────────────

test('el error de la Mac es un firewall, no un timeout: gana el EBADF de adentro', () => {
  assert.deepEqual(clasificarFallaRed(delFirewall()), { tipo: 'filtrada', codigo: 'EBADF' });
  assert.equal(
    detalleDeRed(delFirewall(), 'api.anthropic.com'),
    'algo en esta máquina descartó la conexión a api.anthropic.com (EBADF): ¿un firewall de aplicaciones?',
  );
});

test('cada capa con su código', () => {
  const casos: Array<[string, string]> = [
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'rechazada'],
    ['ECONNRESET', 'cortada'],
    ['UND_ERR_SOCKET', 'cortada'],
    ['ETIMEDOUT', 'tiempo'],
    ['UND_ERR_CONNECT_TIMEOUT', 'tiempo'],
    ['ENETUNREACH', 'sin-ruta'],
    ['EHOSTUNREACH', 'sin-ruta'],
    ['EPERM', 'filtrada'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificado'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificado'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificado'],
    ['EPROTO', 'tls'],
    ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'tls'],
  ];
  for (const [codigo, tipo] of casos) {
    assert.deepEqual(clasificarFallaRed(fetchFallido(conCodigo(codigo, codigo))), { tipo, codigo }, codigo);
  }
});

test('IPv6 sin ruta e IPv4 que no contesta es un timeout: la IPv6 nunca iba a andar', () => {
  const e = fetchFallido(new AggregateError([
    conCodigo('connect ENETUNREACH', 'ENETUNREACH'),
    conCodigo('connect ETIMEDOUT', 'ETIMEDOUT'),
  ]));
  assert.deepEqual(clasificarFallaRed(e), { tipo: 'tiempo', codigo: 'ETIMEDOUT' });
});

test('el límite de AbortSignal.timeout() no deja código, pero es un timeout', () => {
  const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.deepEqual(clasificarFallaRed(e), { tipo: 'tiempo', codigo: 'TimeoutError' });
});

test('lo que no se reconoce no se inventa: el mensaje de siempre, con lo que diga la causa', () => {
  assert.equal(clasificarFallaRed(fetchFallido(conCodigo('algo raro', 'EALGO'))), null);
  assert.equal(detalleDeRed(fetchFallido(conCodigo('algo raro', 'EALGO')), 'api.anthropic.com'), 'fetch failed (EALGO)');
  assert.equal(detalleDeRed(new Error('se rompió'), 'api.anthropic.com'), 'se rompió');
  assert.equal(detalleDeRed('no es un Error', 'api.anthropic.com'), 'error de red');
});

test('una cadena circular no cuelga la clasificación', () => {
  const a = conCodigo('a', 'EALGO') as Error & { cause?: unknown };
  a.cause = a;
  assert.equal(clasificarFallaRed(a), null);
});

test('en inglés, las mismas capas', () => {
  const antes = process.env['QM_IDIOMA'];
  process.env['QM_IDIOMA'] = 'en';
  try {
    assert.equal(fraseFallaRed({ tipo: 'dns', codigo: 'ENOTFOUND' }, 'api.anthropic.com'), 'no DNS answer for api.anthropic.com (ENOTFOUND)');
    assert.equal(
      fraseFallaRed({ tipo: 'rechazada', codigo: 'ECONNREFUSED' }, 'api.anthropic.com'),
      'the connection to api.anthropic.com was refused (ECONNREFUSED): a firewall or a proxy?',
    );
    assert.equal(
      detalleDeRed(delFirewall(), 'api.anthropic.com'),
      'something on this machine dropped the connection to api.anthropic.com (EBADF): an application firewall?',
    );
  } finally {
    process.env['QM_IDIOMA'] = antes;
  }
});

// ── contra undici de verdad, en 127.0.0.1 ────────────────────────────────

/** Un puerto que nadie escucha: se abre uno, se anota y se cierra. */
async function puertoCerrado(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function servidor(alConectar: (s: import('node:net').Socket) => void): Promise<{ server: Server; puerto: number }> {
  const server = createServer(alConectar);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, puerto: (server.address() as { port: number }).port };
}

test('un fetch rechazado de verdad dice «rechazada», no «fetch failed»', async () => {
  const puerto = await puertoCerrado();
  const e = await fetch(`http://127.0.0.1:${puerto}/`).then(() => null, (x: unknown) => x);
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'fetch failed', 'si undici cambia el mensaje de arriba, el resto del test sigue valiendo');
  assert.deepEqual(clasificarFallaRed(e), { tipo: 'rechazada', codigo: 'ECONNREFUSED' });
});

// ── la sonda del diagnóstico ─────────────────────────────────────────────

test('sonda: un puerto cerrado falla en TCP, y el TLS ni se prueba', async () => {
  const puerto = await puertoCerrado();
  const s = await probarRed('localhost', puerto);
  assert.equal(s.pasos[0]!.paso, 'dns');
  assert.equal(s.pasos[0]!.ok, true);
  const tcp = s.pasos[1]!;
  assert.equal(tcp.paso, 'tcp');
  assert.equal(tcp.ok, false);
  assert.equal(clasificarFallaRed(tcp.error)?.tipo, 'rechazada');
  assert.equal(s.pasos.length, 2);
});

test('sonda: un servidor que corta al conectar falla en el TLS', async () => {
  const { server, puerto } = await servidor((c) => c.destroy());
  try {
    const s = await probarRed('localhost', puerto);
    assert.deepEqual(s.pasos.map((p) => [p.paso, p.ok]), [['dns', true], ['tcp', true], ['tls', false]]);
    assert.equal(clasificarFallaRed(s.pasos[2]!.error)?.tipo, 'cortada');
  } finally {
    server.close();
  }
});

test('sonda: el total acota la sección aunque cada paso tenga más', async () => {
  const abiertas: import('node:net').Socket[] = [];
  const { server, puerto } = await servidor((c) => abiertas.push(c));
  try {
    const antes = performance.now();
    const s = await probarRed('localhost', puerto, { dns: 1000, tcp: 1000, tls: 5000, total: 400 });
    assert.ok(performance.now() - antes < 1500, 'el total no acotó el TLS');
    assert.equal(s.pasos[2]!.ok, false);
  } finally {
    for (const c of abiertas) c.destroy();
    server.close();
  }
});

test('sonda: un servidor mudo no la cuelga: vence el límite del TLS', async () => {
  const abiertas: import('node:net').Socket[] = [];
  const { server, puerto } = await servidor((c) => abiertas.push(c));
  try {
    const antes = performance.now();
    const s = await probarRed('localhost', puerto, { dns: 1000, tcp: 1000, tls: 300, total: 5000 });
    assert.ok(performance.now() - antes < 2000, 'tardó más que los límites');
    const tls = s.pasos[2]!;
    assert.equal(tls.ok, false);
    assert.deepEqual(clasificarFallaRed(tls.error), { tipo: 'tiempo', codigo: 'ETIMEDOUT' });
  } finally {
    for (const c of abiertas) c.destroy();
    server.close();
  }
});

// ── los firewalls de aplicaciones ────────────────────────────────────────

test('Blackice se reconoce por la app y por su extensión, tal cual las lista ps en la Mac', () => {
  // Tres líneas reales de `ps -Ao comm=` en la Mac donde pasó, y una que se
  // parece y no es: «Radio» no es Radio Silence.
  const procesos = [
    '/usr/sbin/WirelessRadioManagerd',
    '/Library/SystemExtensions/81E1FF85-50E2-42AD-BF52-1326AED66E24/com.valentorassa.blackice.filter.systemextension/Contents/MacOS/com.valentorassa.blackice.filter',
    '/Applications/Blackice.app/Contents/MacOS/blackice',
  ];
  assert.deepEqual(firewallsEn(procesos, 'darwin', 'api.anthropic.com').map((f) => f.nombre), ['Blackice']);
  const [b] = firewallsEn(procesos, 'darwin', 'api.anthropic.com');
  assert.match(b!.arreglo, /api\.anthropic\.com/);
  assert.match(b!.arreglo, /blackice pending/);
});

test('los otros de macOS, y OpenSnitch en Linux', () => {
  const mac = [
    '/Library/Little Snitch/Little Snitch Daemon.bundle/Contents/MacOS/Little Snitch Daemon',
    '/Applications/LuLu.app/Contents/MacOS/LuLu',
    '/Applications/Radio Silence.app/Contents/MacOS/Radio Silence',
  ];
  assert.deepEqual(firewallsEn(mac, 'darwin', 'api.anthropic.com').map((f) => f.nombre), ['Little Snitch', 'LuLu', 'Radio Silence']);
  assert.deepEqual(firewallsEn(['systemd', 'opensnitchd', 'bash'], 'linux', 'api.anthropic.com').map((f) => f.nombre), ['OpenSnitch']);
  // Cada uno sólo en su plataforma.
  assert.deepEqual(firewallsEn(mac, 'linux', 'api.anthropic.com'), []);
  assert.deepEqual(firewallsEn(['opensnitchd'], 'darwin', 'api.anthropic.com'), []);
});

// ── Codex ────────────────────────────────────────────────────────────────

test('Codex sin red: dice a qué host no llegó, no «la respuesta no traía rateLimits»', () => {
  // Lo que contesta codex 0.169 con un proxy que rechaza y con uno que no
  // resuelve: el mismo mensaje en los dos casos.
  const error = {
    code: -32603,
    message: 'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)',
  };
  assert.equal(detalleErrorCodex(error), 'codex no llegó a chatgpt.com, y no dice por qué: ¿DNS, un firewall, o sin red?');
  assert.equal(detalleErrorCodex({ code: 1, message: 'otra cosa' }), 'el app-server de codex contestó un error: otra cosa');
  assert.equal(detalleErrorCodex(null), 'el app-server de codex contestó un error sin mensaje');
});
