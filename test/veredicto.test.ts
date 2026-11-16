// El veredicto de `qm --diagnostico`, en las tres plataformas.
//
// La CI es Linux, y hasta el issue #10 eso quería decir que las ramas de macOS
// y Windows del diagnóstico no las había corrido nadie: el primer informe de
// una Mac salió sin conclusión, con la sección de GNOME y sin mirar la barra.
// Por eso la conclusión es una función pura —recibe los hechos y no sabe en
// qué sistema corre— y acá se le dan los hechos de cada plataforma.
//
// Y además se dibuja el informe entero de macOS y de Windows desde Linux: las
// sondas de esas plataformas fallan blando sin sus comandos, que es justo la
// propiedad que el diagnóstico promete.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env['QM_IDIOMA'] = 'es';
// Una casa vacía ANTES de importar: hay adaptadores que fijan rutas al cargar.
const casa = mkdtempSync(join(tmpdir(), 'qm-veredicto-'));
process.env['HOME'] = casa;
process.env['USERPROFILE'] = casa;
delete process.env['XDG_CACHE_HOME'];
delete process.env['XDG_CONFIG_HOME'];
delete process.env['CLAUDE_CONFIG_DIR'];

const { concluir, diagnostico, VIEJO_MS } = await import('../src/cli/diagnostico.ts');
type Hechos = Parameters<typeof concluir>[0];
type Numero = NonNullable<Hechos['numeros']>[number];

const AHORA = Date.parse('2026-11-16T12:00:00Z');

const numero = (cuenta: string, hace: number | null, extra: Partial<Numero> = {}): Numero => ({
  cuenta,
  medidoMs: hace === null ? null : AHORA - hace,
  origen: hace === null ? null : 'statusline',
  frase: hace === null ? 'no hay cuota guardada para este perfil' : null,
  statusline: true,
  oculta: false,
  dormida: false,
  ultimoUsoMs: AHORA - 3_600_000,
  ...extra,
});

const sano = [numero('.claude', 60_000)];

function hechos(h: Partial<Hechos>): Hechos {
  return { extension: null, superficie: null, numeros: sano, ...h };
}

// ── macOS ────────────────────────────────────────────────────────────────

const barra = {
  tipo: 'barra' as const,
  compilada: true,
  corriendo: false,
  alIniciar: [] as string[],
  brew: false,
  ultimaSalida: null,
  hayLog: false,
};

test('macOS: la barra compilada que no corre y no arranca sola es un aviso con su arreglo', () => {
  const v = concluir(hechos({ superficie: barra }), AHORA);
  assert.equal(v.avisos.length, 1);
  assert.match(v.avisos[0]!, /no está corriendo/);
  assert.match(v.avisos[0]!, /qm-barra --instalar-arranque/);
});

test('macOS: un agente que la tendría que arrancar y salió con error lo dice, con el código', () => {
  const v = concluir(hechos({
    superficie: { ...barra, alIniciar: ['com.legios.quartermaster.barra'], ultimaSalida: 78 },
  }), AHORA);
  assert.equal(v.avisos.length, 1);
  assert.match(v.avisos[0]!, /com\.legios\.quartermaster\.barra/);
  assert.match(v.avisos[0]!, /código 78/);
  assert.match(v.avisos[0]!, /→ arrancala: qm-barra$/m);
});

test('macOS: si la arranca brew, el arreglo es el de brew', () => {
  const v = concluir(hechos({
    superficie: { ...barra, alIniciar: ['brew services'], brew: true, hayLog: true },
  }), AHORA);
  assert.match(v.avisos[0]!, /brew services restart quartermaster/);
  assert.match(v.avisos[0]!, /log está arriba/);
});

test('macOS: corriendo pero sin arranque automático es una nota, no un aviso', () => {
  const v = concluir(hechos({ superficie: { ...barra, corriendo: true } }), AHORA);
  assert.deepEqual(v.avisos, []);
  assert.equal(v.notas.length, 1);
  assert.match(v.notas[0]!, /no vuelve sola/);
});

test('macOS: una barra que nunca se compiló no es una falla — quien usa sólo el CLI no la necesita', () => {
  const v = concluir(hechos({ superficie: { ...barra, compilada: false } }), AHORA);
  assert.deepEqual(v.avisos, []);
  assert.match(v.notas[0]!, /nunca se arrancó/);
});

test('macOS: corriendo y con arranque, nada que decir', () => {
  const v = concluir(hechos({
    superficie: { ...barra, corriendo: true, alIniciar: ['com.legios.quartermaster.barra'] },
  }), AHORA);
  assert.deepEqual(v, { avisos: [], notas: [] });
});

// ── Windows ──────────────────────────────────────────────────────────────

test('Windows: la bandeja que no corre es un aviso que dice dónde abrirla', () => {
  const v = concluir(hechos({ superficie: { tipo: 'bandeja', corriendo: false, alIniciar: true } }), AHORA);
  assert.equal(v.avisos.length, 1);
  assert.match(v.avisos[0]!, /menú Inicio/);
});

test('Windows: si no se pudo correr PowerShell no se afirma nada sobre la bandeja', () => {
  const v = concluir(hechos({ superficie: { tipo: 'bandeja', corriendo: null, alIniciar: false } }), AHORA);
  assert.deepEqual(v.avisos, []);
  assert.equal(v.notas.length, 1, 'ni siquiera «no arranca sola»: tampoco se sabe');
  assert.match(v.notas[0]!, /PowerShell/);
});

