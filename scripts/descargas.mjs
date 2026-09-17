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
 * Los repos que SIRVEN un canal. `brew install legiosai/tap/…` y `scoop update`
 * son un git fetch contra estos, y GitHub los cuenta como clones.
 *
 * Existe porque el CTA principal —la landing y el README arrancan con
 * `brew install legiosai/tap/quartermaster`— es justo el canal SIN contador:
 * un tap de Homebrew no reporta instalaciones a nadie. Medido el 2026-09-17,
 * con la 0.1.15 publicada y un anuncio en LinkedIn el día anterior, el tablero
 * decía «npm 0» y de brew y scoop no decía NADA. Eso no es cero: es que no se
 * estaba mirando, y la diferencia importa cuando lo que se concluye es «nadie
 * lo instaló».
 *
 * No reemplaza a un contador: son clones, y ahí adentro hay CI y escáneres.
 * Por eso se cuentan igual que los días de npm —sólo los días sin release—,
 * que es el mismo truco que hace confiable `enDiasSinPublicar`.
 */
export const REPOS_CANAL = {
  brew: 'legiosai/homebrew-tap',
  scoop: 'legiosai/scoop-bucket',
};

/**
 * Los clones de un repo de canal, separando los días con release de los que no.
 *
 * Un día con release tiene los checkouts de release.yml y la ronda de mirrors;
 * un día sin release no tiene ninguno de los dos, así que lo que quede ahí es
 * lo más cerca de «alguien corrió brew install» que se puede medir sin
 * telemetría. Mismo criterio que `separarNpm`, y por la misma razón.
 *
 * `dias`: [{timestamp, count, uniques}] tal como los da la API de tráfico.
 * `fechasDeRelease`: los ISO de publicación de las releases.
 */
export function separarClones(dias, fechasDeRelease) {
  const conRelease = new Set(fechasDeRelease.map((f) => f.slice(0, 10)));
  const filas = (dias ?? []).map((d) => {
    const dia = d.timestamp.slice(0, 10);
    const hubo = conRelease.has(dia);
    return { dia, clones: d.count, unicos: d.uniques, huboRelease: hubo, quietos: hubo ? null : d.uniques };
  });
  return {
    total: filas.reduce((s, f) => s + f.clones, 0),
    unicos: filas.reduce((s, f) => s + f.unicos, 0),
    enDiasSinRelease: filas.reduce((s, f) => s + (f.quietos ?? 0), 0),
    // Cuántos días quietos hubo, que es lo que le da peso al número de arriba.
    // Cortando una release por día quedan cero, y entonces `enDiasSinRelease`
    // vale 0 por falta de ventana y no por falta de gente. Sin este contador
    // las dos cosas se leen igual.
    diasSinRelease: filas.filter((f) => !f.huboRelease).length,
    dias: filas,
  };
}

