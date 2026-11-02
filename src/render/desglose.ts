// El desglose, en texto. Sólo dibuja: cada número llega calculado desde
// `core/desglose.ts`, y lo único que se decide acá es cómo se ve.

import { HUECOS, consejos, type Clase, type Consejo, type Desglose, type Porcion } from '../core/desglose.ts';
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

const NOMBRE_CLASE: Record<Clase, string> = {
  lecturaCache: 'lectura de cache',
  escrituraCache1h: 'escritura 1h',
  escrituraCache5m: 'escritura 5m',
  salida: 'salida',
  entrada: 'entrada',
};

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** 0,679 → «67,9%». Con un decimal: las partes chicas son justo las que se comparan. */
export function pct(x: number): string {
  return `${(x * 100).toFixed(1).replace('.', ',')}%`;
}

/** 7368 → «7.368». */
function entero(n: number): string {
  return Math.round(n).toLocaleString('es-AR');
}

/** `2026-10-20` → «lun 20/10». */
function dia(clave: string): string {
  const [a, m, d] = clave.split('-').map(Number);
  const f = new Date(a!, m! - 1, d!);
  return `${DIAS[f.getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

function fecha(ms: number): string {
  const f = new Date(ms);
  const dos = (n: number): string => String(n).padStart(2, '0');
  return `${DIAS[f.getDay()]} ${dos(f.getDate())}/${dos(f.getMonth() + 1)} ${dos(f.getHours())}:${dos(f.getMinutes())}`;
}

const medidor = (parte: number): string => barraSinColor(parte, 15);

function fila(etiqueta: string, p: Porcion, cola: string): string {
  return `      ${relleno(etiqueta, 19)}${medidor(p.parte)} ${pct(p.parte).padStart(6)}   ${cola}`;
}

/** El encabezado del informe: la ventana y por qué los pesos no son la cuota. */
export function encabezadoDesglose(dias: number, desde: number, nota: string, pesos: string): string[] {
  return [
    '',
    negrita(`qm · desglose de ${dias}d · desde ${fecha(desde)}`),
    '',
    `  ${tenue(`pesos: ${pesos}`)}`,
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
      return (
        `El ${pct(c.parte)} del costo salió de prompts de 400k o más (${pct(c.parteRequests)} de los requests). ` +
        `Cada turno relee el contexto entero: /compact o ${deCero} antes de llegar ahí abarata todos los requests que siguen.`
      );
    case 'pausas': {
      const cifras =
        `El ${pct(c.parte)} del costo fue volver a escribir el cache después de una pausa ` +
        `(hilo principal ${pct(c.principal)}, subagentes ${pct(c.subagentes)}; más de una hora: ${pct(c.masDeUnaHora)}).`;
      // El remedio depende de dónde pasa: en el hilo principal la pausa es
      // tuya; en un subagente, el hueco entre dos requests es lo que tardó una
      // herramienta o lo que pasó hasta que se lo retomó.
      return c.principal >= c.subagentes
        ? `${cifras} Retomar una conversación larga con el cache vencido la vuelve a escribir entera: ` +
            `después de una pausa de más de una hora, ${deCero} con un resumen corto sale más barato que seguir.`
        : `${cifras} En un subagente, el hueco entre dos requests es lo que tardó una herramienta o lo que pasó ` +
            `hasta que se lo retomó: si supera lo que dura el cache, el subagente lo vuelve a escribir entero.`;
    }
    case 'subagente-caro':
      return (
        `${c.agente} se llevó el ${pct(c.parte)} del costo en ${entero(c.requests)} requests, a ${tokens(Math.round(c.porRequest))} ` +
        `por request: casi lo mismo que el hilo principal (${tokens(Math.round(c.porRequestPrincipal))}).` +
        (c.agente === 'fork' ? ' Un fork arrastra la conversación entera.' : '') +
        ` Para las tareas que no necesitan la conversación, ${c.alternativa.agente} sale ` +
        `${tokens(Math.round(c.alternativa.porRequest))} por request.`
      );
    case 'sesiones': {
      const s = c.masCara;
      const quien = c.cuantas === 1 ? 'Una sesión se llevó' : `Las ${c.cuantas} sesiones más caras se llevaron`;
      const datos = [
        s.proyecto ?? '(sin directorio)',
        s.inicio !== null && s.fin !== null ? duracion(s.fin - s.inicio) : null,
        `${s.compactaciones} compactaciones`,
        s.contextoMediana !== null ? `contexto mediano ${tokens(Math.round(s.contextoMediana))}` : null,
      ].filter((x) => x !== null);
      const remedio =
        s.contextoMediana !== null && s.contextoMediana >= 200_000
          ? ` Cada turno de esa sesión relee unos ${tokens(Math.round(s.contextoMediana))}: cortarla en conversaciones ` +
            'más cortas baja el piso de cada request.'
          : ' Es por donde empezar a mirar.';
      return `${quien} el ${pct(c.parte)} del costo. La primera (${pct(s.parte)}): ${datos.join(', ')}.${remedio}`;
    }
    case 'salida':
      return (
        `El ${pct(c.parte)} del costo fue salida, que pesa cinco veces la entrada e incluye el razonamiento: ` +
        'bajar el esfuerzo en las tareas mecánicas es lo que más la achica.'
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
    l.push(`    ${tenue(`sin requests en la ventana · ${entero(c.archivos)} transcripciones abiertas`)}`, '');
    return l;
  }
  l.push(`    ${entero(d.requests)} requests · ${tokens(Math.round(d.costo))} de costo ponderado ${tenue('(tokens de entrada equivalentes)')}`);

  // Arriba de todo, porque es lo único del informe que se usa: el resto es la
  // evidencia. Sin nada que pase un umbral, el bloque no aparece.
  const aHacer = consejos(d);
  if (aHacer.length > 0) {
    l.push('', `    ${negrita('qué hacer')} ${tenue('· partes del costo ponderado: aproximan la cuota, no la miden')}`);
    for (const k of aHacer) {
      const [primera = '', ...resto] = partir(fraseConsejo(k, c.producto), 72);
      l.push(`      · ${primera}`);
      for (const r of resto) l.push(`        ${r}`);
    }
  }

  l.push('', `    ${negrita('por clase de token')}`);
  for (const k of d.porClase) {
    // Una cuenta que no informa escrituras no escribió cero: no lo dice. Una
    // fila en 0,0 % afirmaría lo primero.
    if (!c.informaEscrituras && (k.clase === 'escrituraCache5m' || k.clase === 'escrituraCache1h')) continue;
    l.push(fila(NOMBRE_CLASE[k.clase], { requests: 0, costo: k.costo, parte: k.parte }, tenue(`${tokens(k.tokens)} tokens`)));
  }

  l.push('', `    ${negrita('por tamaño del prompt')} ${tenue('(entrada + cache escrito + cache leído)')}`);
  for (const t of d.porContexto) l.push(fila(t.tramo, t, tenue(`${entero(t.requests).padStart(6)} requests`)));
  const grande = d.contextoGrande;
  l.push(
    `      ${tenue('400k o más:')} ${pct(grande.parte)} del costo en ${entero(grande.requests)} requests ` +
      tenue(`(${pct(grande.parteRequests)} de los requests)`),
  );

  l.push('', `    ${negrita('cache reconstruido')} ${tenue('· más de 20k escritos en un request que no es el primero de su hilo')}`);
  if (!c.informaEscrituras) {
    l.push(`      ${tenue('no aplica: esta cuenta no informa escrituras de cache')}`);
  } else {
    l.push(`      ${relleno('', 19)}${tenue(relleno('hilo principal', 22))}${tenue('subagentes')}`);
    for (const h of HUECOS) {
      const celda = (hilo: 'principal' | 'subagente'): string => {
        const r = d.reconstrucciones.find((x) => x.hueco === h && x.hilo === hilo)!;
        return `${entero(r.requests).padStart(5)} · ${pct(r.parte).padStart(6)}`;
      };
      l.push(`      ${relleno(h === 'sin hueco' ? 'sin hueco (≤5m)' : `hueco ${h}`, 19)}${relleno(celda('principal'), 22)}${celda('subagente')}`);
    }
    const t = d.reconstruccionesTotal;
    l.push(`      ${tenue('en total:')} ${entero(t.requests)} requests, ${pct(t.parte)} del costo ${tenue('(sólo la escritura)')}`);
  }

  l.push('', `    ${negrita('subagentes')}${c.separaSubagentes ? ` · ${pct(d.subagentes.parte)} del costo` : ''}`);
  if (!c.separaSubagentes) {
    l.push(`      ${tenue('no aplica: esta cuenta no separa subagentes')}`);
  } else {
    for (const a of d.porAgente) {
      l.push(fila(a.agente ?? 'hilo principal', a, tenue(`${entero(a.requests).padStart(6)} requests`)));
    }
  }

  l.push('', `    ${negrita('por día')}`);
  for (const x of d.porDia) l.push(fila(dia(x.dia), x, tenue(`${entero(x.requests).padStart(6)} requests`)));

  l.push('', `    ${negrita('proyectos')}`);
  for (const p of d.proyectos.slice(0, maxProyectos)) {
    l.push(`      ${pct(p.parte).padStart(6)}  ${p.proyecto ?? tenue('(sin directorio)')}`);
  }

  l.push('', `    ${negrita('sesiones más caras')}`);
  l.push(
    tenue(
      `      ${'costo'.padStart(6)} ${'subag.'.padStart(7)} ${'req'.padStart(5)} ${'máx'.padStart(6)} ` +
        `${'mediana'.padStart(7)} ${'compact'.padStart(7)} ${'duración'.padStart(8)}  ${relleno('inicio', 15)} proyecto`,
    ),
  );
  for (const s of d.sesiones.slice(0, maxSesiones)) {
    const k = (n: number | null): string => (n === null ? '—' : tokens(Math.round(n)));
    l.push(
      `      ${pct(s.parte).padStart(6)} ${(s.parteSubagentes > 0 ? pct(s.parteSubagentes) : '—').padStart(7)} ${entero(s.requests).padStart(5)} ` +
        `${k(s.contextoMax).padStart(6)} ${k(s.contextoMediana).padStart(7)} ${String(s.compactaciones).padStart(7)} ` +
        `${(s.inicio !== null && s.fin !== null ? duracion(s.fin - s.inicio) : '—').padStart(8)}  ` +
        `${relleno(s.inicio === null ? '—' : fecha(s.inicio), 15)} ${s.proyecto ?? tenue('(sin directorio)')}`,
    );
  }
  l.push('', `    ${tenue(`${entero(c.archivos)} transcripciones leídas en ${(c.ms / 1000).toFixed(1).replace('.', ',')} s`)}`, '');
  return l;
}
