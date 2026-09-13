import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumoDesde, transcripciones } from '../src/adapters/transcripciones.ts';
import type { Perfil } from '../src/core/tipos.ts';

// El piso, por fin con tests.
//
// SOUL.md dice que el adaptador de transcripciones «nunca es opcional»: es el
// único camino que da un número aunque todos los tokens estén vencidos. Era
// también el único módulo del repo sin un solo test, que es una combinación
// incómoda — el piso es justo lo que no se puede permitir que se rompa en
// silencio.
//
// Lo que se comprueba acá es lo que el archivo promete y no se ve mirándolo:
// la deduplicación por requestId (que SOUL.md llama «no visible hasta que
// alguien lo comprueba a mano»), la ventana, y que un archivo roto no tumbe la
// lectura entera.

function perfilDePrueba(): { perfil: Perfil; raiz: string; proyecto: string } {
  const raiz = mkdtempSync(join(tmpdir(), 'qm-trans-'));
  const proyecto = join(raiz, 'projects', 'un-proyecto');
  mkdirSync(proyecto, { recursive: true });
  return {
    raiz,
    proyecto,
    perfil: { directorio: raiz, nombre: '.claude', porDefecto: true, cuenta: null },
  };
}

/** Un record de assistant como los que escribe Claude Code. */
function registro(opciones: {
  requestId?: string | null;
  cuando: Date;
  entrada?: number;
  salida?: number;
  lectura?: number;
  creacion?: number;
  modelo?: string;
  tipo?: string;
}): string {
  const d: Record<string, unknown> = {
    type: opciones.tipo ?? 'assistant',
    timestamp: opciones.cuando.toISOString(),
    message: {
      model: opciones.modelo ?? 'claude-opus-5',
      usage: {
        input_tokens: opciones.entrada ?? 10,
        output_tokens: opciones.salida ?? 5,
        cache_read_input_tokens: opciones.lectura ?? 0,
        cache_creation_input_tokens: opciones.creacion ?? 0,
      },
    },
  };
  if (opciones.requestId !== null) d['requestId'] = opciones.requestId ?? 'req-1';
  return JSON.stringify(d);
}

/** Escribe un .jsonl y le pone mtime de ahora, que es lo que mira el filtro. */
function escribir(proyecto: string, nombre: string, lineas: string[]): string {
  const ruta = join(proyecto, nombre);
  writeFileSync(ruta, lineas.join('\n') + '\n', 'utf8');
  const ahora = new Date();
  utimesSync(ruta, ahora, ahora);
  return ruta;
}

const hace = (ms: number): Date => new Date(Date.now() - ms);
const MINUTO = 60_000;
const HORA = 60 * MINUTO;

