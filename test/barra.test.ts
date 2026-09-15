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
  sesionGrafica: false,
  interprete: false,
  hostDelItem: false,
  arranqueInstalado: false,
  corriendo: false,
};

/** Lo mismo del otro lado: un Linux con GNOME, recién instalado. */
const LINUX_NUEVO: Situacion = {
  ...MAC_NUEVA,
  plataforma: 'linux',
  compilador: false,
  sesionGrafica: true,
  interprete: true,
  hostDelItem: true,
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

test('un Linux con GNOME recién instalado también pregunta', () => {
  assert.strictEqual(debeOfrecer(LINUX_NUEVO), true);
});

test('en un sistema que no es ninguno de los dos no hay barra que ofrecer', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, plataforma: 'freebsd' }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, plataforma: 'win32' }), false);
});

test('las condiciones de siempre valen igual en Linux', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, yaPreguntado: true }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, terminal: false }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, ci: true }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, modoNormal: false }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, corriendo: true }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, arranqueInstalado: true }), false);
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, hayBarra: false }), false);
});

test('por SSH no se ofrece poner algo en una barra que no existe', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, sesionGrafica: false }), false);
});

test('sin python3-gi el item no levanta, y sin extensión que lo muestre no se ve', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, interprete: false }), false);
  // El caso que importa: el proceso ARRANCA igual sin una extensión que lo
  // hospede, y no aparece nada arriba. Ofrecerlo sería prometer algo que no se
  // ve, que es exactamente el bug que este programa existe para no cometer.
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, hostDelItem: false }), false);
});

test('swiftc no es un requisito en Linux, ni la extensión lo es en macOS', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, compilador: false }), true);
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, hostDelItem: false, interprete: false }), true);
});

test('si la barra ya corre o ya arranca sola, no se pregunta', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, corriendo: true }), false);
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, arranqueInstalado: true }), false);
});

test('sin el lanzador o sin swiftc no se ofrece algo que no va a arrancar', () => {
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, hayBarra: false }), false);
  assert.strictEqual(debeOfrecer({ ...MAC_NUEVA, compilador: false }), false);
});

test('en Linux el lanzador es el indicador, y no hay Cellar que mirar', () => {
  const a = comoArrancar('/usr/lib/quartermaster', 'linux');
  assert.strictEqual(a.via, 'indicador');
  assert.strictEqual(a.lanzador, '/usr/lib/quartermaster/bin/qm-indicator');
  // Una ruta con forma de Cellar no lo cambia: eso es de macOS.
  const b = comoArrancar('/opt/homebrew/Cellar/quartermaster/0.1.11/libexec', 'linux');
  assert.strictEqual(b.via, 'indicador');
});

// La plataforma va explícita en los tres de acá abajo: desde que `comoArrancar`
// elige entre el indicador y el lanzador de macOS, un test que no la diga
// contesta distinto según en qué máquina corra — y estos son de macOS.
test('instalado con brew se arranca con brew services, no con un plist al Cellar', () => {
  // El plist de qm-barra apunta a la ruta del lanzador. En brew esa ruta lleva
  // la versión adentro, y el primer `brew upgrade` la borra.
  assert.deepStrictEqual(comoArrancar('/opt/homebrew/Cellar/quartermaster/0.1.6/libexec', 'darwin'), {
    via: 'brew',
    brew: '/opt/homebrew/bin/brew',
    lanzador: '/opt/homebrew/opt/quartermaster/libexec/bin/qm-barra',
  });
  assert.deepStrictEqual(comoArrancar('/usr/local/Cellar/quartermaster/0.2.0/libexec/', 'darwin'), {
    via: 'brew',
    brew: '/usr/local/bin/brew',
    lanzador: '/usr/local/opt/quartermaster/libexec/bin/qm-barra',
  });
});

test('npm, make instalar o un clone usan el lanzador de siempre', () => {
  assert.deepStrictEqual(comoArrancar('/Users/x/.local/lib/node_modules/@legios/quartermaster', 'darwin'), {
    via: 'lanzador',
    lanzador: '/Users/x/.local/lib/node_modules/@legios/quartermaster/bin/qm-barra',
  });
});
