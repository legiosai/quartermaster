// Cuál perfil tiene más margen, y cuándo avisar: las dos reglas puras.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decidirAviso, escalones, podar } from '../src/core/aviso.ts';
import { elegir, evaluar, frenaVigente, type Candidata } from '../src/core/eleccion.ts';
import { mensajeAviso, umbralDe } from '../src/cli/aviso.ts';
import type { Proyeccion } from '../src/core/proyeccion.ts';
import type { ResultadoCuota, VentanaCuota } from '../src/core/tipos.ts';

// Las frases que se comparan son las castellanas; el locale del que corre los
// tests no tiene que cambiarlas.
process.env['QM_IDIOMA'] = 'es';

const AHORA = Date.UTC(2026, 10, 1, 20, 0, 0);
const en = (min: number): Date => new Date(AHORA + min * 60_000);

const v = (clave: string, porcentaje: number, extra: Partial<VentanaCuota> = {}): VentanaCuota => ({
  clave,
  porcentaje,
  reinicia: en(120),
  severidad: 'normal',
  activa: false,
  alcance: null,
  grupo: clave === 'session' ? 'session' : 'weekly',
  ...extra,
});

const ok = (...ventanas: VentanaCuota[]): ResultadoCuota => ({
  estado: 'ok',
  origen: 'endpoint',
  medidoEn: new Date(AHORA - 60_000),
  ventanas,
});

const cand = (nombre: string, cuota: ResultadoCuota, extra: Partial<Candidata> = {}): Candidata => ({
  nombre,
  directorio: `/casa/${nombre}`,
  porDefecto: nombre === '.claude',
  credencial: 'vigente',
  cuota,
  proyeccion: null,
  ...extra,
});

const choca: Proyeccion = { estado: 'sube', ritmo: 30, techo: en(20), chocas: true, muestras: 5 };

describe('frenaVigente · la barra que frena, contando sólo las que valen', () => {
  it('una barra cuyo reinicio ya pasó no cuenta, aunque sea la más alta', () => {
    const f = frenaVigente([v('session', 80, { reinicia: en(-10) }), v('weekly_all', 30)], AHORA);
    assert.equal(f?.clave, 'weekly_all');
  });
  it('si todas se reiniciaron, no hay barra: no es un 0 %', () => {
    assert.equal(frenaVigente([v('session', 80, { reinicia: en(-10) })], AHORA), null);
  });
});

describe('evaluar · quién entra a la comparación', () => {
  it('sin sesión de Claude Code, afuera', () => {
    const e = evaluar(cand('.claude', ok(v('session', 1)), { credencial: 'sin' }), AHORA);
    assert.ok('motivo' in e);
  });
  it('sin número, afuera', () => {
    assert.ok('motivo' in evaluar(cand('.claude', { estado: 'sin-cache' }), AHORA));
  });
  it('un token de acceso vencido NO descarta: Claude Code lo renueva al arrancar', () => {
    const e = evaluar(cand('.claude-teams', ok(v('session', 6)), { credencial: 'vencida' }), AHORA);
    assert.ok(!('motivo' in e));
    assert.equal(e.nivel, 'libre');
    assert.equal(e.libre, 94);
  });
});

describe('elegir · el orden de preferencia', () => {
  it('gana la que tiene más lugar en la barra que frena', () => {
    const e = elegir(
      [cand('.claude', ok(v('session', 10), v('weekly_all', 92))), cand('.claude-teams', ok(v('session', 6), v('weekly_all', 2)))],
      AHORA,
    );
    assert.equal(e.elegida?.candidata.nombre, '.claude-teams');
    assert.equal(e.elegida?.libre, 94);
  });

  it('una que a este ritmo choca pierde contra una con menos lugar que no choca', () => {
    const e = elegir(
      [
        cand('.claude', ok(v('session', 20)), { proyeccion: choca }),
        cand('.claude-teams', ok(v('session', 60))),
      ],
      AHORA,
    );
    assert.deepEqual(e.orden.map((x) => [x.candidata.nombre, x.nivel]), [
      ['.claude-teams', 'libre'],
      ['.claude', 'choca'],
    ]);
  });

  it('la desconocida va después de las libres y antes de las que chocan y las llenas', () => {
    const e = elegir(
      [
        cand('.claude-a', ok(v('session', 100))),
        cand('.claude-b', ok(v('session', 50)), { proyeccion: choca }),
        cand('.claude-c', ok(v('session', 70, { reinicia: en(-5) }))),
        cand('.claude-d', ok(v('session', 95))),
      ],
      AHORA,
    );
    assert.deepEqual(e.orden.map((x) => x.nivel), ['libre', 'desconocida', 'choca', 'llena']);
  });

  it('a igual margen desempata la sesión más vacía', () => {
    const e = elegir(
      [
        cand('.claude-a', ok(v('session', 30), v('weekly_all', 40))),
        cand('.claude-b', ok(v('session', 10), v('weekly_all', 40))),
      ],
      AHORA,
    );
    assert.equal(e.elegida?.candidata.nombre, '.claude-b');
  });

  it('entre llenas, la que se reinicia antes', () => {
    const e = elegir(
      [
        cand('.claude-a', ok(v('session', 100, { reinicia: en(90) }))),
        cand('.claude-b', ok(v('session', 100, { reinicia: en(15) }))),
      ],
      AHORA,
    );
    assert.equal(e.elegida?.candidata.nombre, '.claude-b');
  });

  it('un empate exacto se decide por nombre, siempre igual', () => {
    const a = cand('.claude-a', ok(v('session', 10)));
    const b = cand('.claude-b', ok(v('session', 10)));
    assert.equal(elegir([b, a], AHORA).elegida?.candidata.nombre, '.claude-a');
    assert.equal(elegir([a, b], AHORA).elegida?.candidata.nombre, '.claude-a');
  });

  it('si no queda ninguna, no hay elegida y se dice por qué', () => {
    const e = elegir([cand('.claude', { estado: 'sin-cache' }), cand('.claude-x', ok(v('session', 1)), { credencial: 'sin' })], AHORA);
    assert.equal(e.elegida, null);
    assert.equal(e.descartadas.length, 2);
  });
});