// ── Linux ────────────────────────────────────────────────────────────────

test('Linux: con arranque automático y sin qm-indicator corriendo, avisa', () => {
  const v = concluir(hechos({
    superficie: { tipo: 'indicador', corriendo: false, alIniciar: true, extensionInstalada: true },
  }), AHORA);
  assert.match(v.avisos[0]!, /setsid -f qm-indicator/);
});

test('Linux: sin nada instalado, que no corra el indicador no es un problema', () => {
  const v = concluir(hechos({
    superficie: { tipo: 'indicador', corriendo: false, alIniciar: false, extensionInstalada: false },
  }), AHORA);
  assert.deepEqual(v, { avisos: [], notas: [] });
});

test('Linux: la extensión que corre un archivo viejo manda a cerrar sesión, primero que todo', () => {
  const v = concluir(hechos({
    extension: 'sesion-vieja',
    numeros: [numero('.claude', null)],
  }), AHORA);
  assert.match(v.avisos[0]!, /cerrá sesión/);
  assert.equal(v.avisos.length, 2);
});

// ── los números ──────────────────────────────────────────────────────────

test('sin ninguna cuenta, el veredicto lo dice en vez de dar todo por bueno', () => {
  const v = concluir(hechos({ numeros: [] }), AHORA);
  assert.match(v.avisos[0]!, /ningún perfil/);
});

test('una cuenta sin número es un aviso con la frase de qué hacer', () => {
  const v = concluir(hechos({ numeros: [...sano, numero('.claude-trabajo', null)] }), AHORA);
  assert.equal(v.avisos.length, 1);
  assert.match(v.avisos[0]!, /^⚠ \.claude-trabajo: no hay cuota guardada/);
});

test('una cuenta dormida u oculta sin número NO es un aviso', () => {
  const v = concluir(hechos({
    numeros: [...sano, numero('.claude-vieja', null, { dormida: true }), numero('.claude-x', null, { oculta: true })],
  }), AHORA);
  assert.deepEqual(v.avisos, []);
});

test('una cuenta sin número que no se usa hace semanas es una nota, no un aviso', () => {
  // Medido en una Mac: un plan Max sin usar desde hacía 59 días. No es dormida
  // —es paga, y puede ser la que esperás que se libere— pero sin uso no hay
  // lectura que guardar, y un «⚠» por eso enseña a ignorar los que importan.
  const v = concluir(hechos({
    numeros: [...sano, numero('.claude', null, { ultimoUsoMs: AHORA - 59 * 86_400_000 })],
  }), AHORA);
  assert.deepEqual(v.avisos, []);
  assert.match(v.notas[0]!, /no se usa hace 59 días/);
});

test('un número más viejo que el umbral avisa, y sugiere la statusline sólo a quien no la tiene', () => {
  const viejo = VIEJO_MS + 3_600_000;
  const sinSl = concluir(hechos({ numeros: [numero('.claude', viejo, { statusline: false })] }), AHORA);
  assert.match(sinSl.avisos[0]!, /nada lo está refrescando/);
  assert.match(sinSl.avisos[0]!, /qm --statusline/);
  assert.match(sinSl.avisos[0]!, /qm --refrescar/);

  const conSl = concluir(hechos({ numeros: [numero('.claude', viejo)] }), AHORA);
  assert.doesNotMatch(conSl.avisos[0]!, /qm --statusline/);
});

test('alcanza con UN número fresco: las demás cuentas pueden no usarse hoy', () => {
  const v = concluir(hechos({ numeros: [numero('.claude', 60_000), numero('codex', VIEJO_MS * 4, { statusline: null })] }), AHORA);
  assert.deepEqual(v.avisos, []);
});

test('si no se pudieron leer las cuentas, es un bug y lo dice', () => {
  const v = concluir(hechos({ numeros: null, errorNumeros: 'EACCES' }), AHORA);
  assert.match(v.avisos[0]!, /EACCES/);
  assert.match(v.avisos[0]!, /issue/);
});

// ── el informe entero, en las otras dos plataformas ──────────────────────

test('el informe de macOS mira la barra, no GNOME, y termina en un veredicto', () => {
  const s = diagnostico('0.0.0', 'darwin');
  assert.match(s, /── la barra de menú/);
  assert.doesNotMatch(s, /extensión de GNOME/);
  assert.doesNotMatch(s, /XDG_CURRENT_DESKTOP/, 'el escritorio de Linux no tiene nada que hacer en una Mac');
  assert.doesNotMatch(s, /lo que anotó el sistema/);
  assert.match(s, /── veredicto[^\n]*\n {2}[⚠ℹ✓]/u);
});

test('el informe de Windows mira la bandeja y termina en un veredicto', () => {
  const s = diagnostico('0.0.0', 'win32');
  assert.match(s, /── la bandeja/);
  assert.doesNotMatch(s, /extensión de GNOME/);
  assert.match(s, /── veredicto[^\n]*\n {2}[⚠ℹ✓]/u);
});

test('en una casa vacía, el veredicto dice que no hay nada que leer', () => {
  const s = diagnostico('0.0.0', 'linux');
  assert.match(s, /── los números[^\n]*\n {2}\(ninguna cuenta\)/);
  assert.match(s, /⚠ no encontré ningún perfil/);
});
