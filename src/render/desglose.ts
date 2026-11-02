// El desglose, en texto. Sólo dibuja: cada número llega calculado desde
// `core/desglose.ts`, y lo único que se decide acá es cómo se ve.

import { HUECOS, consejos, type Clase, type Consejo, type Desglose, type Porcion } from '../core/desglose.ts';
import { idioma, tr } from '../core/idioma.ts';
import { barraSinColor, duracion, negrita, relleno, tenue, tokens } from './barras.ts';

/** Una cuenta lista para dibujar. Los proyectos ya vienen redactados si hacía falta. */
export interface CuentaDesglose {
  /** Cambia cómo se dicen los consejos: los comandos de Codex no son los de Claude Code. */
  readonly producto: 'claude' | 'codex';
  readonly nombre: string;
  readonly directorio: string;
  readonly desglose: Desglose;
  /** false si la cuenta no informa escrituras de cache: no hay reconstrucciones que medir. */
  readonly informaEscrituras: boolean;
  /** false si la cuenta no separa subagentes: todo es hilo principal. */
  readonly separaSubagentes: boolean;
  readonly archivos: number;
  readonly ms: number;
}

function nombreClase(c: Clase): string {
  const es = idioma() === 'es';
  switch (c) {
    case 'lecturaCache':
      return es ? 'lectura de cache' : 'cache read';
    case 'escrituraCache1h':
      return es ? 'escritura 1h' : 'write 1h';
    case 'escrituraCache5m':
      return es ? 'escritura 5m' : 'write 5m';
    case 'salida':
      return es ? 'salida' : 'output';
    case 'entrada':
      return es ? 'entrada' : 'input';
  }
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// En inglés el mes va con nombre: «20/10» se lee al revés en la mitad del mundo.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0,679 → «67,9%» («67.9%» en inglés). Con un decimal: las partes chicas son justo las que se comparan. */
export function pct(x: number): string {
  const n = (x * 100).toFixed(1);
  return `${tr(n.replace('.', ','), n)}%`;
}

/** 7368 → «7.368» («7,368» en inglés). */
function entero(n: number): string {
  return Math.round(n).toLocaleString(idioma() === 'es' ? 'es-AR' : 'en-US');
}

/** `2026-10-20` → «lun 20/10» («Mon Oct 20» en inglés). */
function dia(clave: string): string {
  const [a, m, d] = clave.split('-').map(Number);
  const f = new Date(a!, m! - 1, d!);
  if (idioma() === 'en') return `${DAYS[f.getDay()]} ${MONTHS[m! - 1]} ${String(d).padStart(2, '0')}`;
  return `${DIAS[f.getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** «lun 20/10 14:05»; en inglés «Oct 20 14:05», sin el día para que entre en la misma columna. */
function fecha(ms: number): string {
  const f = new Date(ms);
  const dos = (n: number): string => String(n).padStart(2, '0');
  const hora = `${dos(f.getHours())}:${dos(f.getMinutes())}`;
  if (idioma() === 'en') return `${MONTHS[f.getMonth()]} ${dos(f.getDate())} ${hora}`;
  return `${DIAS[f.getDay()]} ${dos(f.getDate())}/${dos(f.getMonth() + 1)} ${hora}`;
}

const medidor = (parte: number): string => barraSinColor(parte, 15);

function fila(etiqueta: string, p: Porcion, cola: string): string {
  return `      ${relleno(etiqueta, 19)}${medidor(p.parte)} ${pct(p.parte).padStart(6)}   ${cola}`;
}

/** El encabezado del informe: la ventana y por qué los pesos no son la cuota. */
export function encabezadoDesglose(dias: number, desde: number, nota: string, pesos: string): string[] {
  return [
    '',
    negrita(tr(`qm · desglose de ${dias}d · desde ${fecha(desde)}`, `qm · breakdown over ${dias}d · since ${fecha(desde)}`)),
    '',
    `  ${tenue(`${tr('pesos', 'weights')}: ${pesos}`)}`,
    ...partir(nota, 76).map((l) => `  ${tenue(l)}`),
    '',
  ];
}

/** Corta un párrafo en renglones de a lo sumo `ancho` columnas, por palabra. */
function partir(texto: string, ancho: number): string[] {
  const salida: string[] = [];
  let actual = '';
  for (const palabra of texto.split(/\s+/)) {
    if (actual !== '' && actual.length + 1 + palabra.length > ancho) {
      salida.push(actual);
      actual = palabra;
    } else actual = actual === '' ? palabra : `${actual} ${palabra}`;
  }
  if (actual !== '') salida.push(actual);
  return salida;
}

/**
 * Un consejo en una frase, con su número adentro. Los comandos dependen del
 * producto: `/clear` no existe en Codex, que empieza de cero con `/new`.
 */
export function fraseConsejo(c: Consejo, producto: 'claude' | 'codex'): string {
  const deCero = producto === 'codex' ? '/new' : '/clear';
  switch (c.clave) {
    case 'contexto-grande':
      return tr(
        `El ${pct(c.parte)} del costo salió de prompts de 400k o más (${pct(c.parteRequests)} de los requests). ` +
          `Cada turno relee el contexto entero: /compact o ${deCero} antes de llegar ahí abarata todos los requests que siguen.`,
        `${pct(c.parte)} of the cost came from prompts of 400k or more (${pct(c.parteRequests)} of the requests). ` +
          `Every turn rereads the whole context: /compact or ${deCero} before you get there makes every request after it cheaper.`,
      );
    case 'pausas': {
      const cifras = tr(
        `El ${pct(c.parte)} del costo fue volver a escribir el cache después de una pausa ` +
          `(hilo principal ${pct(c.principal)}, subagentes ${pct(c.subagentes)}; más de una hora: ${pct(c.masDeUnaHora)}).`,
        `${pct(c.parte)} of the cost was writing the cache again after a pause ` +
          `(main thread ${pct(c.principal)}, subagents ${pct(c.subagentes)}; over an hour: ${pct(c.masDeUnaHora)}).`,
      );
      // El remedio depende de dónde pasa: en el hilo principal la pausa es
      // tuya; en un subagente, el hueco entre dos requests es lo que tardó una
      // herramienta o lo que pasó hasta que se lo retomó.
      return c.principal >= c.subagentes
        ? `${cifras} ` +
            tr(
              'Retomar una conversación larga con el cache vencido la vuelve a escribir entera: ' +
                `después de una pausa de más de una hora, ${deCero} con un resumen corto sale más barato que seguir.`,
              'Resuming a long conversation with an expired cache writes all of it again: ' +
                `after a pause of more than an hour, ${deCero} with a short summary is cheaper than carrying on.`,
            )
        : `${cifras} ` +
            tr(
              'En un subagente, el hueco entre dos requests es lo que tardó una herramienta o lo que pasó ' +
                'hasta que se lo retomó: si supera lo que dura el cache, el subagente lo vuelve a escribir entero.',
              'In a subagent, the gap between two requests is how long a tool took or how long it waited to be ' +
                'resumed: if it outlasts the cache, the subagent writes all of it again.',
            );
    }
    case 'subagente-caro':
      return tr(
        `${c.agente} se llevó el ${pct(c.parte)} del costo en ${entero(c.requests)} requests, a ${tokens(Math.round(c.porRequest))} ` +
          `por request: casi lo mismo que el hilo principal (${tokens(Math.round(c.porRequestPrincipal))}).` +
          (c.agente === 'fork' ? ' Un fork arrastra la conversación entera.' : '') +
          ` Para las tareas que no necesitan la conversación, ${c.alternativa.agente} sale ` +
          `${tokens(Math.round(c.alternativa.porRequest))} por request.`,
        `${c.agente} took ${pct(c.parte)} of the cost in ${entero(c.requests)} requests, at ${tokens(Math.round(c.porRequest))} ` +
          `per request: almost the same as the main thread (${tokens(Math.round(c.porRequestPrincipal))}).` +
          (c.agente === 'fork' ? ' A fork carries the whole conversation.' : '') +
          ` For tasks that don't need the conversation, ${c.alternativa.agente} costs ` +
          `${tokens(Math.round(c.alternativa.porRequest))} per request.`,
      );
    case 'sesiones': {
      const s = c.masCara;
      const quien =
        c.cuantas === 1
          ? tr('Una sesión se llevó', 'One session took')
          : tr(`Las ${c.cuantas} sesiones más caras se llevaron`, `The ${c.cuantas} most expensive sessions took`);
      const datos = [
        s.proyecto ?? tr('(sin directorio)', '(no directory)'),
        s.inicio !== null && s.fin !== null ? duracion(s.fin - s.inicio) : null,
        tr(`${s.compactaciones} compactaciones`, `${s.compactaciones} compactions`),
        s.contextoMediana !== null
          ? tr(`contexto mediano ${tokens(Math.round(s.contextoMediana))}`, `median context ${tokens(Math.round(s.contextoMediana))}`)
          : null,
      ].filter((x) => x !== null);
      const remedio =
        s.contextoMediana !== null && s.contextoMediana >= 200_000
          ? tr(
              ` Cada turno de esa sesión relee unos ${tokens(Math.round(s.contextoMediana))}: cortarla en conversaciones ` +
                'más cortas baja el piso de cada request.',
              ` Every turn of that session rereads about ${tokens(Math.round(s.contextoMediana))}: splitting it into ` +
                'shorter conversations lowers the floor of every request.',
            )
          : tr(' Es por donde empezar a mirar.', " That's where to start looking.");
      return tr(
        `${quien} el ${pct(c.parte)} del costo. La primera (${pct(s.parte)}): ${datos.join(', ')}.${remedio}`,
        `${quien} ${pct(c.parte)} of the cost. The first one (${pct(s.parte)}): ${datos.join(', ')}.${remedio}`,
      );
    }
    case 'salida':
      return tr(
        `El ${pct(c.parte)} del costo fue salida, que pesa cinco veces la entrada e incluye el razonamiento: ` +
          'bajar el esfuerzo en las tareas mecánicas es lo que más la achica.',
        `${pct(c.parte)} of the cost was output, which weighs five times as much as input and includes reasoning: ` +
          'lowering the effort on mechanical tasks is what shrinks it most.',
      );
  }
}

