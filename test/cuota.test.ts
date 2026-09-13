import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsearUtilizacion, aFecha } from '../src/adapters/utilizacion.ts';
import { frase, peor, paraMostrar, nombreVentana, esPreocupante, vencida, type ResultadoCuota } from '../src/core/tipos.ts';
import { anchoVisible, duracion, relleno, tenue } from '../src/render/barras.ts';

// Las fixtures son respuestas REALES de dos cuentas de distinto tipo, sacadas
// de `cachedUsageUtilization` en .claude.json y redactadas sólo en accountUuid.
const max = JSON.parse(readFileSync(new URL('./fixtures/cached-usage-max.json', import.meta.url), 'utf8'));
const team = JSON.parse(readFileSync(new URL('./fixtures/cached-usage-team.json', import.meta.url), 'utf8'));

// Las fixtures son grabaciones del 2026-09-09 y sus `resets_at` envejecen solos
// hacia el pasado. Todo lo que dependa de «¿esta ventana sigue abierta?» se mide
// contra un instante de ADENTRO de la grabación, no contra el reloj de hoy: si
// no, los tests de parseo empiezan a fallar por el calendario.
const DURANTE_LA_GRABACION = Date.parse('2026-09-09T00:00:00Z');

// ─── Lo que este repo existe para no dejar pasar ──────────────────────────

test('la barra que manda no es ninguna de las dos que todos leen', () => {
  // En esta cuenta five_hour=8 % y seven_day=59 %: cómodo. La que está por
  // frenarla es un weekly_scoped de un modelo puntual, al 75 % y con aviso.
  const v = parsearUtilizacion(max);
  const p = peor(v)!;
  assert.equal(p.clave, 'weekly_scoped');
  assert.equal(p.porcentaje, 75);
  assert.equal(p.severidad, 'warning');
  assert.equal(p.alcance, 'Fable');
  assert.ok(esPreocupante(p, DURANTE_LA_GRABACION));
  assert.equal(nombreVentana(p), 'weekly_scoped (Fable)');
});

test('un lector que sólo mirara five_hour informaría 8 % con la cuenta al 75 %', () => {
  // El test que fija el tamaño del error, para que se note si alguien
  // "simplifica" el parser y vuelve a leer sólo las claves con nombre.
  const cincoHoras = max.utilization.five_hour.utilization;
  const real = peor(parsearUtilizacion(max))!.porcentaje;
  assert.equal(cincoHoras, 8);
  assert.equal(real, 75);
});

test('las barras en null no se cuentan como barras', () => {
  // seven_day_opus, seven_day_sonnet y otras diez vienen literalmente null.
  assert.equal(max.utilization.seven_day_opus, null);
  const claves = parsearUtilizacion(max).map((v) => v.clave);
  assert.ok(!claves.includes('seven_day_opus'));
});

test('limits[] y las barras con nombre no se muestran dos veces', () => {
  // `session` (de limits[]) y `five_hour` son la misma barra con dos nombres.
  const claves = parsearUtilizacion(max).map((v) => v.clave);
  assert.ok(claves.includes('session'));
  assert.ok(!claves.includes('five_hour'), 'five_hour duplica a session');
  assert.ok(!claves.includes('seven_day'), 'seven_day duplica a weekly_all');
});

test('spend, extra_usage y limits no son barras de cuota', () => {
  const claves = parsearUtilizacion(max).map((v) => v.clave);
  for (const k of ['spend', 'extra_usage', 'limits', 'seven_day_breakdown']) {
    assert.ok(!claves.includes(k), `${k} no es una barra`);
  }
});

test('la segunda cuenta, de otro tipo, se lee igual', () => {
  const v = parsearUtilizacion(team);
  const p = peor(v)!;
  // Acá la activa sí es la más alta: weekly_all al 40 %.
  assert.equal(p.clave, 'weekly_all');
  assert.equal(p.porcentaje, 40);
  assert.equal(p.activa, true);
  assert.equal(p.severidad, 'normal');
});

test('si el servidor marca activa una barra más baja, gana la más alta', () => {
  // En las fixtures la activa resulta ser también la más alta, así que este
  // caso hay que construirlo: es la rama que decide qué te frena PRIMERO.
  const v = parsearUtilizacion({
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 20, severity: 'normal', is_active: true },
      { kind: 'session', group: 'session', percent: 90, severity: 'warning', is_active: false },
    ],
  });
  const p = peor(v)!;
  assert.equal(p.clave, 'session');
  assert.equal(p.porcentaje, 90);
});

