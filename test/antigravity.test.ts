// El adaptador de Antigravity.
//
// Los blobs de prueba se ARMAN acá con un codificador de protobuf de diez
// líneas, en vez de copiar un .db real: un fixture binario sacado de una
// máquina no se puede leer ni corregir, y además vendría con las
// conversaciones de alguien adentro.

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  camposVarint,
  conversacionesAntigravity,
  consumoAntigravity,
  estadoCredencialAntigravity,
  camposTexto,
  formaConocida,
  hayAntigravity,
  planAntigravity,
  ultimaActividadAntigravity,
} from '../src/adapters/antigravity.ts';
import { totalTokens } from '../src/core/tipos.ts';

// ─── un protobuf mínimo, para armar los casos ──────────────────────────────

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

/** campo de varint: `<clave><valor>` */
function campo(num: number, valor: number): number[] {
  return [...varint(num * 8 + 0), ...varint(valor)];
}

/** submensaje: `<clave><largo><cuerpo>` */
function sub(num: number, cuerpo: number[]): number[] {
  return [...varint(num * 8 + 2), ...varint(cuerpo.length), ...cuerpo];
}

/**
 * Un request como los que escribe Antigravity: el grupo 1.4.* con el desglose
 * y, opcionalmente, 1.9.10.4 con la ventana de contexto.
 */
function request(o: {
  entrada: number;
  salida: number;
  pensamiento: number;
  herramientas: number;
  sistema?: number;
  ventana?: number | null;
}): Uint8Array {
  const grupo = sub(4, [
    ...campo(1, o.sistema ?? 1318),
    ...campo(2, o.entrada),
    ...campo(3, o.salida),
    ...campo(9, o.pensamiento),
    ...campo(10, o.herramientas),
  ]);
  const ventana = o.ventana === null ? [] : sub(9, sub(10, campo(4, o.ventana ?? 256_000)));
  return new Uint8Array(sub(1, [...grupo, ...ventana]));
}

function entornoDePrueba(): { raiz: string; base: (nombre: string, filas: Uint8Array[]) => string; limpiar: () => void } {
  const raiz = mkdtempSync(join(tmpdir(), 'qm-ag-test-'));
  mkdirSync(join(raiz, 'conversations'), { recursive: true });
  return {
    raiz,
    base(nombre, filas) {
      const ruta = join(raiz, 'conversations', `${nombre}.db`);
      const db = new DatabaseSync(ruta);
      db.exec('create table gen_metadata (idx integer, data blob, size integer)');
      const ins = db.prepare('insert into gen_metadata (idx, data, size) values (?, ?, ?)');
      filas.forEach((f, i) => ins.run(i, f, f.length));
      db.close();
      return ruta;
    },
    limpiar: () => rmSync(raiz, { recursive: true, force: true }),
  };
}

const AYER = new Date(Date.now() - 24 * 3600_000);

describe('antigravity · descubrimiento', () => {
  test('hayAntigravity pide la carpeta de conversaciones, no sólo el directorio', () => {
    const e = entornoDePrueba();
    try {
      assert.equal(hayAntigravity(e.raiz), true);
      // Un ~/.gemini/antigravity sin conversations/ es una instalación que
      // nunca se usó: no hay nada que medir y no tiene que aparecer una fila.
      const vacio = mkdtempSync(join(tmpdir(), 'qm-ag-vacio-'));
      try {
        assert.equal(hayAntigravity(vacio), false);
      } finally {
        rmSync(vacio, { recursive: true, force: true });
      }
    } finally {
      e.limpiar();
    }
  });

  test('conversacionesAntigravity lista sólo los .db', () => {
    const e = entornoDePrueba();
    try {
      e.base('uno', [request({ entrada: 10, salida: 1, pensamiento: 1, herramientas: 0 })]);
      writeFileSync(join(e.raiz, 'conversations', 'ruido.txt'), 'no soy una base');
      const l = conversacionesAntigravity(e.raiz);
      assert.equal(l.length, 1);
      assert.match(l[0]!, /uno\.db$/);
    } finally {
      e.limpiar();
    }
  });

  test('ultimaActividadAntigravity no abre ninguna base', () => {
    const e = entornoDePrueba();
    try {
      e.base('uno', [request({ entrada: 10, salida: 1, pensamiento: 1, herramientas: 0 })]);
      const u = ultimaActividadAntigravity(e.raiz);
      assert.ok(u instanceof Date);
      assert.ok(Date.now() - u.getTime() < 60_000);
    } finally {
      e.limpiar();
    }
  });
});

