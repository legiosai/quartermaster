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
