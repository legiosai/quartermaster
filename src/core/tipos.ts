// Los tipos que cruzan la frontera entre adaptadores y núcleo. Un adaptador
// puede saber de llaveros, de JSONL o de HTTP; el núcleo sólo sabe de esto.

/** Un perfil de Claude Code: un directorio de configuración y la cuenta que vive adentro. */
export interface Perfil {
  /** Ruta absoluta del directorio de configuración (lo que CLAUDE_CONFIG_DIR apunta). */
  readonly directorio: string;
  /** Nombre corto para mostrar: el basename del directorio. */
  readonly nombre: string;
  /** true si es el directorio por defecto (~/.claude), el único sin sufijo en el llavero. */
  readonly porDefecto: boolean;
  /** Cuenta leída de .claude.json. null si el perfil nunca se logueó. */
  readonly cuenta: Cuenta | null;
}

export interface Cuenta {
  readonly email: string | null;
  readonly organizacion: string | null;
  /** team_tier_1, max, pro… tal cual lo reporta .claude.json. */
  readonly plan: string | null;
}

/** Lo que sabemos de una credencial SIN mirar el secreto. */
export interface EstadoCredencial {
  readonly presente: boolean;
  /** Dónde vive: el servicio del llavero en macOS, la ruta del archivo en el resto. */
  readonly ubicacion: string;
  readonly expiraEn: Date | null;
  readonly vencida: boolean;
  /** Por qué no se pudo leer, si no se pudo. Nunca contiene el secreto. */
  readonly error: string | null;
}

/** Consumo agregado de transcripciones locales. No sabe de límites ni de cuotas. */
export interface Consumo {
  readonly entrada: number;
  readonly creacionCache: number;
  readonly lecturaCache: number;
  readonly salida: number;
  readonly pensamiento: number;
  /** Cuántos requests distintos se contaron (deduplicados por requestId). */
  readonly requests: number;
  readonly porModelo: ReadonlyMap<string, number>;
  readonly primero: Date | null;
  readonly ultimo: Date | null;
}

export const CONSUMO_VACIO: Consumo = {
  entrada: 0,
  creacionCache: 0,
  lecturaCache: 0,
  salida: 0,
  pensamiento: 0,
  requests: 0,
  porModelo: new Map(),
  primero: null,
  ultimo: null,
};

/** Total de tokens facturables en el sentido más simple: todo lo que entró y salió. */
export function totalTokens(c: Consumo): number {
  return c.entrada + c.creacionCache + c.lecturaCache + c.salida;
}

// ─── Cuota ────────────────────────────────────────────────────────────────
// Lo que las transcripciones NO pueden decir: cuál es el límite y cuándo se
// reinicia la ventana.

/** De dónde salió el número. Cambia lo que se puede afirmar de él. */
export type OrigenCuota =
  /** Se pidió al endpoint recién: el número es de ahora. */
  | 'endpoint'
  /** Lo dejó Claude Code en .claude.json. No cuesta nada y puede estar viejo. */
  | 'cache';

/**
 * Una barra de límite. El servidor manda varias y NO son sólo las dos obvias:
 * en la cuenta donde se escribió esto, `five_hour` daba 8 % y `seven_day` 59 %
 * mientras la barra que de verdad mandaba era un `weekly_scoped` de un modelo
 * puntual, al 75 % y con severidad `warning`. Mostrar sólo las dos conocidas
 * es enseñar un número cómodo y esconder el que te va a frenar.
 */
export interface VentanaCuota {
  /** Clave del servidor: session, weekly_all, weekly_scoped, five_hour, seven_day… */
  readonly clave: string;
  /** 0..100. */
  readonly porcentaje: number;
  readonly reinicia: Date | null;
  /** Tal cual la manda el servidor: normal, warning… No se normaliza para no perder valores nuevos. */
  readonly severidad: string;
  /** El servidor la marca como la que rige ahora mismo. */
  readonly activa: boolean;
  /** A qué aplica, cuando no es a todo: el nombre del modelo, por ejemplo. */
  readonly alcance: string | null;
  /** session | weekly, cuando viene. Sirve para no repetir la misma barra dos veces. */
  readonly grupo: string | null;
}