describe('antigravity · el gate de forma', () => {
  test('camposVarint indexa por ruta de campo', () => {
    const c = camposVarint(request({ entrada: 500, salida: 20, pensamiento: 7, herramientas: 3 }));
    assert.equal(c.get('1.4.2'), 500);
    assert.equal(c.get('1.4.3'), 20);
    assert.equal(c.get('1.4.9'), 7);
    assert.equal(c.get('1.4.10'), 3);
    assert.equal(c.get('1.9.10.4'), 256_000);
  });

  test('sin el grupo 1.4.* no se cree nada', () => {
    // El caso que importa: Google renumera y los campos dejan de estar donde
    // se los infirió. Ahí no hay número que sumar, y sumar cero sería mentir.
    assert.equal(formaConocida(new Map([['1.9.10.4', 256_000]])), false);
  });

  test('la ventana de contexto corrobora cuando está, y no se exige cuando no', () => {
    const con = camposVarint(request({ entrada: 5, salida: 1, pensamiento: 1, herramientas: 1 }));
    const sinVentana = camposVarint(
      request({ entrada: 5, salida: 1, pensamiento: 1, herramientas: 1, ventana: null }),
    );
    assert.equal(formaConocida(con), true);
    // 152 de 566 requests reales no traen la ventana. Exigirla tiraba el 27 %
    // del consumo y lo mostraba como si no hubiera existido.
    assert.equal(formaConocida(sinVentana), true);
  });

  test('una ventana que no es ninguna conocida sí levanta la mano', () => {
    const raro = camposVarint(
      request({ entrada: 5, salida: 1, pensamiento: 1, herramientas: 1, ventana: 7 }),
    );
    assert.equal(formaConocida(raro), false);
  });
});

describe('antigravity · consumo', () => {
  test('suma entrada, salida, pensamiento y herramientas', () => {
    const e = entornoDePrueba();
    try {
      e.base('a', [
        request({ entrada: 1000, salida: 50, pensamiento: 20, herramientas: 5 }),
        request({ entrada: 2000, salida: 60, pensamiento: 10, herramientas: 0 }),
      ]);
      const r = consumoAntigravity(AYER, e.raiz);
      assert.equal(r.consumo.requests, 2);
      assert.equal(totalTokens(r.consumo), 1000 + 50 + 20 + 5 + 2000 + 60 + 10);
      // El pensamiento va DENTRO de la salida y además aparte, como en
      // `transcripciones.ts`: `totalTokens` no lo suma dos veces.
      assert.equal(r.consumo.pensamiento, 30);
      assert.equal(r.formaRota, false);
    } finally {
      e.limpiar();
    }
  });

  test('lo anterior a la ventana queda afuera', () => {
    const e = entornoDePrueba();
    try {
      e.base('a', [request({ entrada: 1000, salida: 50, pensamiento: 0, herramientas: 0 })]);
      const futuro = new Date(Date.now() + 3600_000);
      const r = consumoAntigravity(futuro, e.raiz);
      assert.equal(r.consumo.requests, 0);
      assert.equal(totalTokens(r.consumo), 0);
    } finally {
      e.limpiar();
    }
  });

  test('un formato que cambió dice «no sé», no «cero»', () => {
    // La distinción es el punto entero del gate. Con `formaRota` en false y
    // cero tokens, la pantalla diría «no gastaste nada», que es una afirmación
    // sobre el consumo. Lo cierto es que no se pudo leer.
    const e = entornoDePrueba();
    try {
      e.base('a', [
        new Uint8Array(sub(1, sub(99, campo(1, 123)))),
        new Uint8Array(sub(1, sub(98, campo(2, 456)))),
      ]);
      const r = consumoAntigravity(AYER, e.raiz);
      assert.equal(r.consumo.requests, 0);
      assert.equal(r.formaRota, true);
    } finally {
      e.limpiar();
    }
  });

  test('sin bases no hay formato roto: no hay nada que leer', () => {
    const e = entornoDePrueba();
    try {
      const r = consumoAntigravity(AYER, e.raiz);
      assert.equal(r.consumo.requests, 0);
      assert.equal(r.formaRota, false);
    } finally {
      e.limpiar();
    }
  });

  test('una base ilegible se saltea y las demás se cuentan', () => {
    const e = entornoDePrueba();
    try {
      writeFileSync(join(e.raiz, 'conversations', 'rota.db'), 'esto no es sqlite');
      e.base('buena', [request({ entrada: 700, salida: 30, pensamiento: 0, herramientas: 0 })]);
      const r = consumoAntigravity(AYER, e.raiz);
      assert.equal(r.consumo.requests, 1);
      assert.equal(totalTokens(r.consumo), 730);
    } finally {
      e.limpiar();
    }
  });
});

