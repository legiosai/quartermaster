// Leer un JSONL de cientos de megas sin decodificar lo que no importa.
//
// `readline` convierte CADA byte del archivo en un string de JavaScript antes
// de que se pueda preguntar si la línea sirve. Medido el 2026-10-26 sobre las
// transcripciones de una semana (2,2 GB en 162 archivos): de 171 000 líneas,
// sólo 36 000 traen `"usage"`, y suman 135 MB. Decodificar los otros 2 GB para
// tirarlos era casi todo el tiempo — 7,3 s con readline contra 2,3 s de un
// script de Python que filtraba antes de parsear.
//
// Acá la búsqueda se hace sobre los bytes (`Buffer.indexOf` es memchr) y sólo
// se decodifica la línea que tiene alguna de las marcas. El archivo se lee de
// a trozos de 1 MB, así que la memoria no depende del tamaño del archivo sino
// de la línea más larga.

import { closeSync, openSync, readSync } from 'node:fs';

const SALTO = 0x0a;

/**
 * Las líneas de `ruta` que contienen alguna de las `marcas`, en orden.
 *
 * Es un filtro barato, no un parser: una línea que nombra la marca dentro de un
 * texto también sale, y quien la recibe decide con el JSON en la mano. Lo que
 * garantiza es lo contrario — una línea sin ninguna marca no se decodifica.
 *
 * Un archivo que no se puede abrir no es un error: no produce líneas. Claude
 * Code escribe mientras se lo lee, y una transcripción que se borró entre el
 * listado y la lectura es normal.
 */
export function* lineasCon(ruta: string, marcas: readonly string[], trozo = 1 << 20): Generator<string> {
  const agujas = marcas.map((m) => Buffer.from(m, 'utf8'));
  let fd: number;
  try {
    fd = openSync(ruta, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.allocUnsafe(trozo);
    // Lo que quedó de una línea que todavía no terminó. Es una lista y no un
    // Buffer que crece: concatenar en cada trozo es cuadrático con una línea
    // de 100 MB, y esas líneas existen (un tool_result con un archivo entero).
    let resto: Buffer[] = [];
    for (;;) {
      let leidos: number;
      try {
        leidos = readSync(fd, buf, 0, trozo, null);
      } catch {
        break;
      }
      if (leidos === 0) break;
      const datos = buf.subarray(0, leidos);
      const primero = datos.indexOf(SALTO);
      if (primero < 0) {
        resto.push(Buffer.from(datos));
        continue;
      }
      let inicio = 0;
      if (resto.length > 0) {
        const linea = Buffer.concat([...resto, datos.subarray(0, primero)]);
        resto = [];
        yield* conMarca(linea, 0, linea.length, agujas);
        inicio = primero + 1;
      }
      const ultimo = datos.lastIndexOf(SALTO);
      if (inicio < ultimo) yield* conMarca(datos, inicio, ultimo, agujas);
      if (ultimo + 1 < datos.length) resto.push(Buffer.from(datos.subarray(ultimo + 1)));
    }
    // La última línea puede no tener salto: es la que se está escribiendo.
    if (resto.length > 0) {
      const linea = Buffer.concat(resto);
      yield* conMarca(linea, 0, linea.length, agujas);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Las líneas de `datos[inicio, fin)` que contienen alguna aguja. El tramo está
 * hecho de líneas enteras: arranca al principio de una y termina en un salto.
 *
 * La próxima aparición de cada aguja se guarda y se vuelve a buscar sólo cuando
 * quedó atrás. Sin eso, una marca rara (`compact_boundary`) se buscaba hasta el
 * final del trozo una vez por cada `"usage"` encontrado.
 */
function* conMarca(datos: Buffer, inicio: number, fin: number, agujas: readonly Buffer[]): Generator<string> {
  const proxima = agujas.map(() => -2);
  let pos = inicio;
  while (pos < fin) {
    let donde = -1;
    for (let i = 0; i < agujas.length; i += 1) {
      if (proxima[i]! !== -1 && proxima[i]! < pos) proxima[i] = datos.indexOf(agujas[i]!, pos);
      const p = proxima[i]!;
      if (p >= 0 && p < fin && (donde < 0 || p < donde)) donde = p;
    }
    if (donde < 0) return;
    const desde = Math.max(pos, datos.lastIndexOf(SALTO, donde) + 1);
    let hasta = datos.indexOf(SALTO, donde);
    if (hasta < 0 || hasta > fin) hasta = fin;
    yield datos.toString('utf8', desde, hasta);
    pos = hasta + 1;
  }
}