/**
 * El resultado de pedir la cuota. Es una unión, no un objeto con campos
 * opcionales, porque cada estado que no produce número TIENE que producir una
 * frase: un monitor mudo es el bug que originó esta herramienta.
 */
export type ResultadoCuota =
  | {
      readonly estado: 'ok';
      readonly origen: OrigenCuota;
      /** Cuándo se midió de verdad. Para el cache no es "ahora". */
      readonly medidoEn: Date;
      readonly ventanas: readonly VentanaCuota[];
    }
  | { readonly estado: 'sin-credencial' }
  | { readonly estado: 'vencida' }
  | { readonly estado: 'sin-cache' }
  | { readonly estado: 'sin-suscripcion' }
  | { readonly estado: 'no-consultada' }
  | { readonly estado: 'ilegible'; readonly detalle: string }
  | { readonly estado: 'error'; readonly detalle: string };

/** Una barra preocupa si el servidor lo dice, o si está por encima del 80 %. */
export function esPreocupante(v: VentanaCuota): boolean {
  return v.severidad !== 'normal' || v.porcentaje >= 80;
}

/**
 * La barra que hay que mirar: la que el servidor marca activa gana; si no, la
 * más alta. Es lo único que evita que un 75 % con aviso quede tapado por un
 * 8 % que se ve más lindo.
 */
export function peor(ventanas: readonly VentanaCuota[]): VentanaCuota | null {
  if (ventanas.length === 0) return null;
  const orden = [...ventanas].sort((a, b) => {
    if (a.activa !== b.activa) return a.activa ? -1 : 1;
    return b.porcentaje - a.porcentaje;
  });
  const activa = orden[0]!;
  const masAlta = [...ventanas].sort((a, b) => b.porcentaje - a.porcentaje)[0]!;
  // Si hay una más alta que la activa, esa es la que te frena antes.
  return masAlta.porcentaje > activa.porcentaje ? masAlta : activa;
}

/**
 * Las que vale la pena mostrar. El servidor manda barras que no aplican a la
 * cuenta (nombres internos, en 0 % y sin severidad); listarlas llena la tabla
 * de ruido y hace que las tres que importan se lean peor.
 */
export function paraMostrar(ventanas: readonly VentanaCuota[]): VentanaCuota[] {
  return ventanas.filter((v) => v.activa || v.porcentaje > 0 || v.severidad !== 'normal');
}

/** Nombre legible de una ventana, con su alcance si lo tiene. */
export function nombreVentana(v: VentanaCuota): string {
  return v.alcance === null ? v.clave : `${v.clave} (${v.alcance})`;
}

/** La frase que se le muestra al usuario para cada estado. Nunca vacía. */
export function frase(r: ResultadoCuota, perfil: string): string {
  switch (r.estado) {
    case 'ok':
      return `${r.ventanas.length} ventana(s) de cuota`;
    case 'sin-credencial':
      return `sin credencial — corré: CLAUDE_CONFIG_DIR=${perfil} claude auth login`;
    case 'vencida':
      return `credencial vencida — corré: CLAUDE_CONFIG_DIR=${perfil} claude auth login`;
    case 'sin-cache':
      return 'Claude Code todavía no dejó cuota en .claude.json para este perfil (usalo una vez)';
    case 'no-consultada':
      return 'no se consultó el endpoint (--sin-red)';
    case 'sin-suscripcion':
      return 'la cuenta no tiene límites de suscripción que reportar (API key o enterprise)';
    case 'ilegible':
      return `no sé leer lo que vino: ${r.detalle}`;
    case 'error':
      return `no se pudo consultar la cuota: ${r.detalle}`;
  }
}
