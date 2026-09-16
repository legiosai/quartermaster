#!/usr/bin/env node
// ¿Alguien instaló esto? Un número, y no una comparación a ojo.
//
//   node scripts/descargas.mjs            # escribe docs/descargas.json
//   node scripts/descargas.mjs --seco     # lo imprime y no escribe nada
//
// Los contadores públicos que hay —npm y los adjuntos de cada release— cuentan
// también lo nuestro, y lo nuestro es casi todo. Medido el 2026-09-16, con
// quince versiones publicadas y ninguna anunciada:
//
//   · npm: 345, 180 y 777 descargas en los tres días con publicaciones (3, 1 y
//     5 publicaciones), y CERO en los días sin ninguna. Son los mirrors y los
//     escáneres que bajan cada versión nueva, entre 115 y 180 por publicación.
//     Una persona instalando se ve como un goteo en días sin publicar, y ése es
//     el número que vale: `enDiasSinPublicar`.
//   · releases: el instalador de Windows tenía entre 4 y 11 bajadas por versión
//     y el zip entre 2 y 4, en todas, desde el minuto de publicadas. release.yml
//     baja los dos una vez para el hash de winget (línea ~372) y las
//     validaciones de winget y scoop los bajan de nuevo. El piso observado —4 y
//     2— se resta y lo que sobra se cuenta. El .deb y el zip de la extensión no
//     los toca ningún automatismo: se cuentan enteros.
//
// El JSON va a docs/ a propósito: docs/ es la landing, así que queda público en
// quartermaster.legios.com.ar/descargas.json y una página lo puede leer sin
// preguntarle a dos APIs. Y guarda un historial de una línea por día, porque
// los adjuntos de GitHub son acumulados: «esta semana» sólo existe restando
// contra lo que decía hace siete días.
//
// La herramienta sigue sin telemetría: acá se leen dos APIs públicas desde
// nuestro lado, y la máquina de quien instala no manda nada.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = join(RAIZ, 'docs/descargas.json');
const PAQUETE = '@legios/quartermaster';
const REPO = 'legiosai/quartermaster';

/** Lo que baja nuestra propia automatización de cada release, por adjunto. */
export const PISO = { exe: 4, zip: 2 };

/** De qué adjunto se trata, por el nombre. `null` para lo que no se cuenta (SHA256SUMS). */
export function tipoAdjunto(nombre) {
  if (/-setup\.exe$/.test(nombre)) return 'exe';
  if (/-win\.zip$/.test(nombre)) return 'zip';
  if (/\.deb$/.test(nombre)) return 'deb';
  if (/shell-extension\.zip$/.test(nombre)) return 'extension';
  return null;
}

/**
 * npm por día, separando los días con publicación de los que no.
 *
 * `dias`: [{day, downloads}] tal como los da api.npmjs.org.
 * `publicaciones`: los ISO de `time` del registry (sin created/modified).
 */
export function separarNpm(dias, publicaciones) {
  const porDia = new Map();
  for (const iso of publicaciones) {
    const d = iso.slice(0, 10);
    porDia.set(d, (porDia.get(d) ?? 0) + 1);
  }
  const filas = dias.map((x) => {
    const publicadas = porDia.get(x.day) ?? 0;
    return { dia: x.day, descargas: x.downloads, publicaciones: publicadas, humanas: publicadas === 0 ? x.downloads : null };
  });
  const total = filas.reduce((s, f) => s + f.descargas, 0);
  const enDiasSinPublicar = filas.reduce((s, f) => s + (f.humanas ?? 0), 0);
  const conPublicacion = filas.filter((f) => f.publicaciones > 0);
  const bajadasEsosDias = conPublicacion.reduce((s, f) => s + f.descargas, 0);
  const cantidad = conPublicacion.reduce((s, f) => s + f.publicaciones, 0);
  return {
    total,
    enDiasSinPublicar,
    porPublicacion: cantidad === 0 ? null : Math.round(bajadasEsosDias / cantidad),
    dias: filas,
  };
}

/**
 * Los adjuntos de cada release, con el piso de la automatización restado.
 * `releases`: [{tag_name, published_at, assets: [{name, download_count}]}].
 */