/** Las estrellas por día, que es lo único que viene con una persona atrás. */
export function separarEstrellas(stargazers) {
  const porDia = new Map();
  for (const s of stargazers ?? []) {
    const d = (s.starred_at ?? '').slice(0, 10);
    if (d) porDia.set(d, (porDia.get(d) ?? 0) + 1);
  }
  return {
    total: (stargazers ?? []).length,
    dias: [...porDia.entries()].sort().map(([dia, estrellas]) => ({ dia, estrellas })),
  };
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

/**
 * Lo mismo, pero devolviendo el porqué en vez de tumbar la corrida.
 *
 * La API de tráfico pide permiso de push, y el token de un canal no es el mismo
 * que el del repo. Un 403 ahí no puede llevarse puesto el conteo de npm — pero
 * tampoco puede desaparecer: el JSON dice `null` Y dice por qué, que es la
 * diferencia entre «nadie lo clonó» y «no lo miramos».
 */
async function jsonOpcional(url, cabeceras = {}) {
  try {
    return { datos: await json(url, cabeceras), porQueNo: null };
  } catch (e) {
    return { datos: null, porQueNo: e.message.replace(/^https:\/\/api\.github\.com\/repos\//, '') };
  }
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

  // ── el interés, que es la otra mitad y faltaba entera ────────────────
  // El tablero medía descargas y nada más, así que el día del anuncio —21
  // visitantes únicos y tres estrellas de gente que no conocemos— se veía
  // igual que un martes cualquiera: npm 0. Lo que sigue no son instalaciones,
  // y por eso va en otra sección: es cuánta gente llegó, de dónde, y qué pasó
  // en los dos canales que no tienen contador.
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const fechasDeRelease = releases.map((r) => r.published_at).filter(Boolean);

  // La API de TRÁFICO pide permiso de push, y el GITHUB_TOKEN de un workflow no
  // lo da: `administration` ni siquiera es una clave válida en `permissions:`.
  // Así que las visitas, los referentes y los clones van con un PAT. El tap y
  // el bucket, además, son otros repos, donde el token del job no llega nunca.
  const tokenTrafico = process.env.TOKEN_PAQUETES || token;
  const authTrafico = tokenTrafico ? { authorization: `Bearer ${tokenTrafico}` } : {};

  const vistas = await jsonOpcional(`https://api.github.com/repos/${REPO}/traffic/views`, authTrafico);
  const referentes = await jsonOpcional(`https://api.github.com/repos/${REPO}/traffic/popular/referrers`, authTrafico);
  // Las estrellas son públicas: ésas sí con el token del job.
  const estrellas = await jsonOpcional(`https://api.github.com/repos/${REPO}/stargazers?per_page=100`, {
    ...auth, accept: 'application/vnd.github.star+json',
  });

  const canales = {};
  for (const [canal, repo] of Object.entries(REPOS_CANAL)) {
    const r = await jsonOpcional(`https://api.github.com/repos/${repo}/traffic/clones`, authTrafico);
    canales[canal] = r.datos
      ? { repo, ...separarClones(r.datos.clones, fechasDeRelease) }
      : { repo, porQueNo: r.porQueNo, nota: 'la API de tráfico pide permiso de push: hace falta un PAT en TOKEN_PAQUETES' };
  }

  const interes = {
    nota: 'Nada de esto es una instalación. Es quién llegó, de dónde, y el único rastro que dejan brew y scoop.',
    vistas: vistas.datos
      ? { total: vistas.datos.count, unicos: vistas.datos.uniques, dias: (vistas.datos.views ?? []).map((v) => ({ dia: v.timestamp.slice(0, 10), vistas: v.count, unicos: v.uniques })) }
      : { porQueNo: vistas.porQueNo },
    referentes: referentes.datos
      ? referentes.datos.map((r) => ({ sitio: r.referrer, vistas: r.count, unicos: r.uniques }))
      : { porQueNo: referentes.porQueNo },
    estrellas: estrellas.datos ? separarEstrellas(estrellas.datos) : { porQueNo: estrellas.porQueNo },
    canalesSinContador: canales,
  };

  const previo = existsSync(SALIDA) ? JSON.parse(readFileSync(SALIDA, 'utf8')) : {};
  const historial = agregarAlHistorial(previo.historial ?? [], hoy, npm.enDiasSinPublicar, github.humanas);

  const salida = {
    generado: new Date().toISOString(),
    // Lo que importa, arriba y en dos números.
    resumen: {
      humanasHastaHoy: { npm: npm.enDiasSinPublicar, github: github.humanas },
      estaSemana: estaSemana(historial, hoy),
      // Los dos canales sin contador, arriba y no enterrados: el CTA principal
      // es `brew install` y durante quince versiones no se miró ni una vez.
      sinContador: Object.fromEntries(Object.entries(interes.canalesSinContador)
        .map(([c, v]) => [c, v.enDiasSinRelease ?? null])),
      llegaron: interes.vistas?.unicos ?? null,
      estrellas: interes.estrellas?.total ?? null,
      nota: 'npm publica sus números con uno o dos días de atraso; los últimos dos días siempre están incompletos.',
    },
    npm,
    github,
    interes,
    piso: PISO,
    historial,
  };
  // Una sección en null es un dato, pero adentro de un JSON de 400 líneas no la
  // ve nadie —que es exactamente cómo el AUR pasó diez releases sin publicar—.
  // Así que sale por el log del workflow, donde se mira. Va ACÁ arriba y no
  // junto a la escritura porque los dos `return` de abajo se la saltearían, y
  // el día sin cambios es justo el día en que nadie abre el archivo.
  const enNull = [
    ['vistas', salida.interes.vistas?.porQueNo],
    ['referentes', salida.interes.referentes?.porQueNo],
    ['estrellas', salida.interes.estrellas?.porQueNo],
    ...Object.entries(salida.interes.canalesSinContador).map(([c, v]) => [c, v.porQueNo]),
  ].filter(([, porQue]) => porQue);
  // Con --seco no: lo único que sale por stdout ahí es el JSON.
  if (enNull.length > 0 && !seco) {
    for (const [que, porQue] of enNull) console.log(`::warning::${que}: sin número — ${porQue}`);
    console.log('::warning::La API de tráfico pide permiso de ADMIN sobre el repo, no sólo push.' +
      ' Hace falta un PAT con ese permiso en TOKEN_PAQUETES (fine-grained: Administration=read,' +
      ' sobre quartermaster, homebrew-tap y scoop-bucket). Sin eso el tablero mide descargas y no mide interés.');
  }

  const texto = `${JSON.stringify(salida, null, 2)}\n`;
  if (seco) {
    process.stdout.write(texto);
    return;
  }
  // Si lo único que cambió es la hora de la corrida, no se escribe: el
  // workflow comitea cuando el archivo cambia, y un `generado` distinto cada
  // día es un commit diario que no dice nada. La primera corrida del día que
  // no trae ni una descarga nueva deja el archivo como estaba.
  const sinHora = (o) => JSON.stringify({ ...o, generado: null });
  if (sinHora(previo) === sinHora(salida)) {
    console.log('docs/descargas.json sin cambios: ningún número se movió');
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