describe('transcripciones · encontrar los archivos', () => {
  test('sin projects/ no hay transcripciones, y no revienta', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'qm-vacio-'));
    try {
      const perfil: Perfil = { directorio: raiz, nombre: '.claude', porDefecto: true, cuenta: null };
      assert.deepEqual(transcripciones(perfil), []);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('busca recursivo y sólo .jsonl', () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [registro({ cuando: hace(MINUTO) })]);
      writeFileSync(join(proyecto, 'notas.md'), 'esto no es una transcripción', 'utf8');
      const hondo = join(proyecto, 'mas', 'adentro');
      mkdirSync(hondo, { recursive: true });
      escribir(hondo, 'b.jsonl', [registro({ cuando: hace(MINUTO), requestId: 'req-2' })]);

      const encontradas = transcripciones(perfil).map((r) => r.replace(raiz, ''));
      assert.equal(encontradas.length, 2, 'las dos .jsonl, y el .md afuera');
      assert.ok(encontradas.some((r) => r.endsWith('a.jsonl')));
      assert.ok(encontradas.some((r) => r.endsWith('b.jsonl')));
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('transcripciones · el consumo', () => {
  test('suma las cuatro clases de token y cuenta los requests', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [
        registro({ cuando: hace(MINUTO), requestId: 'r1', entrada: 100, salida: 20, lectura: 7, creacion: 3 }),
        registro({ cuando: hace(2 * MINUTO), requestId: 'r2', entrada: 50, salida: 10 }),
      ]);
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 2);
      assert.equal(c.entrada, 150);
      assert.equal(c.salida, 30);
      assert.equal(c.lecturaCache, 7);
      assert.equal(c.creacionCache, 3);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  // EL test de este archivo. Una sesión reanudada o bifurcada reescribe los
  // mismos requests en un archivo nuevo; contarlos dos veces infla todos los
  // números de abajo y no se nota mirando la pantalla.
  test('deduplica por requestId ENTRE archivos distintos', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      const mismo = registro({ cuando: hace(MINUTO), requestId: 'repetido', entrada: 1000, salida: 100 });
      escribir(proyecto, 'sesion.jsonl', [mismo]);
      escribir(proyecto, 'sesion-reanudada.jsonl', [mismo]);

      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 1, 'el request repetido se cuenta UNA vez');
      assert.equal(c.entrada, 1000, 'y sus tokens también');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('un record sin requestId no se deduplica: se cuenta siempre', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [
        registro({ cuando: hace(MINUTO), requestId: null, entrada: 10, salida: 1 }),
        registro({ cuando: hace(MINUTO), requestId: null, entrada: 10, salida: 1 }),
      ]);
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 2, 'sin id no hay forma de saber que es el mismo');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('lo anterior a la ventana queda afuera', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [
        registro({ cuando: hace(10 * MINUTO), requestId: 'dentro', entrada: 7 }),
        registro({ cuando: hace(48 * HORA), requestId: 'afuera', entrada: 999999 }),
      ]);
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 1);
      assert.equal(c.entrada, 7, 'el viejo no entró');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('sólo cuentan los records de assistant con usage', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [
        registro({ cuando: hace(MINUTO), requestId: 'u', tipo: 'user', entrada: 500 }),
        JSON.stringify({ type: 'assistant', timestamp: hace(MINUTO).toISOString(), message: { model: 'x' } }),
        registro({ cuando: hace(MINUTO), requestId: 'a', entrada: 3 }),
      ]);
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 1);
      assert.equal(c.entrada, 3);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  // Silencio es el bug, pero al revés: una línea rota no puede llevarse puesto
  // el resto del archivo. Claude Code escribe mientras se lo lee, así que la
  // última línea truncada es normal, no excepcional.
  test('una línea rota no tumba el archivo entero', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [
        registro({ cuando: hace(MINUTO), requestId: 'bueno', entrada: 11 }),
        '{"type":"assistant","message":{"usage":{"input_tokens":1',
        registro({ cuando: hace(MINUTO), requestId: 'otro', entrada: 22 }),
      ]);
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 2);
      assert.equal(c.entrada, 33);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('sin nada que contar devuelve el consumo vacío, no NaN', async () => {
    const { perfil, raiz } = perfilDePrueba();
    try {
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.requests, 0);
      assert.equal(c.entrada, 0);
      assert.equal(c.primero, null);
      assert.equal(c.ultimo, null);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('agrupa por modelo, que es lo que muestra la fila de abajo', async () => {
    const { perfil, raiz, proyecto } = perfilDePrueba();
    try {
      escribir(proyecto, 'a.jsonl', [
        registro({ cuando: hace(MINUTO), requestId: 'r1', modelo: 'claude-opus-5', entrada: 100, salida: 0 }),
        registro({ cuando: hace(MINUTO), requestId: 'r2', modelo: 'claude-opus-5', entrada: 100, salida: 0 }),
        registro({ cuando: hace(MINUTO), requestId: 'r3', modelo: 'claude-haiku-4-5', entrada: 5, salida: 0 }),
      ]);
      const c = await consumoDesde(perfil, hace(HORA));
      assert.equal(c.porModelo.get('claude-opus-5'), 200);
      assert.equal(c.porModelo.get('claude-haiku-4-5'), 5);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