describe('antigravity · credencial', () => {
  test('ausente es «sin credencial», no «ilegible» ni «vencida»', () => {
    const e = entornoDePrueba();
    try {
      const c = estadoCredencialAntigravity(e.raiz);
      assert.equal(c.presente, false);
      assert.equal(c.vencida, false);
      assert.equal(c.error, null);
    } finally {
      e.limpiar();
    }
  });

  test('presente sin expiry_date no se puede declarar vencida', () => {
    const e = entornoDePrueba();
    try {
      writeFileSync(join(e.raiz, 'oauth_creds.json'), JSON.stringify({ access_token: 'x' }));
      const c = estadoCredencialAntigravity(e.raiz);
      assert.equal(c.presente, true);
      assert.equal(c.vencida, false);
      assert.equal(c.expiraEn, null);
    } finally {
      e.limpiar();
    }
  });

  test('con fecha pasada, vencida', () => {
    const e = entornoDePrueba();
    try {
      writeFileSync(
        join(e.raiz, 'oauth_creds.json'),
        JSON.stringify({ expiry_date: Date.now() - 3600_000 }),
      );
      const c = estadoCredencialAntigravity(e.raiz);
      assert.equal(c.presente, true);
      assert.equal(c.vencida, true);
    } finally {
      e.limpiar();
    }
  });
});

describe('antigravity · el plan', () => {
  test('camposTexto saca las cadenas por ruta', () => {
    const cuerpo = [...sub(2, [...Buffer.from('Google AI Pro')])];
    const m = camposTexto(new Uint8Array(sub(36, cuerpo)));
    assert.equal(m.get('36.2'), 'Google AI Pro');
  });

  test('sin state.vscdb no se inventa un plan', () => {
    // Windows sin Antigravity, o una instalación que nunca abrió el IDE. El
    // adaptador cae al genérico en vez de tirar.
    assert.equal(planAntigravity(join(tmpdir(), 'no-existe-qm-ag', 'state.vscdb')), null);
  });

  test('un state.vscdb sin la clave tampoco', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'qm-ag-estado-'));
    try {
      const ruta = join(raiz, 'state.vscdb');
      const db = new DatabaseSync(ruta);
      db.exec('create table ItemTable (key text, value blob)');
      db.prepare('insert into ItemTable values (?, ?)').run('otra.cosa', 'x');
      db.close();
      assert.equal(planAntigravity(ruta), null);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});
