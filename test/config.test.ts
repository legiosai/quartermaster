// La selección de cuentas: descubrir todo no es lo mismo que mostrar todo.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nombreCorto, seleccionar } from '../src/core/config.ts';

const f = (nombre: string) => ({ perfil: { nombre } });
const TODAS = [f('.claude'), f('.claude-personal'), f('.claude-teams'), f('codex')];
const nombres = (xs: { perfil: { nombre: string } }[]) => xs.map((x) => nombreCorto(x.perfil.nombre));

test('nombreCorto: el perfil por defecto se llama main', () => {
  assert.strictEqual(nombreCorto('.claude'), 'main');
  assert.strictEqual(nombreCorto('.claude-teams'), 'teams');
  assert.strictEqual(nombreCorto('codex'), 'codex');
});

test('sin config se muestran todas', () => {
  const r = seleccionar(TODAS, { mostrar: null, ocultar: [] });
  assert.deepStrictEqual(nombres(r.filas), ['main', 'personal', 'teams', 'codex']);
  assert.strictEqual(r.nota, null);
});

test('mostrar deja sólo esas, en el orden de siempre', () => {
  const r = seleccionar(TODAS, { mostrar: ['codex', 'personal'], ocultar: [] });
  assert.deepStrictEqual(nombres(r.filas), ['personal', 'codex']);
});

test('ocultar saca esas', () => {
  const r = seleccionar(TODAS, { mostrar: null, ocultar: ['main', 'teams'] });
  assert.deepStrictEqual(nombres(r.filas), ['personal', 'codex']);
});

test('se acepta el nombre completo del perfil además del corto', () => {
  const r = seleccionar(TODAS, { mostrar: ['.claude-teams'], ocultar: [] });
  assert.deepStrictEqual(nombres(r.filas), ['teams']);
});

test('un filtro que no coincide con nada NO deja la pantalla vacía', () => {
  // Es casi seguro un nombre mal escrito. Quedarse sin números y sin
  // explicación es exactamente el bug que este repo existe para no cometer:
  // se muestran todas y se dice que el filtro no pegó.
  const r = seleccionar(TODAS, { mostrar: ['gemini'], ocultar: [] });
  assert.strictEqual(r.filas.length, 4);
  assert.match(r.nota ?? '', /no coincidió/);
});

test('cuando se esconde algo, se dice cuánto', () => {
  const r = seleccionar(TODAS, { mostrar: null, ocultar: ['main'] });
  assert.match(r.nota ?? '', /1 cuenta/);
});
