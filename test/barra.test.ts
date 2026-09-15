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
  puedeHospedar: false,
  bandeja: false,
  interop: false,
  arranqueInstalado: false,
  corriendo: false,
};

/**
 * Y la tercera: una WSL recién instalada por npm.
 *
 * `plataforma` dice linux porque eso es lo que dice el kernel, y todo lo de
 * GNOME está en false: en una WSL no hay barra de arriba. Lo que hay es la
 * bandeja de Windows, del otro lado de la interoperabilidad.
 */
const WSL_NUEVA: Situacion = {
  ...MAC_NUEVA,
  plataforma: 'linux',
  compilador: false,
  bandeja: true,
  interop: true,
};

/** Lo mismo del otro lado: un Linux con GNOME, recién instalado. */
const LINUX_NUEVO: Situacion = {
  ...MAC_NUEVA,
  plataforma: 'linux',
  compilador: false,
  sesionGrafica: true,
  interprete: true,
  hostDelItem: true,
  puedeHospedar: true,
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

test('sin python3-gi el item no levanta, así que no se ofrece', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, interprete: false }), false);
});

test('sin NINGÚN host, ni puesto ni por poner, no se ofrece', () => {
  // El proceso ARRANCA igual sin una extensión que lo hospede, y no aparece
  // nada arriba. Ofrecerlo sería prometer algo que no se ve, que es justo el
  // bug que este programa existe para no cometer.
  assert.strictEqual(
    debeOfrecer({ ...LINUX_NUEVO, hostDelItem: false, puedeHospedar: false }), false);
});

test('sin host pero con la extensión en el paquete, SÍ se ofrece: la ponemos nosotros', () => {
  // El caso de una instalación por npm en un GNOME pelado. Hasta 0.1.11
  // `extension/` no viajaba en el paquete y este caso no existía: quien
  // instalaba por npm no podía tener el panel ni sabiéndolo.
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, hostDelItem: false }), true);
});

test('con un host ya puesto se ofrece aunque no podamos instalar la nuestra', () => {
  // Un .deb viejo, o un paquete sin extension/: el item lo muestra AppIndicator.
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, puedeHospedar: false }), true);
});

test('swiftc no es un requisito en Linux, ni la extensión lo es en macOS', () => {
  assert.strictEqual(debeOfrecer({ ...LINUX_NUEVO, compilador: false }), true);
  assert.strictEqual(
    debeOfrecer({ ...MAC_NUEVA, hostDelItem: false, puedeHospedar: false, interprete: false }), true);
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

// ── la bandeja de Windows ───────────────────────────────────────────────
// Era el agujero que quedaba: en macOS y en GNOME `qm` ofrece la barra en la
// primera corrida, y en Windows no ofrecía nada. Quien instalaba por npm en
// WSL se quedaba con el CLI y sin ícono, sin que nada se lo dijera — que es la
// misma forma de silencio que este repo existe para no cometer.

test('una WSL recién instalada, en una terminal, pregunta', () => {
  assert.strictEqual(debeOfrecer(WSL_NUEVA), true);
});

test('sin interoperabilidad con Windows no se ofrece nada', () => {
  // Sin powershell.exe la bandeja no puede levantar, así que ofrecerla sería
  // prometer algo que no va a aparecer.
  assert.strictEqual(debeOfrecer({ ...WSL_NUEVA, interop: false }), false);
});

test('en WSL no se pregunta por GNOME', () => {
  // La comprobación que importa: aunque `plataforma` diga linux, lo que decide
  // es dónde aparece el item. Una WSL sin nada de GNOME —así viene— igual
  // pregunta, porque la bandeja no necesita nada de eso.
  assert.strictEqual(WSL_NUEVA.sesionGrafica, false);
  assert.strictEqual(WSL_NUEVA.interprete, false);
  assert.strictEqual(WSL_NUEVA.hostDelItem, false);
  assert.strictEqual(debeOfrecer(WSL_NUEVA), true);
});

test('con el acceso directo ya puesto, o con la bandeja viva, no se ofrece', () => {
  assert.strictEqual(debeOfrecer({ ...WSL_NUEVA, arranqueInstalado: true }), false);
  assert.strictEqual(debeOfrecer({ ...WSL_NUEVA, corriendo: true }), false);
});

test('en WSL se arranca por el lanzador de la bandeja', () => {
  // Y no por qm-indicator, que es lo que le tocaría a un linux: el tercer
  // argumento es el que decide, no `process.platform`.
  const a = comoArrancar('/casa/quartermaster', 'linux', true);
  assert.strictEqual(a.via, 'bandeja');
  assert.strictEqual(a.lanzador, '/casa/quartermaster/bin/qm-tray');
});

test('un Linux de verdad sigue yendo al indicador', () => {
  const a = comoArrancar('/casa/quartermaster', 'linux', false);
  assert.strictEqual(a.via, 'indicador');
  assert.strictEqual(a.lanzador, '/casa/quartermaster/bin/qm-indicator');
});
