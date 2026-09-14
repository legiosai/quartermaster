// La pregunta de la barra: cuándo se hace y, si se acepta, por dónde se arranca.
//
// Las dos decisiones son puras a propósito. La pregunta aparece en la primera
// corrida y nunca más, y un error acá es de los que no se ven: o molesta en
// cada statusline, o no aparece nunca y la barra sigue sin existir para quien
// instaló con brew.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comoArrancar, debeOfrecer, type Situacion } from '../src/adapters/barra.ts';

const MAC_NUEVA: Situacion = {
  plataforma: 'darwin',
  terminal: true,
  ci: false,
  modoNormal: true,
  yaPreguntado: false,
  hayBarra: true,
  compilador: true,
  arranqueInstalado: false,
  corriendo: false,
};

test('una Mac recién instalada, en una terminal, pregunta', () => {
  assert.strictEqual(debeOfrecer(MAC_NUEVA), true);
});

test('se pregunta una sola vez', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, yaPreguntado: true }), false);
});

test('nunca en --json, --breve, --watch ni --umbral: eso lo leen scripts', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, modoNormal: false }), false);
});

test('nunca sin terminal ni en CI: una pregunta ahí cuelga el proceso', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, terminal: false }), false);
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, ci: true }), false);
});

test('fuera de macOS no hay barra que ofrecer', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, plataforma: 'linux' }), false);
});

test('si la barra ya corre o ya arranca sola, no se pregunta', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, corriendo: true }), false);
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, arranqueInstalado: true }), false);
});

test('sin el lanzador o sin swiftc no se ofrece algo que no va a arrancar', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, hayBarra: false }), false);
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, compilador: false }), false);
});

test('instalado con brew se arranca con brew services, no con un plist al Cellar', () => {
  // El plist de qm-barra apunta a la ruta del lanzador. En brew esa ruta lleva
  // la versión adentro, y el primer `brew upgrade` la borra.
  assert.deepStrictEqual(comoArrancar('/opt/homebrew/Cellar/quartermaster/0.1.6/libexec'), {
    via: 'brew',
    brew: '/opt/homebrew/bin/brew',
    lanzador: '/opt/homebrew/opt/quartermaster/libexec/bin/qm-barra',
  });
  assert.deepStrictEqual(comoArrancar('/usr/local/Cellar/quartermaster/0.2.0/libexec/'), {
    via: 'brew',
    brew: '/usr/local/bin/brew',
    lanzador: '/usr/local/opt/quartermaster/libexec/bin/qm-barra',
  });
});

test('npm, make instalar o un clone usan el lanzador de siempre', () => {
  assert.deepStrictEqual(comoArrancar('/Users/x/.local/lib/node_modules/@legios/quartermaster'), {
    via: 'lanzador',
    lanzador: '/Users/x/.local/lib/node_modules/@legios/quartermaster/bin/qm-barra',
  });
});
