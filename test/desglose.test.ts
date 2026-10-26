// `qm --desglose`: en qué se fue la cuota.
//
// Todo lo de acá es sintético: rutas inventadas, sesiones con nombres de
// juguete y tokens elegidos para que la cuenta se pueda hacer a mano. Ninguna
// transcripción real entra en un test — tienen el contenido de las
// conversaciones adentro, y el directorio de trabajo dice para quién se trabaja.
//
// Lo que se fija es lo que el informe afirma y no se ve mirando la pantalla:
// los pesos, los bordes de los tramos, qué cuenta como reconstrucción de cache,
// la deduplicación (que acá es por mensaje Y por request), a quién se le cobra
// una copia de un fork, y que --redactado no deje escapar un directorio.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLASES,
  contexto,
  costo,
  desglosar,
  tipoHueco,
  tramoDe,
  type Compactacion,
  type Uso,
} from '../src/core/desglose.ts';
import { lineasCon } from '../src/adapters/lineas.ts';
import { hiloDe, usosDesde } from '../src/adapters/transcripciones.ts';
import { usosDeRollout } from '../src/adapters/codex.ts';
import type { Perfil } from '../src/core/tipos.ts';

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
// Mediodía local de un día fijo: así el día de cada request no depende del
// huso de la máquina que corre el test.
const BASE = new Date(2026, 9, 21, 12, 0, 0).getTime();

function uso(parcial: Partial<Uso>): Uso {
  return {
    sesion: 's1',
    agente: null,
    proyecto: '/proyectos/ejemplo',
    cuando: BASE,
    huecoMs: null,
    entrada: 0,
    lecturaCache: 0,
    escrituraCache5m: 0,
    escrituraCache1h: 0,
    salida: 0,
    ...parcial,
  };
}

