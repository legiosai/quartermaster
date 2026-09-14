// `--cuentas=a,b` con --calentar: a quién se le pregunta.
//
// La barra de macOS manda los nombres cortos (`personal`, `teams`) —los mismos
// que muestra— y el calentado comparaba contra el nombre completo del perfil
// (`.claude-personal`). Un calentado filtrado no le preguntaba a NINGUNA cuenta
// de Claude: sólo acertaba con `codex`, que no tiene prefijo. Y como la barra
// mandaba el calentado completo cuando todas o ninguna se movían, el bug se veía
// únicamente en el caso de todos los días: una cuenta de Claude subiendo sola.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cuentaPedida } from '../src/core/config.ts';

test('el nombre completo sigue sirviendo: es lo que manda el indicador de GNOME', () => {
  assert.strictEqual(cuentaPedida(new Set(['.claude-personal', 'codex']), '.claude-personal'), true);
  assert.strictEqual(cuentaPedida(new Set(['.claude-personal', 'codex']), 'codex'), true);
});

test('el nombre corto también: es lo que manda la barra de macOS', () => {
  assert.strictEqual(cuentaPedida(new Set(['personal']), '.claude-personal'), true);
  assert.strictEqual(cuentaPedida(new Set(['teams', 'codex']), '.claude-teams'), true);
  assert.strictEqual(cuentaPedida(new Set(['main']), '.claude'), true);
});

test('una cuenta que no se pidió no se calienta', () => {
  assert.strictEqual(cuentaPedida(new Set(['personal']), '.claude-teams'), false);
  assert.strictEqual(cuentaPedida(new Set(['codex']), '.claude'), false);
});
