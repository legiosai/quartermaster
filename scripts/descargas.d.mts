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