/** Una cuenta entera. */
export function lineasCuenta(c: CuentaDesglose, maxSesiones = 5, maxProyectos = 5): string[] {
  const d = c.desglose;
  const l: string[] = [];
  l.push(`  ${negrita(c.nombre)} ${tenue(`· ${c.directorio}`)}`);
  if (d.requests === 0) {
    // Silencio es el bug: una cuenta sin nada que desglosar lo dice.
    l.push(
      `    ${tenue(
        tr(
          `sin requests en la ventana · ${entero(c.archivos)} transcripciones abiertas`,
          `no requests in the window · ${entero(c.archivos)} transcripts opened`,
        ),
      )}`,
      '',
    );
    return l;
  }
  l.push(
    `    ${entero(d.requests)} requests · ${tokens(Math.round(d.costo))} ${tr('de costo ponderado', 'of weighted cost')} ` +
      tenue(tr('(tokens de entrada equivalentes)', '(equivalent input tokens)')),
  );

  // Arriba de todo, porque es lo único del informe que se usa: el resto es la
  // evidencia. Sin nada que pase un umbral, el bloque no aparece.
  const aHacer = consejos(d);
  if (aHacer.length > 0) {
    l.push(
      '',
      `    ${negrita(tr('qué hacer', 'what to do'))} ` +
        tenue(tr('· partes del costo ponderado: aproximan la cuota, no la miden', "· shares of the weighted cost: they approximate the quota, they don't measure it")),
    );
    for (const k of aHacer) {
      const [primera = '', ...resto] = partir(fraseConsejo(k, c.producto), 72);
      l.push(`      · ${primera}`);
      for (const r of resto) l.push(`        ${r}`);
    }
  }

  l.push('', `    ${negrita(tr('por clase de token', 'by token class'))}`);
  for (const k of d.porClase) {
    // Una cuenta que no informa escrituras no escribió cero: no lo dice. Una
    // fila en 0,0 % afirmaría lo primero.
    if (!c.informaEscrituras && (k.clase === 'escrituraCache5m' || k.clase === 'escrituraCache1h')) continue;
    l.push(fila(nombreClase(k.clase), { requests: 0, costo: k.costo, parte: k.parte }, tenue(`${tokens(k.tokens)} tokens`)));
  }

  l.push('', `    ${negrita(tr('por tamaño del prompt', 'by prompt size'))} ${tenue(tr('(entrada + cache escrito + cache leído)', '(input + cache written + cache read)'))}`);
  for (const t of d.porContexto) l.push(fila(t.tramo, t, tenue(`${entero(t.requests).padStart(6)} requests`)));
  const grande = d.contextoGrande;
  l.push(
    tr(
      `      ${tenue('400k o más:')} ${pct(grande.parte)} del costo en ${entero(grande.requests)} requests ` +
        tenue(`(${pct(grande.parteRequests)} de los requests)`),
      `      ${tenue('400k or more:')} ${pct(grande.parte)} of the cost in ${entero(grande.requests)} requests ` +
        tenue(`(${pct(grande.parteRequests)} of the requests)`),
    ),
  );

  l.push(
    '',
    `    ${negrita(tr('cache reconstruido', 'cache rebuilt'))} ` +
      tenue(tr('· más de 20k escritos en un request que no es el primero de su hilo', "· over 20k written in a request that isn't the first of its thread")),
  );
  if (!c.informaEscrituras) {
    l.push(`      ${tenue(tr('no aplica: esta cuenta no informa escrituras de cache', "doesn't apply: this account doesn't report cache writes"))}`);
  } else {
    l.push(`      ${relleno('', 19)}${tenue(relleno(tr('hilo principal', 'main thread'), 22))}${tenue(tr('subagentes', 'subagents'))}`);
    for (const h of HUECOS) {
      const celda = (hilo: 'principal' | 'subagente'): string => {
        const r = d.reconstrucciones.find((x) => x.hueco === h && x.hilo === hilo)!;
        return `${entero(r.requests).padStart(5)} · ${pct(r.parte).padStart(6)}`;
      };
      // `sin hueco` es la clave del dato, no texto: se traduce acá, al dibujarla.
      const etiqueta = h === 'sin hueco' ? tr('sin hueco (≤5m)', 'no gap (≤5m)') : tr(`hueco ${h}`, `gap ${h}`);
      l.push(`      ${relleno(etiqueta, 19)}${relleno(celda('principal'), 22)}${celda('subagente')}`);
    }
    const t = d.reconstruccionesTotal;
    l.push(
      tr(
        `      ${tenue('en total:')} ${entero(t.requests)} requests, ${pct(t.parte)} del costo ${tenue('(sólo la escritura)')}`,
        `      ${tenue('in total:')} ${entero(t.requests)} requests, ${pct(t.parte)} of the cost ${tenue('(the write alone)')}`,
      ),
    );
  }

  l.push(
    '',
    `    ${negrita(tr('subagentes', 'subagents'))}` +
      (c.separaSubagentes ? ` · ${pct(d.subagentes.parte)} ${tr('del costo', 'of the cost')}` : ''),
  );
  if (!c.separaSubagentes) {
    l.push(`      ${tenue(tr('no aplica: esta cuenta no separa subagentes', "doesn't apply: this account doesn't separate subagents"))}`);
  } else {
    for (const a of d.porAgente) {
      l.push(fila(a.agente ?? tr('hilo principal', 'main thread'), a, tenue(`${entero(a.requests).padStart(6)} requests`)));
    }
  }

  l.push('', `    ${negrita(tr('por día', 'by day'))}`);
  for (const x of d.porDia) l.push(fila(dia(x.dia), x, tenue(`${entero(x.requests).padStart(6)} requests`)));

  l.push('', `    ${negrita(tr('proyectos', 'projects'))}`);
  for (const p of d.proyectos.slice(0, maxProyectos)) {
    l.push(`      ${pct(p.parte).padStart(6)}  ${p.proyecto ?? tenue(tr('(sin directorio)', '(no directory)'))}`);
  }

  l.push('', `    ${negrita(tr('sesiones más caras', 'most expensive sessions'))}`);
  l.push(
    tenue(
      `      ${tr('costo', 'cost').padStart(6)} ${'subag.'.padStart(7)} ${'req'.padStart(5)} ${tr('máx', 'max').padStart(6)} ` +
        `${tr('mediana', 'median').padStart(7)} ${'compact'.padStart(7)} ${tr('duración', 'duration').padStart(8)}  ` +
        `${relleno(tr('inicio', 'start'), 15)} ${tr('proyecto', 'project')}`,
    ),
  );
  for (const s of d.sesiones.slice(0, maxSesiones)) {
    const k = (n: number | null): string => (n === null ? '—' : tokens(Math.round(n)));
    l.push(
      `      ${pct(s.parte).padStart(6)} ${(s.parteSubagentes > 0 ? pct(s.parteSubagentes) : '—').padStart(7)} ${entero(s.requests).padStart(5)} ` +
        `${k(s.contextoMax).padStart(6)} ${k(s.contextoMediana).padStart(7)} ${String(s.compactaciones).padStart(7)} ` +
        `${(s.inicio !== null && s.fin !== null ? duracion(s.fin - s.inicio) : '—').padStart(8)}  ` +
        `${relleno(s.inicio === null ? '—' : fecha(s.inicio), 15)} ${s.proyecto ?? tenue(tr('(sin directorio)', '(no directory)'))}`,
    );
  }
  const segundos = (c.ms / 1000).toFixed(1);
  l.push(
    '',
    `    ${tenue(
      tr(
        `${entero(c.archivos)} transcripciones leídas en ${segundos.replace('.', ',')} s`,
        `${entero(c.archivos)} transcripts read in ${segundos} s`,
      ),
    )}`,
    '',
  );
  return l;
}