export function separarAdjuntos(releases) {
  const porVersion = [];
  let humanas = 0;
  for (const r of releases) {
    const adjuntos = {};
    let propias = 0;
    for (const a of r.assets ?? []) {
      const tipo = tipoAdjunto(a.name);
      if (tipo === null) continue;
      const netas = Math.max(0, a.download_count - (PISO[tipo] ?? 0));
      adjuntos[tipo] = { bajadas: a.download_count, netas };
      propias += netas;
    }
    humanas += propias;
    porVersion.push({ version: r.tag_name, publicada: r.published_at?.slice(0, 10) ?? null, humanas: propias, adjuntos });
  }
  return { humanas, porVersion };
}

/**
 * Una línea por día: reemplaza la de hoy si ya está, y con eso «esta semana»
 * es restar contra la línea de hace siete días o más.
 */
export function agregarAlHistorial(historial, hoy, npmHumanas, githubHumanas) {
  const sinHoy = historial.filter((h) => h.fecha !== hoy);
  return [...sinHoy, { fecha: hoy, npm: npmHumanas, github: githubHumanas }].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export function estaSemana(historial, hoy) {
  const ultima = historial.find((h) => h.fecha === hoy);
  if (!ultima) return null;
  const hace7 = new Date(`${hoy}T00:00:00Z`);
  hace7.setUTCDate(hace7.getUTCDate() - 7);
  const corte = hace7.toISOString().slice(0, 10);
  // La más reciente de las que tienen siete días o más; si el historial es
  // más corto que una semana, la primera que haya.
  const base = [...historial].reverse().find((h) => h.fecha <= corte) ?? historial[0];
  return { desde: base.fecha, npm: ultima.npm - base.npm, github: ultima.github - base.github };
}

async function json(url, cabeceras = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'quartermaster-descargas', ...cabeceras } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function principal() {
  const seco = process.argv.includes('--seco');
  const hoy = new Date().toISOString().slice(0, 10);

  const registry = await json(`https://registry.npmjs.org/${PAQUETE}`);
  const publicaciones = Object.entries(registry.time)
    .filter(([k]) => k !== 'created' && k !== 'modified')
    .map(([, v]) => v);
  const desde = registry.time.created.slice(0, 10);
  const rango = await json(`https://api.npmjs.org/downloads/range/${desde}:${hoy}/${encodeURIComponent(PAQUETE)}`);
  const npm = separarNpm(rango.downloads ?? [], publicaciones);

  const token = process.env.GITHUB_TOKEN;
  const releases = await json(`https://api.github.com/repos/${REPO}/releases?per_page=100`, token ? { authorization: `Bearer ${token}` } : {});
  const github = separarAdjuntos(releases);

  const previo = existsSync(SALIDA) ? JSON.parse(readFileSync(SALIDA, 'utf8')) : {};
  const historial = agregarAlHistorial(previo.historial ?? [], hoy, npm.enDiasSinPublicar, github.humanas);

  const salida = {
    generado: new Date().toISOString(),
    // Lo que importa, arriba y en dos números.
    resumen: {
      humanasHastaHoy: { npm: npm.enDiasSinPublicar, github: github.humanas },
      estaSemana: estaSemana(historial, hoy),
      nota: 'npm publica sus números con uno o dos días de atraso; los últimos dos días siempre están incompletos.',
    },
    npm,
    github,
    piso: PISO,
    historial,
  };
  const texto = `${JSON.stringify(salida, null, 2)}\n`;
  if (seco) {
    process.stdout.write(texto);
    return;
  }
  writeFileSync(SALIDA, texto);
  const s = salida.resumen;
  console.log(`docs/descargas.json escrito · humanas hasta hoy: npm ${s.humanasHastaHoy.npm} · github ${s.humanasHastaHoy.github}` +
    (s.estaSemana ? ` · esta semana (desde ${s.estaSemana.desde}): npm ${s.estaSemana.npm} · github ${s.estaSemana.github}` : ''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((e) => {
    console.error(`descargas: ${e.message}`);
    process.exit(1);
  });
}