test('con todo igual, la activa es la que se marca', () => {
  const v = parsearUtilizacion({
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 30, severity: 'normal', is_active: true },
      { kind: 'session', group: 'session', percent: 30, severity: 'normal', is_active: false },
    ],
  });
  assert.equal(peor(v)!.clave, 'weekly_all');
});

test('resets_at viene en ISO con offset y se entiende', () => {
  const sesion = parsearUtilizacion(max).find((v) => v.clave === 'session')!;
  assert.equal(sesion.reinicia?.toISOString(), '2026-09-09T04:20:00.117Z');
});

test('paraMostrar saca las barras internas que vienen en cero', () => {
  const todas = parsearUtilizacion(max);
  assert.ok(todas.some((v) => v.clave === 'nimbus_quill'), 'el parser no censura nada');
  assert.ok(!paraMostrar(todas).some((v) => v.clave === 'nimbus_quill'), 'el render sí');
});

// ─── Que nunca invente un número ──────────────────────────────────────────

test('una respuesta que no entendemos da cero barras, no una barra inventada', () => {
  assert.deepEqual(parsearUtilizacion({ forma: 'nueva' }), []);
  assert.deepEqual(parsearUtilizacion(null), []);
  assert.deepEqual(parsearUtilizacion('texto'), []);
  assert.deepEqual(parsearUtilizacion({ limits: [{ kind: 'x' }] }), [], 'sin percent no hay barra');
});

test('una entrada de limits sin kind no se cuela con nombre vacío', () => {
  assert.deepEqual(parsearUtilizacion({ limits: [{ percent: 90 }] }), []);
});

// ─── Fechas ───────────────────────────────────────────────────────────────

test('epoch en segundos y en milisegundos no se confunden', () => {
  assert.equal(aFecha(1_800_000_000)?.getUTCFullYear(), 2027);
  assert.equal(aFecha(1_800_000_000_000)?.getUTCFullYear(), 2027);
  assert.equal(aFecha('2027-01-15T10:00:00Z')?.toISOString(), '2027-01-15T10:00:00.000Z');
  assert.equal(aFecha(null), null);
  assert.equal(aFecha('mañana'), null);
});

// ─── Ningún estado mudo ───────────────────────────────────────────────────

test('todo estado sin número produce una frase no vacía', () => {
  const estados: ResultadoCuota[] = [
    { estado: 'sin-credencial' },
    { estado: 'vencida' },
    { estado: 'sin-cache' },
    { estado: 'sin-suscripcion' },
    { estado: 'no-consultada' },
    { estado: 'ilegible', detalle: 'x' },
    { estado: 'error', detalle: 'y' },
  ];
  for (const e of estados) {
    assert.ok(frase(e, '/home/u/.claude-work').length > 0, `${e.estado} no dijo nada`);
  }
});

test('la frase de credencial vencida nombra el perfil y el comando que lo arregla', () => {
  const f = frase({ estado: 'vencida' }, '/home/u/.claude-work');
  assert.match(f, /CLAUDE_CONFIG_DIR=\/home\/u\/\.claude-work/);
  assert.match(f, /claude auth login/);
});

// ─── Render ───────────────────────────────────────────────────────────────

// El literal va escrito a mano a propósito: `tenue()` no pinta nada cuando la
// salida no es una terminal, que es justo el caso en CI, y entonces el test
// pasaría sin haber probado nada.
test('el relleno cuenta columnas, no bytes de color', () => {
  const celda = '\x1b[2msin cuenta\x1b[0m';
  assert.equal(celda.length, 18);
  assert.equal(anchoVisible(celda), 10);
  assert.equal(anchoVisible(relleno(celda, 32)), 32);
  assert.equal(anchoVisible(relleno(celda, 4)), 10, 'no recorta lo que ya es más ancho');
});

test('tenue() sigue siendo medible por anchoVisible, pinte o no pinte', () => {
  assert.equal(anchoVisible(tenue('hola')), 4);
});

