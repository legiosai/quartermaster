// `qm --desglose`: en qué se fue la cuota de la última semana.
//
// Es la otra mitad de `qm`. La pantalla de siempre dice cuánto queda y a qué
// ritmo; ésta dice qué lo consumió —qué clase de token, qué tamaño de prompt,
// qué reconstrucciones de cache, qué subagentes, qué sesiones—, que es lo que
// hace falta saber para gastar menos la semana que viene.
//
// Lee sólo el disco, igual que el piso de `qm`: no consulta ningún endpoint,
// no abre credenciales y no escribe nada. Corre una vez por semana a mano, así
// que puede tardar segundos; lo que no puede es tardar minutos, y por eso la
// lectura filtra los bytes antes de decodificar (ver `adapters/lineas.ts`).

import { homedir } from 'node:os';
import { sep } from 'node:path';
import { usosDesde } from '../adapters/transcripciones.ts';
import { DIRECTORIO_CODEX, hayCodex, usosCodex } from '../adapters/codex.ts';
import { RUTA_CONFIG, seleccionar, type Config } from '../core/config.ts';
import {
  CONTEXTO_GRANDE,
  PESOS,
  RECONSTRUCCION_MIN,
  desglosar,
  type Desglose,
  type Porcion,
  type Registros,
} from '../core/desglose.ts';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { encabezadoDesglose, lineasCuenta, type CuentaDesglose } from '../render/desglose.ts';
import { tenue } from '../render/barras.ts';

/**
 * Lo que hay que decir siempre al lado de los números. Los pesos son precios
 * de la API, y una suscripción no se factura por API: si se los presenta
 * pelados, «68 % lectura de cache» se lee como «68 % de tu cuota», que es una
 * afirmación que nadie puede hacer con lo que hay publicado.
 */
export const NOTA_PESOS =
  'Los pesos son el precio relativo de cada clase de token en la API, y se usan como aproximación de cuánto ' +
  'drena la cuota: Anthropic no publica cómo pondera la suscripción (OpenAI tampoco, para Codex). Sirven ' +
  'para ver en qué se va, no para medir cuánto queda.';

const PESOS_TEXTO =
  'lectura de cache 0,1 · escritura de cache 5m 1,25 · escritura 1h 2 · entrada 1 · salida 5';

export interface OpcionesDesglose {
  readonly dias: number;
  readonly json: boolean;
  readonly redactado: boolean;
  readonly codex: boolean;
  readonly version: string;
}

interface Fuente {
  readonly producto: 'claude' | 'codex';
  readonly perfil: { readonly nombre: string; readonly directorio: string };
  readonly leer: (desde: Date) => Registros;
  readonly informaEscrituras: boolean;
  readonly separaSubagentes: boolean;
}

interface Medida extends CuentaDesglose {
  readonly producto: 'claude' | 'codex';
  /** La ruta completa del perfil, para el JSON sin redactar. */
  readonly ruta: string;
}

/** Todas las cuentas que tienen transcripciones con usage por request. */
function fuentes(o: OpcionesDesglose): Fuente[] {
  const salida: Fuente[] = descubrirPerfiles().map((perfil) => ({
    producto: 'claude' as const,
    perfil,
    leer: (desde: Date) => usosDesde(perfil, desde),
    informaEscrituras: true,
    separaSubagentes: true,
  }));
  // Codex entra porque sus rollouts traen el uso de cada request. opencode y
  // Antigravity no: guardan el total por mensaje o por conversación, sin el
  // desglose de cache que este informe necesita para decir algo.
  if (o.codex && hayCodex()) {
    salida.push({
      producto: 'codex',
      perfil: { nombre: 'codex', directorio: DIRECTORIO_CODEX },
      leer: usosCodex,
      informaEscrituras: false,
      separaSubagentes: false,
    });
  }
  return salida;
}

/**
 * Cómo se muestra un directorio de proyecto.
 *
 * Sin `--redactado`, la ruta con la casa como `~`. Con `--redactado`, un número
 * de orden —`proyecto 1`, `proyecto 2`— asignado por costo: el nombre de un
 * directorio ya dice para quién trabajás, y este informe es justo lo que uno
 * pega en un issue para preguntar por qué se le fue la cuota.
 */
/** La casa como `~`. Sólo en el borde de un directorio: `/home/ana` no es la casa de `/home/anabel`. */
function conTilde(p: string): string {
  const casa = homedir();
  return p === casa || p.startsWith(casa + sep) ? `~${p.slice(casa.length)}` : p;
}

function etiquetador(redactado: boolean): (p: string | null) => string | null {
  const numeros = new Map<string, number>();
  return (p) => {
    if (p === null) return null;
    if (!redactado) return conTilde(p);
    let n = numeros.get(p);
    if (n === undefined) {
      n = numeros.size + 1;
      numeros.set(p, n);
    }
    return `proyecto ${n}`;
  };
}

function conEtiquetas(d: Desglose, etiqueta: (p: string | null) => string | null): Desglose {
  // Primero los proyectos, que vienen por costo: así `proyecto 1` es el más caro.
  const proyectos = d.proyectos.map((p) => ({ ...p, proyecto: etiqueta(p.proyecto) }));
  const sesiones = d.sesiones.map((s) => ({ ...s, proyecto: etiqueta(s.proyecto) }));
  return { ...d, proyectos, sesiones };
}