describe('escalones · cuándo puede volver a sonar', () => {
  it('el umbral, 95 y 100; nunca uno por debajo del umbral', () => {
    assert.deepEqual(escalones(90), [90, 95, 100]);
    assert.deepEqual(escalones(97), [97, 100]);
    assert.deepEqual(escalones(100), [100]);
    assert.deepEqual(escalones(50), [50, 95, 100]);
  });
});

describe('decidirAviso · una vez por escalón y por ventana', () => {
  const base = { perfil: '.claude', proyeccion: null, umbral: 90, avisados: new Set<string>(), ahora: AHORA };
  const llave = (u: string | number): string => `.claude|weekly_all|${en(120).toISOString().slice(0, 16)}|${u}`;

  it('debajo del umbral, nada', () => {
    assert.equal(decidirAviso({ ...base, frena: v('weekly_all', 89) }), null);
  });

  it('cruzar el umbral suena una vez', () => {
    const d = decidirAviso({ ...base, frena: v('weekly_all', 92) });
    assert.deepEqual(d?.claves, [llave(90)]);
    assert.equal(d?.escalon, 90);
    assert.equal(decidirAviso({ ...base, frena: v('weekly_all', 93), avisados: new Set([llave(90)]) }), null);
  });

  it('cruzar uno más alto vuelve a sonar, y de paso anota los de abajo', () => {
    const d = decidirAviso({ ...base, frena: v('weekly_all', 96), avisados: new Set([llave(90)]) });
    assert.deepEqual(d?.claves, [llave(95)]);
    const salto = decidirAviso({ ...base, frena: v('weekly_all', 96) });
    assert.deepEqual(salto?.claves, [llave(90), llave(95)]);
  });

  it('cuando la ventana se reinicia, el mismo escalón puede volver a sonar', () => {
    const d = decidirAviso({ ...base, frena: v('weekly_all', 91, { reinicia: en(120 + 7 * 1440) }), avisados: new Set([llave(90)]) });
    assert.equal(d?.escalon, 90);
  });

  it('la proyección suena sola si el choque es dentro de 30 minutos', () => {
    const d = decidirAviso({ ...base, frena: v('weekly_all', 60), proyeccion: choca });
    assert.deepEqual(d?.claves, [llave('choque')]);
    assert.equal(d?.escalon, null);
    const lejos: Proyeccion = { ...choca, techo: en(45) };
    assert.equal(decidirAviso({ ...base, frena: v('weekly_all', 60), proyeccion: lejos }), null);
  });

  it('sin barra vigente no hay aviso', () => {
    assert.equal(decidirAviso({ ...base, frena: null }), null);
  });
});

describe('podar · la memoria no crece para siempre', () => {
  it('saca las ventanas que se reiniciaron hace más de una semana y deja el resto', () => {
    const vieja = `.claude|session|${new Date(AHORA - 9 * 86_400_000).toISOString().slice(0, 16)}|90`;
    const nueva = `.claude|session|${en(60).toISOString().slice(0, 16)}|90`;
    assert.deepEqual(podar([vieja, nueva, 'raro'], AHORA), [nueva, 'raro'].sort());
  });
});

