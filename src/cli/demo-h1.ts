// H1 · el número real: cuánto se consumió, leído de las transcripciones que ya
// están en disco. Sin credenciales, sin red. Escribe numeros/h1.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { descubrirPerfiles } from '../core/perfiles.ts';
import { consumoDesde, transcripciones } from '../adapters/transcripciones.ts';
import { totalTokens } from '../core/tipos.ts';
import { negrita, tenue, tokens, relleno } from '../render/barras.ts';

const VENTANA_H = 5;
const DIAS = 7;

const perfiles = descubrirPerfiles();
const desde = new Date(Date.now() - DIAS * 24 * 3600_000);
const arranque = Date.now();

console.log(negrita(`\nConsumo local · últimos ${DIAS} días\n`));

const reporte: Record<string, unknown>[] = [];
for (const p of perfiles) {
  const archivos = transcripciones(p).length;
  const c = await consumoDesde(p, desde);
  const ventana = await consumoDesde(p, new Date(Date.now() - VENTANA_H * 3600_000));

  console.log(`  ${negrita(relleno(p.nombre, 18))} ${tenue(p.cuenta?.email ?? 'sin cuenta')}`);
  console.log(`  ${relleno('', 18)} ${archivos} transcripciones · ${c.requests} requests`);
  console.log(`  ${relleno('', 18)} ${tokens(totalTokens(c))} tokens en ${DIAS}d · ${tokens(totalTokens(ventana))} en ${VENTANA_H}h`);
  for (const [modelo, t] of [...c.porModelo].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    console.log(`  ${relleno('', 18)} ${tenue(`${relleno(modelo, 28)} ${tokens(t)}`)}`);
  }
  console.log();

  reporte.push({
    perfil: p.nombre,
    cuenta: p.cuenta?.email ?? null,
    plan: p.cuenta?.plan ?? null,
    transcripciones: archivos,
    requests: c.requests,
    tokens7d: totalTokens(c),
    tokens5h: totalTokens(ventana),
    porModelo: Object.fromEntries(c.porModelo),
    primero: c.primero?.toISOString() ?? null,
    ultimo: c.ultimo?.toISOString() ?? null,
  });
}

const salida = {
  generado: new Date().toISOString(),
  plataforma: process.platform,
  ventanaDias: DIAS,
  duracionMs: Date.now() - arranque,
  perfiles: reporte,
};
mkdirSync('numeros', { recursive: true });
writeFileSync('numeros/h1.json', `${JSON.stringify(salida, null, 2)}\n`);
console.log(tenue(`numeros/h1.json escrito en ${Date.now() - arranque} ms\n`));