const casi = (a: number, b: number, msg?: string): void =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} esperaba ${b}, salió ${a}`);

// ─── el núcleo ───────────────────────────────────────────────────────────

describe('desglose · los pesos', () => {
  test('cada clase pesa lo que cuesta en la API, relativo a la entrada', () => {
    const u = uso({ entrada: 1, escrituraCache5m: 1, escrituraCache1h: 1, lecturaCache: 1, salida: 1 });
    casi(costo(u), 1 + 1.25 + 2 + 0.1 + 5);
    assert.equal(contexto(u), 4, 'el prompt es todo lo que entró: la salida no');
  });

  test('las partes por clase suman 1 y salen en orden fijo', () => {
    const d = desglosar({
      usos: [
        uso({ lecturaCache: 1000, salida: 10 }),
        uso({ escrituraCache1h: 100, escrituraCache5m: 40, entrada: 3 }),
      ],
      compactaciones: [],
      archivos: 1,
    });
    assert.deepEqual(d.porClase.map((k) => k.clase), [...CLASES]);
    casi(d.porClase.reduce((a, k) => a + k.parte, 0), 1);
    // 1000×0,1 + 10×5 + 100×2 + 40×1,25 + 3 = 403
    casi(d.costo, 403);
    casi(d.porClase.find((k) => k.clase === 'lecturaCache')!.parte, 100 / 403);
  });

  test('sin requests no hay NaN: todo en cero', () => {
    const d = desglosar({ usos: [], compactaciones: [], archivos: 0 });
    assert.equal(d.requests, 0);
    assert.equal(d.costo, 0);
    for (const k of d.porClase) assert.equal(k.parte, 0);
    for (const t of d.porContexto) assert.equal(t.parte, 0);
    assert.equal(d.subagentes.parte, 0);
    assert.equal(d.reconstrucciones.length, 6, 'las seis celdas están siempre, aunque valgan cero');
    assert.deepEqual(d.sesiones, []);
  });
});

describe('desglose · el tamaño del prompt', () => {
  test('los bordes: abajo inclusivo, arriba no', () => {
    assert.equal(tramoDe(49_999), '<50k');
    assert.equal(tramoDe(50_000), '50–100k');
    assert.equal(tramoDe(399_999), '200–400k');
    assert.equal(tramoDe(400_000), '400–700k');
    assert.equal(tramoDe(699_999), '400–700k');
    assert.equal(tramoDe(700_000), '>700k');
    assert.equal(tramoDe(5_000_000), '>700k');
  });

  test('cada request cae en un tramo, y 400k o más se junta aparte', () => {
    const d = desglosar({
      usos: [
        uso({ lecturaCache: 30_000, salida: 100 }),
        uso({ lecturaCache: 450_000, salida: 100 }),
        uso({ lecturaCache: 800_000, salida: 100 }),
      ],
      compactaciones: [],
      archivos: 1,
    });
    const por = Object.fromEntries(d.porContexto.map((t) => [t.tramo, t.requests]));
    assert.equal(por['<50k'], 1);
    assert.equal(por['400–700k'], 1);
    assert.equal(por['>700k'], 1);
    assert.equal(d.contextoGrande.requests, 2);
    // 45 500 + 80 500 de 129 000
    casi(d.contextoGrande.parte, (45_000 + 500 + 80_000 + 500) / (3_000 + 500 + 45_000 + 500 + 80_000 + 500));
    casi(d.contextoGrande.parteRequests, 2 / 3);
  });
});

describe('desglose · cache reconstruido', () => {
  test('el hueco: más de una hora, de 5 a 60 minutos, o nada', () => {
    assert.equal(tipoHueco(61 * MINUTO), '>60m');
    assert.equal(tipoHueco(60 * MINUTO), '5–60m');
    assert.equal(tipoHueco(5 * MINUTO + 1), '5–60m');
    assert.equal(tipoHueco(5 * MINUTO), 'sin hueco');
    assert.equal(tipoHueco(0), 'sin hueco');
  });

  test('cuenta sólo lo que no es el primero de su hilo y escribió más de 20k', () => {
    const d = desglosar({
      usos: [
        // El primero de su hilo escribe el cache entero porque no había: no cuenta.
        uso({ huecoMs: null, escrituraCache5m: 90_000 }),
        // 20k justos no alcanzan: el borde es «más de».
        uso({ huecoMs: 2 * HORA, escrituraCache5m: 20_000 }),
        uso({ huecoMs: 2 * HORA, escrituraCache1h: 30_000, lecturaCache: 1_000 }),
        uso({ huecoMs: 10 * MINUTO, escrituraCache5m: 40_000, agente: 'general-purpose' }),
        uso({ huecoMs: MINUTO, escrituraCache5m: 25_000 }),
      ],
      compactaciones: [],
      archivos: 1,
    });
    const celda = (hueco: string, hilo: string) => d.reconstrucciones.find((r) => r.hueco === hueco && r.hilo === hilo)!;
    assert.equal(celda('>60m', 'principal').requests, 1);
    assert.equal(celda('5–60m', 'subagente').requests, 1);
    assert.equal(celda('sin hueco', 'principal').requests, 1);
    assert.equal(celda('>60m', 'subagente').requests, 0);
    assert.equal(d.reconstruccionesTotal.requests, 3);
    // Se cobra la escritura y nada más: la lectura de 1 000 no entra.
    assert.equal(celda('>60m', 'principal').costo, 30_000 * 2);
    casi(d.reconstruccionesTotal.costo, 30_000 * 2 + 40_000 * 1.25 + 25_000 * 1.25);
  });
});

describe('desglose · subagentes y sesiones', () => {
  const usos: Uso[] = [
    uso({ sesion: 'a', cuando: BASE, lecturaCache: 100_000, salida: 0 }),
    uso({ sesion: 'a', cuando: BASE + 2 * HORA, lecturaCache: 300_000, salida: 0 }),
    uso({ sesion: 'a', cuando: BASE + HORA, lecturaCache: 200_000, salida: 0 }),
    uso({ sesion: 'a', agente: 'Explore', lecturaCache: 500_000, proyecto: '/otro' }),
    uso({ sesion: 'b', cuando: BASE, lecturaCache: 900_000, proyecto: '/proyectos/b' }),
  ];
  const compactaciones: Compactacion[] = [
    { sesion: 'a', agente: null, cuando: BASE },
    { sesion: 'a', agente: null, cuando: BASE + HORA },
    // La de un subagente es suya: no le suma a la sesión.
    { sesion: 'a', agente: 'Explore', cuando: BASE },
  ];
  const d = desglosar({ usos, compactaciones, archivos: 3 });

  test('el principal va primero, y la parte de subagentes es la suma del resto', () => {
    assert.equal(d.porAgente[0]!.agente, null);
    assert.equal(d.porAgente[1]!.agente, 'Explore');
    casi(d.subagentes.parte, 50_000 / 200_000);
  });

  test('una sesión se ordena por lo que costó con sus subagentes', () => {
    assert.deepEqual(d.sesiones.map((s) => s.sesion), ['a', 'b'], 'a (60k + 50k) le gana a b (90k)');
    const a = d.sesiones[0]!;
    assert.equal(a.requests, 3, 'requests del hilo principal');
    assert.equal(a.contextoMax, 300_000);
    assert.equal(a.contextoMediana, 200_000);
    assert.equal(a.compactaciones, 2);
    assert.equal(a.fin! - a.inicio!, 2 * HORA);
    assert.equal(a.proyecto, '/proyectos/ejemplo', 'el proyecto es el del hilo principal, no el del subagente');
    casi(a.parteSubagentes, 50_000 / 200_000);
    casi(a.parte, 110_000 / 200_000);
  });

  test('los proyectos y los días suman todo, subagentes incluidos', () => {
    const p = Object.fromEntries(d.proyectos.map((x) => [x.proyecto, x.costo]));
    casi(p['/proyectos/ejemplo']!, 60_000);
    casi(p['/proyectos/b']!, 90_000);
    casi(p['/otro']!, 50_000);
    assert.equal(d.porDia.length, 1);
    assert.equal(d.porDia[0]!.dia, '2026-10-21');
    assert.equal(d.porDia[0]!.requests, 5);
  });
});

// ─── leer sin decodificar ────────────────────────────────────────────────

describe('lineas · el filtro de bytes', () => {
  // Trozos de 7 bytes: casi todas las líneas cruzan un borde, y la marca cae
  // partida entre dos trozos más de una vez. Es la parte que se rompe sin que
  // se note con archivos chicos y trozos de 1 MB.
  test('devuelve exactamente las líneas con alguna marca, con trozos minúsculos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-lineas-'));
    try {
      const lineas = [
        '{"a":1}',
        '{"usage":{"x":1},"relleno":"' + 'z'.repeat(50) + '"}',
        '',
        '{"nada":true}',
        '{"type":"system","subtype":"compact_boundary"}\r',
        '{"b":"usage sin comillas"}',
        '{"usage":2}',
      ];
      const ruta = join(dir, 'a.jsonl');
      // La última línea sin salto: es la que Claude Code está escribiendo.
      writeFileSync(ruta, lineas.join('\n'), 'utf8');
      for (const trozo of [1, 3, 7, 64, 1 << 20]) {
        const salieron = [...lineasCon(ruta, ['"usage"', '"compact_boundary"'], trozo)];
        assert.deepEqual(salieron, [lineas[1], lineas[4], lineas[6]], `con trozos de ${trozo}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('un archivo que no existe no es un error: no da líneas', () => {
    assert.deepEqual([...lineasCon('/no/existe/esto.jsonl', ['"usage"'])], []);
  });
});

