import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumoGemini,
  duenoGemini,
  estadoCredencialGemini,
  hayGemini,
  perfilGemini,
  transcripcionesGemini,
  ultimaActividadGemini,
} from '../src/adapters/gemini.ts';
import { totalTokens } from '../src/core/tipos.ts';

function entornoGeminiDePrueba(): { raiz: string; limpiar: () => void } {
  const raiz = mkdtempSync(join(tmpdir(), 'qm-gemini-test-'));
  return {
    raiz,
    limpiar: () => rmSync(raiz, { recursive: true, force: true }),
  };
}

/** Un registro de turno de asistente como los que escribe Gemini CLI. */
function turnoGemini(opciones: {
  id?: string;
  cuando: Date;
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
  model?: string;
  tipo?: string;
}): string {
  const inp = opciones.input ?? 100;
  const out = opciones.output ?? 20;
  const cached = opciones.cached ?? 0;
  const thoughts = opciones.thoughts ?? 10;
  const tool = opciones.tool ?? 0;
  const tot = opciones.total ?? inp + out + thoughts;

  return JSON.stringify({
    id: opciones.id ?? 'turn-uuid-1',
    timestamp: opciones.cuando.toISOString(),
    type: opciones.tipo ?? 'gemini',
    tokens: {
      input: inp,
      output: out,
      cached,
      thoughts,
      tool,
      total: tot,
    },
    model: opciones.model ?? 'gemini-3-flash-preview',
  });
}

describe('gemini · descubrimiento y credenciales', () => {
  test('hayGemini detecta si el directorio existe', () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      assert.equal(hayGemini(raiz), true);
      assert.equal(hayGemini(join(raiz, 'inexistente')), false);
    } finally {
      limpiar();
    }
  });

  test('duenoGemini lee google_accounts.json y settings.json', () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      writeFileSync(
        join(raiz, 'google_accounts.json'),
        JSON.stringify({ active: 'dev@example.com', old: [] }),
      );
      writeFileSync(
        join(raiz, 'settings.json'),
        JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
      );
      writeFileSync(
        join(raiz, 'oauth_creds.json'),
        JSON.stringify({ expiry_date: 1893456000000 }), // futuro
      );

      const d = duenoGemini(raiz);
      assert.equal(d.email, 'dev@example.com');
      assert.equal(d.plan, 'oauth-personal');
      assert.equal(d.expiraEn?.getTime(), 1893456000000);

      const p = perfilGemini(raiz);
      assert.equal(p.nombre, 'gemini');
      assert.equal(p.cuenta?.email, 'dev@example.com');
      assert.equal(p.cuenta?.plan, 'oauth-personal');
    } finally {
      limpiar();
    }
  });

  test('estadoCredencialGemini evalúa vigencia por expiry_date', () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      // Sin archivo. `vencida` es FALSE y `error` es null a propósito: que el
      // archivo no esté no es ni una fecha que pasó ni un error de lectura, y
      // confundirlos hace que la pantalla diga «ilegible» sobre algo que no
      // existe. Misma convención que `credenciales.ts`.
      const sin = estadoCredencialGemini(raiz);
      assert.equal(sin.presente, false);
      assert.equal(sin.vencida, false);
      assert.equal(sin.error, null);

      // Ilegible: presente en disco pero roto. ACÁ sí hay `error`, y eso es lo
      // único que distingue este caso del de arriba.
      writeFileSync(join(raiz, 'oauth_creds.json'), '{ no es json');
      const roto = estadoCredencialGemini(raiz);
      assert.equal(roto.presente, false);
      assert.equal(roto.vencida, false);
      assert.notEqual(roto.error, null);

      // Con fecha futura
      const futuro = Date.now() + 3600_000;
      writeFileSync(join(raiz, 'oauth_creds.json'), JSON.stringify({ expiry_date: futuro }));
      const vigente = estadoCredencialGemini(raiz);
      assert.equal(vigente.presente, true);
      assert.equal(vigente.vencida, false);
      assert.equal(vigente.expiraEn?.getTime(), futuro);

      // Con fecha pasada
      const pasado = Date.now() - 3600_000;
      writeFileSync(join(raiz, 'oauth_creds.json'), JSON.stringify({ expiry_date: pasado }));
      const vencida = estadoCredencialGemini(raiz);
      assert.equal(vencida.presente, true);
      assert.equal(vencida.vencida, true);

      // Presente pero sin `expiry_date`: no se puede afirmar que venció.
      writeFileSync(join(raiz, 'oauth_creds.json'), JSON.stringify({ access_token: 'x' }));
      const sinFecha = estadoCredencialGemini(raiz);
      assert.equal(sinFecha.presente, true);
      assert.equal(sinFecha.vencida, false);
      assert.equal(sinFecha.expiraEn, null);
    } finally {
      limpiar();
    }
  });
});