describe('mensajeAviso · lo que ve el usuario', () => {
  const d = (porcentaje: number, techo: Date | null = null) => ({
    claves: ['x'],
    frena: v('weekly_all', porcentaje),
    escalon: 90,
    techo,
  });
  const otra = elegir([cand('.claude-teams', ok(v('session', 6)))], AHORA).elegida;

  it('nombra la barra, el porcentaje, el reinicio y a dónde pasarse', () => {
    const m = mensajeAviso('.claude', d(92), otra, AHORA);
    assert.match(m, /^qm · main: weekly_all al 92 % · se reinicia en 2h00m\./);
    assert.match(m, /teams tiene 94 % libre: CLAUDE_CONFIG_DIR=\/casa\/\.claude-teams claude$/);
  });

  it('con la proyección dice cuánto falta para el techo', () => {
    assert.match(mensajeAviso('.claude', d(80, en(22)), null, AHORA), /llegás al 100 % en 22m, antes de que se reinicie \(en 2h00m\)$/);
  });

  it('en 100 % dice que está frenada', () => {
    assert.match(mensajeAviso('.claude', d(100), null, AHORA), /frenada hasta que se reinicie, en 2h00m$/);
  });

  it('no sugiere una cuenta con menos lugar, ni una que también choca', () => {
    const peorQue = elegir([cand('.claude-teams', ok(v('session', 95)))], AHORA).elegida;
    assert.doesNotMatch(mensajeAviso('.claude', d(92), peorQue, AHORA), /teams/);
    const quechoca = elegir([cand('.claude-teams', ok(v('session', 5)), { proyeccion: choca })], AHORA).elegida;
    assert.doesNotMatch(mensajeAviso('.claude', d(92), quechoca, AHORA), /teams/);
  });

  it('el perfil por defecto se sugiere sin CLAUDE_CONFIG_DIR', { skip: process.platform === 'win32' }, () => {
    const main = elegir([cand('.claude', ok(v('session', 3)))], AHORA).elegida;
    assert.match(mensajeAviso('.claude-teams', d(92), main, AHORA), /main tiene 97 % libre: env -u CLAUDE_CONFIG_DIR claude$/);
  });
});

describe('umbralDe', () => {
  it('lee --umbral=N y vuelve a 90 con cualquier cosa rara', () => {
    assert.equal(umbralDe(['--aviso', '--umbral=80']), 80);
    assert.equal(umbralDe(['--aviso']), 90);
    assert.equal(umbralDe(['--umbral=0']), 90);
    assert.equal(umbralDe(['--umbral=abc']), 90);
  });
});

describe('aviso · en inglés', () => {
  const conIdioma = <T>(idioma: string, f: () => T): T => {
    const antes = process.env['QM_IDIOMA'];
    process.env['QM_IDIOMA'] = idioma;
    try {
      return f();
    } finally {
      if (antes === undefined) delete process.env['QM_IDIOMA'];
      else process.env['QM_IDIOMA'] = antes;
    }
  };

  it('el systemMessage sigue el idioma', () => {
    const otra = elegir([cand('.claude-teams', ok(v('session', 6)))], AHORA).elegida;
    const d = { claves: ['x'], frena: v('weekly_all', 92), escalon: 90, techo: null };
    const m = conIdioma('en', () => mensajeAviso('.claude', d, otra, AHORA));
    assert.match(m, /^qm · main: weekly_all at 92 % · resets in 2h00m\./);
    assert.match(m, /teams has 94 % free: CLAUDE_CONFIG_DIR=\/casa\/\.claude-teams claude$/);
    const techo = conIdioma('en', () => mensajeAviso('.claude', { ...d, frena: v('weekly_all', 80), techo: en(22) }, null, AHORA));
    assert.match(techo, /at this pace you hit 100 % in 22m, before it resets \(in 2h00m\)$/);
    const frenada = conIdioma('en', () => mensajeAviso('.claude', { ...d, frena: v('weekly_all', 100) }, null, AHORA));
    assert.match(frenada, /stopped until it resets, in 2h00m$/);
  });

  it('cambiar de idioma no cambia las claves: un aviso que ya sonó no vuelve a sonar', () => {
    const base = { perfil: '.claude', proyeccion: null, umbral: 90, avisados: new Set<string>(), ahora: AHORA };
    // Sin nombre conocido: en la tabla es «otro límite (…)» u «other limit (…)».
    const rara = v('iguana_necktie', 92);
    const es = conIdioma('es', () => decidirAviso({ ...base, frena: rara }));
    const enIngles = conIdioma('en', () => decidirAviso({ ...base, frena: rara }));
    assert.ok(es !== null);
    assert.deepEqual(enIngles?.claves, es.claves);
    assert.equal(conIdioma('en', () => decidirAviso({ ...base, frena: rara, avisados: new Set(es.claves) })), null);
  });
});

