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
// reinicia la ventana. Sólo el endpoint lo sabe.

/** Una ventana de límite: 5 horas, 7 días, o lo que el servidor mande. */
export interface VentanaCuota {
  /** Clave tal cual la manda el servidor: five_hour, seven_day, seven_day_opus… */
  readonly clave: string;
  /** 0..100. El servidor la manda como porcentaje, no como fracción. */
  readonly porcentaje: number;
  /** Cuándo se reinicia esta ventana. null si el servidor no lo mandó. */
  readonly reinicia: Date | null;
}

/**
 * El resultado de pedir la cuota. Es una unión, no un objeto con campos
 * opcionales, porque cada estado que no produce número TIENE que producir una
 * frase: un monitor mudo es el bug que originó esta herramienta.
 */
export type ResultadoCuota =
  | { readonly estado: 'ok'; readonly ventanas: readonly VentanaCuota[] }
  | { readonly estado: 'sin-credencial' }
  | { readonly estado: 'vencida' }
  | { readonly estado: 'sin-suscripcion' }
  | { readonly estado: 'no-consultada' }
  | { readonly estado: 'ilegible'; readonly detalle: string }
  | { readonly estado: 'error'; readonly detalle: string };

/** La frase que se le muestra al usuario para cada estado. Nunca vacía. */
export function frase(r: ResultadoCuota, perfil: string): string {
  switch (r.estado) {
    case 'ok':
      return `${r.ventanas.length} ventana(s) de cuota`;
    case 'sin-credencial':
      return `sin credencial — corré: CLAUDE_CONFIG_DIR=${perfil} claude auth login`;
    case 'vencida':
      return `credencial vencida — corré: CLAUDE_CONFIG_DIR=${perfil} claude auth login`;
    case 'no-consultada':
      return 'no se consultó el endpoint (--sin-red)';
    case 'sin-suscripcion':
      return 'la cuenta no tiene límites de suscripción que reportar (API key o enterprise)';
    case 'ilegible':
      return `el endpoint respondió algo que no sé leer: ${r.detalle}`;
    case 'error':
      return `no se pudo consultar la cuota: ${r.detalle}`;
  }
}