// ── paraMostrar · un cero que sí importa ────────────────────────────────
{
  const v = (clave: string, porcentaje: number, grupo: string | null) => ({
    clave,
    alcance: null,
    grupo,
    porcentaje,
    severidad: 'normal',
    activa: false,
    reinicia: null,
  });

  test('paraMostrar: una sesión recién reiniciada se sigue viendo', () => {
    // El caso real: la ventana de 5 h se reinicia varias veces por día y queda
    // en 0. Con el filtro viejo la fila desaparecía entera y el número de la
    // sesión con ella, justo cuando la buena noticia es que tenés el tanque
    // lleno.
    const salida = paraMostrar([v('session', 0, 'session'), v('weekly_all', 70, 'weekly')]);
    assert.deepStrictEqual(salida.map((x) => x.clave), ['session', 'weekly_all']);
  });

  test('paraMostrar: las barras internas del servidor se siguen escondiendo', () => {
    // `nimbus_quill` y compañía vienen en 0 y SIN grupo: no son de esta cuenta.
    const salida = paraMostrar([v('session', 0, 'session'), v('nimbus_quill', 0, null)]);
    assert.deepStrictEqual(salida.map((x) => x.clave), ['session']);
  });

  test('paraMostrar: una interna deja de esconderse si el servidor la marca', () => {
    const marcada = { ...v('cinder_cove', 0, null), severidad: 'warning' };
    assert.strictEqual(paraMostrar([marcada]).length, 1);
  });
}

test('duracion: arriba de un día se cuenta en días', () => {
  // «213h21m» es un número que hay que dividir a mano. Aparece en «último uso»
  // de las cuentas de opencode, que se miden en días, no en horas.
  assert.strictEqual(duracion(213 * 3600_000 + 21 * 60_000), '8d21h');
  assert.strictEqual(duracion(48 * 3600_000), '2d');
  assert.strictEqual(duracion(23 * 3600_000 + 59 * 60_000), '23h59m');
  assert.strictEqual(duracion(90 * 1000), '1m');
});


// ─── Una ventana que ya se reinició no sigue siendo la de antes ───────────
//
// El 2026-09-13, en la cuenta donde se escribió esto, el cache decía
// weekly_all 96 % y weekly_scoped 100 %, las dos `critical`, con un `resets_at`
// de dos horas antes. Una consulta al endpoint devolvió 2 % y 0 %, las dos
// `normal`. Nueve horas diciendo «estás frenado» a alguien que estaba libre.

const ventana = (extra: Record<string, unknown> = {}) => ({
  clave: 'weekly_all',
  porcentaje: 100,
  reinicia: null as Date | null,
  severidad: 'critical',
  activa: true,
  alcance: null,
  grupo: 'weekly',
  ...extra,
});

test('una ventana cuyo reinicio ya pasó está vencida', () => {
  const ahora = Date.parse('2026-09-13T06:00:00Z');
  assert.equal(vencida(ventana({ reinicia: new Date('2026-09-13T04:00:00Z') }), ahora), true);
  assert.equal(vencida(ventana({ reinicia: new Date('2026-09-13T11:00:00Z') }), ahora), false);
  // Sin fecha de reinicio no se puede afirmar que venció. No es lo mismo que
  // saber que sigue vigente: es no saber, y no saber no se redondea a «sí».
  assert.equal(vencida(ventana({ reinicia: null }), ahora), false);
});

test('una ventana vencida NO preocupa, por más critical que diga', () => {
  const ahora = Date.parse('2026-09-13T06:00:00Z');
  const cerrada = ventana({ reinicia: new Date('2026-09-13T04:00:00Z') });
  const abierta = ventana({ reinicia: new Date('2026-09-13T11:00:00Z') });
  // Misma barra, mismo 100 %, misma severidad: lo único que cambia es si su
  // ventana ya cerró. Sostener el critical de una ventana cerrada pinta la
  // bandeja de rojo y dispara el aviso por algo que terminó.
  assert.equal(esPreocupante(cerrada, ahora), false);
  assert.equal(esPreocupante(abierta, ahora), true);
});

test('peor() no puede elegir una barra interna de 0 % porque las fechadas vencieron', () => {
  // La regresión que cazaron los dos tests de arriba cuando `peor()` filtraba
  // por vencimiento: una barra sin `resets_at` —el servidor manda varias, en
  // 0 %— nunca vence, así que quedaba de única candidata y ganaba. La cuenta
  // entera pasaba a mostrarse como un 0 % cómodo. Un «todo bien» inventado es
  // peor que un número viejo.
  const ventanas = [
    ventana({ clave: 'weekly_scoped', porcentaje: 75, reinicia: new Date('2020-01-01T00:00:00Z') }),
    ventana({ clave: 'nimbus_quill', porcentaje: 0, reinicia: null, severidad: 'normal', activa: false, grupo: null }),
  ];
  const p = peor(ventanas)!;
  assert.equal(p.clave, 'weekly_scoped');
  assert.equal(p.porcentaje, 75);
});