// ─── el adaptador de transcripciones ──────────────────────────────────────

/** Un record de assistant con la forma que escribe Claude Code. Nada real adentro. */
function asistente(o: {
  id: string;
  req: string;
  cuando: number;
  cwd?: string;
  modelo?: string;
  entrada?: number;
  lectura?: number;
  escrita?: number;
  de1h?: number | null;
  salida?: number;
}): string {
  const escrita = o.escrita ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: o.entrada ?? 1,
    cache_read_input_tokens: o.lectura ?? 0,
    cache_creation_input_tokens: escrita,
    output_tokens: o.salida ?? 1,
  };
  if (o.de1h !== null) usage['cache_creation'] = { ephemeral_1h_input_tokens: o.de1h ?? 0, ephemeral_5m_input_tokens: escrita - (o.de1h ?? 0) };
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(o.cuando).toISOString(),
    cwd: o.cwd ?? '/proyectos/de-prueba',
    requestId: o.req,
    message: { id: o.id, model: o.modelo ?? 'modelo-de-prueba', usage, content: [{ type: 'text', text: 'x' }] },
  });
}

function compactacion(cuando: number): string {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(cuando).toISOString(), content: 'Conversation compacted' });
}

function perfilFalso(): { perfil: Perfil; raiz: string; proyecto: string } {
  const raiz = mkdtempSync(join(tmpdir(), 'qm-desglose-'));
  const proyecto = join(raiz, 'projects', '-proyectos-de-prueba');
  mkdirSync(proyecto, { recursive: true });
  return { raiz, proyecto, perfil: { directorio: raiz, nombre: '.claude', porDefecto: true, cuenta: null } };
}

