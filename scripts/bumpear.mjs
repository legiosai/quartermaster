// Mover la versión en TODOS los lugares donde vive, de una.
//
// Son siete, y ése es el problema: package.json, el PKGBUILD, el .SRCINFO, el
// version-name de la extensión, las dos landings y los manifests que se
// generan. Editar seis de siete no rompe nada que se vea acá — rompe del otro
// lado, en un catálogo, con una persona esperando.
//
// scripts/gate-paquetes.sh comprueba que coincidan. Esto es lo que hace que
// coincidan sin tener que acordarse de seis archivos.
//
//   node scripts/bumpear.mjs 0.1.7
//   node scripts/bumpear.mjs patch|minor|major

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (r) => readFileSync(join(RAIZ, r), 'utf8');
const escribir = (r, t) => writeFileSync(join(RAIZ, r), t, 'utf8');

const paquete = JSON.parse(leer('package.json'));
const actual = paquete.version;

const pedido = process.argv[2];
if (!pedido) {
  console.error(`uso: node scripts/bumpear.mjs <versión|patch|minor|major>\n\nahora: ${actual}`);
  process.exit(2);
}

function siguiente(v, cual) {
  const [ma, mi, pa] = v.split('.').map(Number);
  if (cual === 'major') return `${ma + 1}.0.0`;
  if (cual === 'minor') return `${ma}.${mi + 1}.0`;
  if (cual === 'patch') return `${ma}.${mi}.${pa + 1}`;
  return null;
}

const nueva = siguiente(actual, pedido) ?? pedido;
if (!/^\d+\.\d+\.\d+$/.test(nueva)) {
  console.error(`"${nueva}" no es una versión semver`);
  process.exit(2);
}
if (nueva === actual) {
  console.error(`ya está en ${actual}`);
  process.exit(2);
}

// Cada entrada dice dónde vive la versión y cómo reconocerla. El `obligatorio`
// existe para que agregar un lugar nuevo y olvidarse de este archivo falle acá
// y no en el catálogo.
const lugares = [
  {
    ruta: 'package.json',
    buscar: new RegExp(`("version":\\s*")${actual}(")`),
    obligatorio: true,
  },
  {
    ruta: 'package-lock.json',
    buscar: new RegExp(`("version":\\s*")${actual}(")`, 'g'),
    obligatorio: false,
  },
  {
    ruta: 'paquetes/aur/PKGBUILD',
    buscar: new RegExp(`(pkgver=)${actual}()`),
    obligatorio: true,
  },
  {
    ruta: 'paquetes/aur/.SRCINFO',
    buscar: new RegExp(`(pkgver = )${actual}()`),
    obligatorio: true,
  },
  {
    ruta: 'extension/quartermaster@legios/metadata.json',
    buscar: new RegExp(`("version-name":\\s*")${actual}(")`),
    obligatorio: true,
  },
  {
    ruta: 'docs/index.html',
    buscar: new RegExp(`(quartermaster-)${actual}(-setup\\.exe)`, 'g'),
    obligatorio: true,
  },
  {
    ruta: 'docs/es/index.html',
    buscar: new RegExp(`(quartermaster-)${actual}(-setup\\.exe)`, 'g'),
    obligatorio: true,
  },
];

const faltaron = [];
for (const { ruta, buscar, obligatorio } of lugares) {
  if (!existsSync(join(RAIZ, ruta))) {
    if (obligatorio) faltaron.push(`${ruta} no existe`);
    continue;
  }
  const antes = leer(ruta);
  const despues = antes.replace(buscar, `$1${nueva}$2`);
  if (antes === despues) {
    if (obligatorio) faltaron.push(`${ruta} no tenía ${actual}`);
    continue;
  }
  escribir(ruta, despues);
  console.log(`  ✓ ${ruta}`);
}

// La landing tiene además el número que se muestra en el pie.
for (const pagina of ['docs/index.html', 'docs/es/index.html']) {
  const antes = leer(pagina);
  const despues = antes.replace(
    /(releases">)v\d+\.\d+\.\d+(<\/a>)/,
    `$1v${nueva}$2`,
  );
  if (antes !== despues) {
    escribir(pagina, despues);
    console.log(`  ✓ ${pagina} (el pie)`);
  }
}

if (faltaron.length) {
  console.error('\n✗ no se pudo mover la versión en:');
  for (const f of faltaron) console.error(`  · ${f}`);
  console.error('\nEl árbol quedó a medias: revisá antes de comitear.');
  process.exit(1);
}

console.log(`\n${actual} → ${nueva}`);
console.log('ahora: ./scripts/gate-paquetes.sh  y después  make release');