export function medirDesglose(o: OpcionesDesglose, cfg: Config): { cuentas: Medida[]; nota: string | null; desde: Date } {
  const desde = new Date(Date.now() - o.dias * 24 * 3600_000);
  const { filas, nota } = seleccionar(fuentes(o), cfg);
  const etiqueta = etiquetador(o.redactado);
  const cuentas = filas.map((f): Medida => {
    const t0 = performance.now();
    const registros = f.leer(desde);
    const desglose = desglosar(registros);
    const ms = performance.now() - t0;
    return {
      producto: f.producto,
      nombre: f.perfil.nombre,
      ruta: f.perfil.directorio,
      directorio: conTilde(f.perfil.directorio),
      desglose: conEtiquetas(desglose, etiqueta),
      informaEscrituras: f.informaEscrituras,
      separaSubagentes: f.separaSubagentes,
      archivos: registros.archivos,
      ms,
    };
  });
  return { cuentas, nota, desde };
}

// ─── JSON ─────────────────────────────────────────────────────────────────

const cuatro = (x: number): number => Number(x.toFixed(4));
const porcionJson = (p: Porcion): Record<string, number> => ({
  requests: p.requests,
  costo: Math.round(p.costo),
  parte: cuatro(p.parte),
});
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function desgloseJson(
  r: { cuentas: Medida[]; desde: Date },
  o: OpcionesDesglose,
): Record<string, unknown> {
  return {
    // Un contrato aparte del de `qm --json`, con su propio número: lo que se
    // documenta en docs/esquema-json.md para uno no vale para el otro.
    esquema: 1,
    informe: 'desglose',
    version: o.version,
    generado: new Date().toISOString(),
    ventanaDias: o.dias,
    desde: r.desde.toISOString(),
    pesos: PESOS,
    nota: NOTA_PESOS,
    umbrales: { reconstruccion: RECONSTRUCCION_MIN, contextoGrande: CONTEXTO_GRANDE },
    perfiles: r.cuentas.map((c) => {
      const d = c.desglose;
      return {
        producto: c.producto,
        perfil: c.nombre,
        directorio: o.redactado ? c.directorio : c.ruta,
        informaEscrituras: c.informaEscrituras,
        separaSubagentes: c.separaSubagentes,
        lectura: { archivos: c.archivos, ms: Math.round(c.ms) },
        requests: d.requests,
        costo: Math.round(d.costo),
        porClase: d.porClase.map((k) => ({ clase: k.clase, tokens: k.tokens, costo: Math.round(k.costo), parte: cuatro(k.parte) })),
        porContexto: d.porContexto.map((t) => ({ tramo: t.tramo, desde: t.desde, hasta: t.hasta, ...porcionJson(t) })),
        contextoGrande: { desde: CONTEXTO_GRANDE, ...porcionJson(d.contextoGrande), parteRequests: cuatro(d.contextoGrande.parteRequests) },
        reconstrucciones: d.reconstrucciones.map((x) => ({ hueco: x.hueco, hilo: x.hilo, ...porcionJson(x) })),
        reconstruccionesTotal: porcionJson(d.reconstruccionesTotal),
        porAgente: d.porAgente.map((a) => ({ agente: a.agente, ...porcionJson(a) })),
        subagentes: porcionJson(d.subagentes),
        porDia: d.porDia.map((x) => ({ dia: x.dia, ...porcionJson(x) })),
        proyectos: d.proyectos.map((p) => ({ proyecto: p.proyecto, ...porcionJson(p) })),
        sesiones: d.sesiones.map((s) => ({
          // El id de la sesión es lo que pide `claude --resume`; redactado no
          // sale, porque junto con el directorio identifica una conversación.
          sesion: o.redactado ? null : s.sesion,
          proyecto: s.proyecto,
          requests: s.requests,
          inicio: iso(s.inicio),
          fin: iso(s.fin),
          duracionMin: s.inicio === null || s.fin === null ? null : Math.round((s.fin - s.inicio) / 60_000),
          contextoMax: s.contextoMax,
          contextoMediana: s.contextoMediana === null ? null : Math.round(s.contextoMediana),
          compactaciones: s.compactaciones,
          costo: Math.round(s.costo),
          costoSubagentes: Math.round(s.costoSubagentes),
          parte: cuatro(s.parte),
          parteSubagentes: cuatro(s.parteSubagentes),
        })),
      };
    }),
  };
}

// ─── el comando ───────────────────────────────────────────────────────────

export function correrDesglose(o: OpcionesDesglose, cfg: Config): number {
  const r = medirDesglose(o, cfg);
  if (o.json) {
    console.log(JSON.stringify(desgloseJson(r, o), null, 2));
    return 0;
  }
  // Igual que en `qm`: la nota de la selección va a stderr, para que no
  // ensucie una salida que alguien redirige a un archivo cada semana.
  if (r.nota !== null) console.error(tenue(`  (${r.nota} · ${RUTA_CONFIG})`));
  const l = encabezadoDesglose(o.dias, r.desde.getTime(), NOTA_PESOS, PESOS_TEXTO);
  if (r.cuentas.length === 0) {
    l.push('  No se encontró ninguna cuenta con transcripciones en esta máquina.', '');
  }
  for (const c of r.cuentas) l.push(...lineasCuenta(c));
  console.log(l.join('\n'));
  return 0;
}