const escribir = (ruta: string, lineas: string[]): void => writeFileSync(ruta, lineas.join('\n') + '\n', 'utf8');

describe('transcripciones · cada request, para el desglose', () => {
  const ahora = Date.now();

  test('un mensaje con varios bloques se escribe varias veces y se cuenta una', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      const mismo = asistente({ id: 'msg-1', req: 'req-1', cuando: ahora - MINUTO, lectura: 1000 });
      escribir(join(proyecto, 'sesion-a.jsonl'), [
        mismo,
        mismo,
        mismo,
        // Mismo request, otro mensaje: son dos cosas, la clave es el par.
        asistente({ id: 'msg-2', req: 'req-1', cuando: ahora - MINUTO, lectura: 5 }),
      ]);
      const r = usosDesde(perfil, new Date(ahora - HORA));
      assert.equal(r.usos.length, 2);
      assert.equal(r.usos.reduce((a, u) => a + u.lecturaCache, 0), 1005);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('<synthetic> no es un request', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      escribir(join(proyecto, 'sesion-a.jsonl'), [
        asistente({ id: 'm1', req: 'r1', cuando: ahora - MINUTO, modelo: '<synthetic>' }),
        asistente({ id: 'm2', req: 'r2', cuando: ahora - MINUTO }),
      ]);
      assert.equal(usosDesde(perfil, new Date(ahora - HORA)).usos.length, 1);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('el TTL de lo escrito sale de cache_creation; sin desglose, va todo a 5m', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      escribir(join(proyecto, 'sesion-a.jsonl'), [
        asistente({ id: 'm1', req: 'r1', cuando: ahora - 2 * MINUTO, escrita: 1000, de1h: 300 }),
        asistente({ id: 'm2', req: 'r2', cuando: ahora - MINUTO, escrita: 500, de1h: null }),
      ]);
      const [a, b] = usosDesde(perfil, new Date(ahora - HORA)).usos;
      assert.deepEqual([a!.escrituraCache1h, a!.escrituraCache5m], [300, 700]);
      assert.deepEqual([b!.escrituraCache1h, b!.escrituraCache5m], [0, 500]);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('el hueco se mide contra el anterior del archivo, aunque esté fuera de la ventana', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      escribir(join(proyecto, 'sesion-a.jsonl'), [
        asistente({ id: 'viejo', req: 'r0', cuando: ahora - 3 * HORA }),
        asistente({ id: 'm1', req: 'r1', cuando: ahora - 30 * MINUTO }),
        asistente({ id: 'm1', req: 'r1', cuando: ahora - 30 * MINUTO }),
        asistente({ id: 'm2', req: 'r2', cuando: ahora - 28 * MINUTO }),
      ]);
      const r = usosDesde(perfil, new Date(ahora - HORA));
      assert.equal(r.usos.length, 2, 'el de hace 3 h no se cuenta');
      assert.equal(r.usos[0]!.huecoMs, 150 * MINUTO, 'pero sí es el anterior: el cache estuvo quieto 2,5 h');
      assert.equal(r.usos[1]!.huecoMs, 2 * MINUTO, 'la copia del bloque no reinicia el reloj');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('el primero de un archivo no tiene hueco', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      escribir(join(proyecto, 'sesion-a.jsonl'), [asistente({ id: 'm1', req: 'r1', cuando: ahora - MINUTO, escrita: 90_000 })]);
      assert.equal(usosDesde(perfil, new Date(ahora - HORA)).usos[0]!.huecoMs, null);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('un subagente es de la sesión que lo lanzó, con el tipo de su .meta.json', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      escribir(join(proyecto, 'sesion-a.jsonl'), [asistente({ id: 'm1', req: 'r1', cuando: ahora - MINUTO })]);
      const sub = join(proyecto, 'sesion-a', 'subagents');
      mkdirSync(sub, { recursive: true });
      escribir(join(sub, 'agent-uno.jsonl'), [asistente({ id: 'm2', req: 'r2', cuando: ahora - MINUTO })]);
      writeFileSync(join(sub, 'agent-uno.meta.json'), JSON.stringify({ agentType: 'Explore' }), 'utf8');
      escribir(join(sub, 'agent-dos.jsonl'), [asistente({ id: 'm3', req: 'r3', cuando: ahora - MINUTO })]);

      assert.deepEqual(hiloDe(join(sub, 'agent-uno.jsonl')), { sesion: 'sesion-a', agente: 'Explore' });
      const r = usosDesde(perfil, new Date(ahora - HORA));
      const por = Object.fromEntries(r.usos.map((u) => [u.agente ?? 'principal', u.sesion]));
      assert.deepEqual(por, { principal: 'sesion-a', Explore: 'sesion-a', desconocido: 'sesion-a' });
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  // Un fork arranca con una copia de los requests de quien lo lanzó. Contarla
  // dos veces infla todo; cobrársela al fork la saca de la sesión que la hizo.
  test('la copia que arrastra un fork se cuenta una vez, y en el hilo principal', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      const original = asistente({ id: 'm1', req: 'r1', cuando: ahora - 10 * MINUTO, lectura: 7000 });
      escribir(join(proyecto, 'zzz-sesion.jsonl'), [original]);
      // El directorio del fork ordena ANTES que el archivo principal: si se
      // leyera en el orden del disco, la copia ganaría.
      const sub = join(proyecto, 'aaa-otra', 'subagents');
      mkdirSync(sub, { recursive: true });
      escribir(join(sub, 'agent-f.jsonl'), [original, asistente({ id: 'm9', req: 'r9', cuando: ahora - MINUTO, lectura: 3 })]);
      writeFileSync(join(sub, 'agent-f.meta.json'), JSON.stringify({ agentType: 'fork' }), 'utf8');

      const r = usosDesde(perfil, new Date(ahora - HORA));
      assert.equal(r.usos.length, 2);
      assert.equal(r.usos.find((u) => u.lecturaCache === 7000)!.agente, null);
      assert.equal(r.usos.find((u) => u.lecturaCache === 3)!.agente, 'fork');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('las compactaciones de la ventana se cuentan, y el proyecto sale del cwd', () => {
    const { perfil, raiz, proyecto } = perfilFalso();
    try {
      escribir(join(proyecto, 'sesion-a.jsonl'), [
        compactacion(ahora - 2 * HORA),
        asistente({ id: 'm1', req: 'r1', cuando: ahora - 20 * MINUTO, cwd: '/proyectos/uno' }),
        compactacion(ahora - 10 * MINUTO),
        '{"type":"assistant","message":{"usage":{"input_tokens":1',
      ]);
      const r = usosDesde(perfil, new Date(ahora - HORA));
      assert.equal(r.compactaciones.length, 1, 'la de hace 2 h queda afuera');
      assert.equal(r.usos[0]!.proyecto, '/proyectos/uno');
      assert.equal(r.archivos, 1);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

// ─── Codex ───────────────────────────────────────────────────────────────

function rollout(dir: string, ahora: number): string {
  const ts = (ms: number): string => new Date(ms).toISOString();
  const conteo = (ms: number, total: number, entrada: number, cache: number, salida: number): string =>
    JSON.stringify({
      timestamp: ts(ms),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total },
          last_token_usage: { input_tokens: entrada, cached_input_tokens: cache, output_tokens: salida, total_tokens: entrada + salida },
        },
      },
    });
  const ruta = join(dir, 'rollout-de-prueba.jsonl');
  escribir(ruta, [
    JSON.stringify({ timestamp: ts(ahora - HORA), type: 'session_meta', payload: { id: 'sesion-codex', cwd: '/proyectos/codex' } }),
    conteo(ahora - 30 * MINUTO, 1000, 1000, 800, 50),
    // El mismo acumulado otra vez: Codex lo reemite sin que haya un request.
    conteo(ahora - 29 * MINUTO, 1000, 1000, 800, 50),
    // `token_usage_record` repite las barras; no es un request.
    JSON.stringify({ timestamp: ts(ahora - 29 * MINUTO), type: 'token_usage_record', payload: { type: 'token_count' } }),
    JSON.stringify({ timestamp: ts(ahora - 20 * MINUTO), type: 'compacted', payload: {} }),
    conteo(ahora - 10 * MINUTO, 3000, 2000, 1500, 70),
  ]);
  return ruta;
}

/** Un rollout nuevo: además de los `token_count`, un `token_usage_record` por respuesta. */
function rolloutConRegistros(dir: string, ahora: number): string {
  const ts = (ms: number): string => new Date(ms).toISOString();
  const registro = (ms: number, id: string, entrada: number, cache: number, salida: number): string =>
    JSON.stringify({
      timestamp: ts(ms),
      type: 'token_usage_record',
      payload: { response_id: id, usage: { input_tokens: entrada, cached_input_tokens: cache, output_tokens: salida } },
    });
  const conteo = (ms: number, total: number): string =>
    JSON.stringify({
      timestamp: ts(ms),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total }, last_token_usage: { input_tokens: 999_999 } } },
    });
  const ruta = join(dir, 'rollout-con-registros.jsonl');
  escribir(ruta, [
    JSON.stringify({ timestamp: ts(ahora - HORA), type: 'session_meta', payload: { id: 'sesion-nueva', cwd: '/proyectos/codex' } }),
    registro(ahora - 30 * MINUTO, 'resp-1', 1000, 800, 50),
    conteo(ahora - 30 * MINUTO, 1000),
    registro(ahora - 30 * MINUTO, 'resp-1', 1000, 800, 50),
    // La compactación: una respuesta grande que no emite token_count.
    registro(ahora - 20 * MINUTO, 'resp-2', 300_000, 0, 4_000),
    JSON.stringify({ timestamp: ts(ahora - 20 * MINUTO), type: 'compacted', payload: {} }),
    registro(ahora - 10 * MINUTO, 'resp-3', 2000, 1500, 70),
    conteo(ahora - 10 * MINUTO, 304_000),
  ]);
  return ruta;
}

describe('codex · cada request, para el desglose', () => {
  test('con token_usage_record se cuenta una vez por respuesta, compactaciones incluidas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-codex-'));
    try {
      const ahora = Date.now();
      const r = usosDeRollout(rolloutConRegistros(dir, ahora), ahora - HORA);
      assert.equal(r.usos.length, 3, 'tres respuestas distintas: ni la copia de resp-1 ni los token_count');
      assert.deepEqual(r.usos.map((u) => contexto(u)), [1000, 300_000, 2000]);
      assert.equal(r.usos[1]!.salida, 4_000);
      assert.equal(r.usos[2]!.huecoMs, 10 * MINUTO);
      assert.equal(r.compactaciones.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sin token_usage_record: la entrada incluye lo cacheado, y un acumulado repetido no es un request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-codex-'));
    try {
      const ahora = Date.now();
      const r = usosDeRollout(rollout(dir, ahora), ahora - HORA);
      assert.equal(r.usos.length, 2);
      const [a, b] = r.usos;
      assert.deepEqual([a!.entrada, a!.lecturaCache, a!.salida], [200, 800, 50]);
      assert.equal(contexto(a!), 1000, 'el prompt es input_tokens entero');
      assert.equal(a!.sesion, 'sesion-codex');
      assert.equal(a!.proyecto, '/proyectos/codex');
      assert.equal(b!.huecoMs, 20 * MINUTO, 'contra el request anterior, no contra la reemisión');
      assert.equal(r.compactaciones.length, 1);
      assert.equal(a!.escrituraCache5m + a!.escrituraCache1h, 0, 'Codex no informa escrituras de cache');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── el comando entero ──────────────────────────────────────────────────

const RAIZ = new URL('..', import.meta.url).pathname;

/**
 * Se corre el TypeScript directo y no `bin/qm`: el lanzador prefiere `dist/`
 * cuando existe, y un `dist/` viejo en la máquina de quien corre los tests
 * respondería con el código de antes de este archivo.
 */
function qm(casa: string, args: string[]): { salida: string; codigo: number | null; error: string } {
  const env = { ...process.env };
  delete env['CLAUDE_CONFIG_DIR'];
  delete env['QM_CODEX'];
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(RAIZ, 'src/cli/qm.ts'), ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      HOME: casa,
      XDG_CACHE_HOME: join(casa, 'cache'),
      XDG_CONFIG_HOME: join(casa, 'config'),
      XDG_DATA_HOME: join(casa, 'data'),
      NO_COLOR: '1',
    },
    timeout: 30_000,
  });
  return { salida: r.stdout, codigo: r.status, error: r.stderr };
}

/** Una casa con un perfil de Claude Code y un Codex, todo inventado. */
function casaFalsa(): string {
  const casa = mkdtempSync(join(tmpdir(), 'qm-casa-'));
  const ahora = Date.now();
  const proyecto = join(casa, '.claude', 'projects', '-proyectos-secreto');
  mkdirSync(proyecto, { recursive: true });
  escribir(join(proyecto, 'sesion-uno.jsonl'), [
    asistente({ id: 'm1', req: 'r1', cuando: ahora - 3 * HORA, cwd: '/proyectos/cliente-secreto', lectura: 450_000, salida: 100 }),
    compactacion(ahora - 2 * HORA),
    asistente({ id: 'm2', req: 'r2', cuando: ahora - HORA, cwd: '/proyectos/cliente-secreto', escrita: 60_000, de1h: 60_000 }),
  ]);
  const sub = join(proyecto, 'sesion-uno', 'subagents');
  mkdirSync(sub, { recursive: true });
  escribir(join(sub, 'agent-x.jsonl'), [asistente({ id: 'm3', req: 'r3', cuando: ahora - HORA, cwd: '/proyectos/cliente-secreto', lectura: 10_000 })]);
  writeFileSync(join(sub, 'agent-x.meta.json'), JSON.stringify({ agentType: 'general-purpose' }), 'utf8');
  const rollouts = join(casa, '.codex', 'sessions', '2026', '10', '21');
  mkdirSync(rollouts, { recursive: true });
  rollout(rollouts, ahora);
  return casa;
}

describe('qm --desglose', () => {
  test('sin ninguna cuenta, --json devuelve JSON y no una frase', () => {
    const casa = mkdtempSync(join(tmpdir(), 'qm-vacio-'));
    try {
      const r = qm(casa, ['--desglose', '--json']);
      assert.equal(r.codigo, 0, r.error);
      const d = JSON.parse(r.salida) as Record<string, unknown>;
      assert.equal(d['informe'], 'desglose');
      assert.equal(d['esquema'], 1);
      assert.equal(d['ventanaDias'], 7);
      assert.deepEqual(d['perfiles'], []);
    } finally {
      rmSync(casa, { recursive: true, force: true });
    }
  });

  test('--json trae las cinco respuestas por cuenta, y Codex con las suyas', () => {
    const casa = casaFalsa();
    try {
      const r = qm(casa, ['--desglose', '--json', '--dias=1']);
      assert.equal(r.codigo, 0, r.error);
      const d = JSON.parse(r.salida) as { ventanaDias: number; perfiles: Record<string, any>[] };
      assert.equal(d.ventanaDias, 1);
      const claude = d.perfiles.find((p) => p['perfil'] === '.claude')!;
      assert.equal(claude['requests'], 3);
      // 450 000×0,1 + 100×5 + 1 | 60 000×2 + 1 + 1×5 | 10 000×0,1 + 1 + 5 — más las entradas y salidas de 1
      assert.equal(claude['costo'], 45_000 + 500 + 1 + 120_000 + 1 + 5 + 1_000 + 1 + 5);
      assert.equal(claude['contextoGrande']['requests'], 1);
      assert.equal(claude['reconstruccionesTotal']['requests'], 1, 'el segundo request reescribió 60k tras 2 h');
      assert.equal(claude['reconstrucciones'].find((x: any) => x.hueco === '>60m' && x.hilo === 'principal').requests, 1);
      assert.equal(claude['subagentes']['requests'], 1);
      const s = claude['sesiones'][0];
      assert.equal(s['sesion'], 'sesion-uno');
      assert.equal(s['compactaciones'], 1);
      assert.equal(s['duracionMin'], 120);

      const codex = d.perfiles.find((p) => p['perfil'] === 'codex')!;
      assert.equal(codex['requests'], 2);
      assert.equal(codex['informaEscrituras'], false);
      assert.equal(codex['separaSubagentes'], false);
    } finally {
      rmSync(casa, { recursive: true, force: true });
    }
  });

  test('--redactado no deja salir ni el directorio de trabajo ni el id de sesión', () => {
    const casa = casaFalsa();
    try {
      for (const args of [['--desglose', '--json', '--redactado'], ['--desglose', '--redactado']]) {
        const r = qm(casa, args);
        assert.equal(r.codigo, 0, r.error);
        assert.doesNotMatch(r.salida, /cliente-secreto/, `${args.join(' ')} dejó salir el proyecto`);
        assert.doesNotMatch(r.salida, /\/proyectos\//, `${args.join(' ')} dejó salir una ruta de proyecto`);
        assert.doesNotMatch(r.salida, /sesion-uno|sesion-codex/, `${args.join(' ')} dejó salir un id de sesión`);
        assert.ok(!r.salida.includes(casa), `${args.join(' ')} dejó salir la ruta de casa`);
        assert.match(r.salida, /proyecto 1/);
      }
    } finally {
      rmSync(casa, { recursive: true, force: true });
    }
  });

  test('en texto dice que los pesos son una aproximación, y por qué', () => {
    const casa = casaFalsa();
    try {
      const r = qm(casa, ['--desglose']);
      assert.equal(r.codigo, 0, r.error);
      // El párrafo se parte en renglones: se compara con los espacios aplanados.
      const plano = r.salida.replace(/\s+/g, ' ');
      assert.match(plano, /aproximación/);
      assert.match(plano, /Anthropic no publica cómo pondera la suscripción/);
      assert.match(r.salida, /no aplica: esta cuenta no informa escrituras de cache/, 'Codex no inventa ceros');
    } finally {
      rmSync(casa, { recursive: true, force: true });
    }
  });

  test('--sin-codex deja a Codex afuera, igual que en qm', () => {
    const casa = casaFalsa();
    try {
      const r = qm(casa, ['--desglose', '--json', '--sin-codex']);
      const d = JSON.parse(r.salida) as { perfiles: { perfil: string }[] };
      assert.deepEqual(d.perfiles.map((p) => p.perfil), ['.claude']);
    } finally {
      rmSync(casa, { recursive: true, force: true });
    }
  });
});