describe('gemini · transcripciones y consumo', () => {
  test('transcripcionesGemini busca recursivo en tmp/*/chats/', () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      const chatDir1 = join(raiz, 'tmp', 'proj-a', 'chats');
      const chatDir2 = join(raiz, 'tmp', 'proj-b', 'chats', 'sub');
      mkdirSync(chatDir1, { recursive: true });
      mkdirSync(chatDir2, { recursive: true });

      writeFileSync(join(chatDir1, 'session-1.jsonl'), '');
      writeFileSync(join(chatDir1, 'no-es-jsonl.txt'), '');
      writeFileSync(join(chatDir2, 'session-2.jsonl'), '');

      const archivos = transcripcionesGemini(raiz);
      assert.equal(archivos.length, 2);
      assert.ok(archivos.some((a) => a.endsWith('session-1.jsonl')));
      assert.ok(archivos.some((a) => a.endsWith('session-2.jsonl')));
    } finally {
      limpiar();
    }
  });

  test('ultimaActividadGemini reporta el mtime más reciente', () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      const chats = join(raiz, 'tmp', 'proj', 'chats');
      mkdirSync(chats, { recursive: true });

      assert.equal(ultimaActividadGemini(raiz), null);

      writeFileSync(join(chats, 'session-1.jsonl'), 'linea');
      const act = ultimaActividadGemini(raiz);
      assert.ok(act instanceof Date);
    } finally {
      limpiar();
    }
  });

  test('consumoGemini suma tokens, pensamientos y lectura de cache', async () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      const chats = join(raiz, 'tmp', 'proj', 'chats');
      mkdirSync(chats, { recursive: true });

      const ahora = new Date();
      // input=1000, output=100, cached=800, thoughts=50
      // total = 1000 + 100 + 50 = 1150
      // entrada = 1000 - 800 = 200
      // lecturaCache = 800
      // salida = 100 + 50 = 150
      // pensamiento = 50
      const linea = turnoGemini({
        id: 'turn-1',
        cuando: ahora,
        input: 1000,
        output: 100,
        cached: 800,
        thoughts: 50,
        model: 'gemini-3-flash-preview',
      });
      writeFileSync(join(chats, 'session-1.jsonl'), `${linea}\n`);

      const res = await consumoGemini(new Date(0), raiz);
      assert.equal(res.consumo.requests, 1);
      assert.equal(res.consumo.entrada, 200);
      assert.equal(res.consumo.lecturaCache, 800);
      assert.equal(res.consumo.salida, 150);
      assert.equal(res.consumo.pensamiento, 50);
      assert.equal(totalTokens(res.consumo), 1150);
      assert.equal(res.consumo.porModelo.get('gemini-3-flash-preview'), 1150);
    } finally {
      limpiar();
    }
  });

  test('deduplicación por id evita duplicar tokens entre turnos repetidos', async () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      const chats = join(raiz, 'tmp', 'proj', 'chats');
      mkdirSync(chats, { recursive: true });

      const ahora = new Date();
      // Mismo ID dos veces (generación y completion post tool-call)
      const l1 = turnoGemini({ id: 'turn-repetido', cuando: ahora, input: 100, output: 50 });
      const l2 = turnoGemini({ id: 'turn-repetido', cuando: ahora, input: 100, output: 50 });

      writeFileSync(join(chats, 'session-1.jsonl'), `${l1}\n${l2}\n`);

      const res = await consumoGemini(new Date(0), raiz);
      assert.equal(res.consumo.requests, 1);
      assert.equal(totalTokens(res.consumo), 160); // 100 + 50 + 10 thoughts por defecto
    } finally {
      limpiar();
    }
  });

  test('lo anterior a la ventana queda afuera', async () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      const chats = join(raiz, 'tmp', 'proj', 'chats');
      mkdirSync(chats, { recursive: true });

      const viejo = new Date(Date.now() - 10 * 86_400_000);
      const reciente = new Date(Date.now() - 1 * 86_400_000);

      const lViejo = turnoGemini({ id: 'v', cuando: viejo, input: 500, output: 50 });
      const lReciente = turnoGemini({ id: 'r', cuando: reciente, input: 200, output: 20 });

      writeFileSync(join(chats, 'session-1.jsonl'), `${lViejo}\n${lReciente}\n`);

      const ventana7d = new Date(Date.now() - 7 * 86_400_000);
      const res = await consumoGemini(ventana7d, raiz);

      assert.equal(res.consumo.requests, 1);
      assert.equal(totalTokens(res.consumo), 230); // 200 + 20 + 10 thoughts
    } finally {
      limpiar();
    }
  });

  test('resiliente a líneas corruptas y objetos sin tokens', async () => {
    const { raiz, limpiar } = entornoGeminiDePrueba();
    try {
      const chats = join(raiz, 'tmp', 'proj', 'chats');
      mkdirSync(chats, { recursive: true });

      const ahora = new Date();
      const valida = turnoGemini({ id: 'ok', cuando: ahora, input: 100, output: 20 });
      const rota = '{"json": incompleto';
      const noGemini = JSON.stringify({ type: 'user', timestamp: ahora.toISOString() });
      const sinTokens = JSON.stringify({ type: 'gemini', id: 'sin-t', timestamp: ahora.toISOString() });

      writeFileSync(join(chats, 'session-1.jsonl'), `${rota}\n${noGemini}\n${sinTokens}\n${valida}\n`);

      const res = await consumoGemini(new Date(0), raiz);
      assert.equal(res.consumo.requests, 1);
    } finally {
      limpiar();
    }
  });
});
