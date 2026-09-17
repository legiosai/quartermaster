// Los tipos de descargas.mjs, para que el test lo importe bajo tsc. El script
// es JS a propósito —como el resto de scripts/, corre en el workflow sin build—
// y esto es lo único que hace falta para que el test tenga tipos.
export declare const PISO: { readonly exe: number; readonly zip: number };
export type TipoAdjunto = 'exe' | 'zip' | 'deb' | 'extension';
export declare function tipoAdjunto(nombre: string): TipoAdjunto | null;

export interface DiaNpm { readonly day: string; readonly downloads: number }
export interface FilaNpm { readonly dia: string; readonly descargas: number; readonly publicaciones: number; readonly humanas: number | null }
export declare function separarNpm(dias: readonly DiaNpm[], publicaciones: readonly string[]): {
  readonly total: number; readonly enDiasSinPublicar: number; readonly porPublicacion: number | null; readonly dias: FilaNpm[];
};

export interface Adjunto { readonly name: string; readonly download_count: number }
export interface Release { readonly tag_name: string; readonly published_at: string | null; readonly assets?: readonly Adjunto[] }
export declare function separarAdjuntos(releases: readonly Release[]): {
  readonly humanas: number;
  readonly porVersion: { readonly version: string; readonly publicada: string | null; readonly humanas: number; readonly adjuntos: Record<string, { bajadas: number; netas: number }> }[];
};

export interface LineaHistorial { readonly fecha: string; readonly npm: number; readonly github: number }
export declare function agregarAlHistorial(historial: readonly LineaHistorial[], hoy: string, npmHumanas: number, githubHumanas: number): LineaHistorial[];
export declare function estaSemana(historial: readonly LineaHistorial[], hoy: string): { desde: string; npm: number; github: number } | null;

// Los dos canales sin contador: un tap de Homebrew y un bucket de scoop no
// reportan instalaciones, y lo único que dejan es el git fetch del cliente.
export declare const REPOS_CANAL: { readonly brew: string; readonly scoop: string };
export interface DiaClones { readonly timestamp: string; readonly count: number; readonly uniques: number }
export interface FilaClones { readonly dia: string; readonly clones: number; readonly unicos: number; readonly huboRelease: boolean; readonly quietos: number | null }
export declare function separarClones(dias: readonly DiaClones[] | undefined, fechasDeRelease: readonly string[]): {
  readonly total: number; readonly unicos: number; readonly enDiasSinRelease: number; readonly diasSinRelease: number; readonly dias: FilaClones[];
};

// Sin la cabecera `star+json` la API devuelve el usuario pelado, sin fecha:
// ése es justo el caso que el test cubre.
export interface Estrella { readonly starred_at?: string; readonly login?: string }
export declare function separarEstrellas(stargazers: readonly Estrella[] | undefined): {
  readonly total: number; readonly dias: { readonly dia: string; readonly estrellas: number }[];
};

// Los días que le faltan al historial: el cron de GitHub se atrasa y a veces se
// saltea una corrida, y «esta semana» sigue dando un número igual.
export declare function huecosDelHistorial(historial: readonly LineaHistorial[] | undefined, hoy: string): {
  readonly desde: string | null; readonly esperados: number; readonly anotados: number; readonly faltan: string[];
};
