#!/usr/bin/env node
// La entrada de `qm` cuando se instala por npm, y SÓLO por npm.
//
// Por qué existe. npm genera los shims a partir del shebang del archivo que
// dice `bin`, y `bin/qm` es un `#!/bin/sh`: en Windows eso produce un `qm.cmd`
// que invoca `sh`, y `sh` no está en el PATH de una máquina con Git for Windows
// instalado de la forma normal (el PATH queda apuntando a `Git\cmd`, que tiene
// git.exe y no tiene sh.exe). O sea: `npm install -g @legios/quartermaster` en
// Windows dejaba un comando que no arranca. Es el mismo defecto que H9 encontró
// en el tarball —instala y revienta al invocar—, una capa más arriba.
//
// npm no acepta un `bin` por plataforma, así que la entrada tiene que ser algo
// que corra en las dos. Este archivo es eso, y nada más:
//
//   · si el Node que lo está ejecutando YA sirve, carga el CLI acá mismo. No
//     hay segundo proceso: para la statusline, que corre en cada redibujo, eso
//     es más rápido que lo que hace hoy `bin/qm` (sh → node);
//   · si no sirve, le pasa el trabajo al lanzador de la plataforma —bin/qm en
//     POSIX, bin\qm.cmd en Windows—, que es donde vive la búsqueda de un Node
//     que alcance. La búsqueda NO se reimplementa acá: dos copias de esa lista
//     de rutas ya son bastante.
//
// Es JavaScript común, no TypeScript, a propósito: tiene que poder correr con
// el Node viejo que justamente lo obliga a delegar.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function sirveEsteNode() {
  const [a, b] = process.versions.node.split('.').map(Number);
  return a > 22 || (a === 22 && b >= 6);
}

// El tarball de npm SIEMPRE lleva dist/ (lo garantiza prepublishOnly), así que
// por este camino el JS compilado está. El src/ es para quien tenga este
// archivo en un clone.
const compilado = join(RAIZ, 'dist', 'cli', 'qm.js');
const fuente = join(RAIZ, 'src', 'cli', 'qm.ts');

if (sirveEsteNode() && existsSync(compilado)) {
  // El CLI hace su trabajo al importarse y maneja su propio código de salida.
  await import(pathToFileURL(compilado).href);
} else {
  const enWindows = process.platform === 'win32';
  const lanzador = join(RAIZ, 'bin', enWindows ? 'qm.cmd' : 'qm');

  if (!existsSync(lanzador)) {
    // Sin lanzador y sin Node que sirva no hay a dónde ir, pero sí hay una
    // frase: silencio es el bug (SOUL.md).
    console.error(`qm necesita Node >= 22.6 y este es ${process.versions.node}.`);
    console.error(`Tampoco encuentro el lanzador en ${lanzador}.`);
    console.error('');
    console.error('  nvm install 22        # o instalá Node 22 como prefieras');
    console.error('  QM_NODE=/ruta/a/node  # o decile cuál usar');
    process.exit(1);
  }

  let r;
  if (enWindows) {
    // Un .cmd no se puede lanzar directo desde Node (desde la 18.20/20.12,
    // spawn sin shell lo rechaza), así que va por cmd.exe. La forma de las
    // comillas —todo el comando envuelto en un par más— es la que documenta
    // `cmd /?` para que /s deje el resto intacto.
    const citar = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const linea = [citar(lanzador), ...args.map(citar)].join(' ');
    r = spawnSync(process.env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', `"${linea}"`], {
      stdio: 'inherit',
      windowsVerbatimArguments: true,
    });
  } else {
    r = spawnSync(lanzador, args, { stdio: 'inherit' });
  }

  if (r.error) {
    console.error(`qm: no pude arrancar ${lanzador}: ${r.error.message}`);
    process.exit(1);
  }
  // El código importa: `--umbral` sale 3 y quien lo encadena lo mira.
  process.exit(r.status === null ? 1 : r.status);
}

// Nota para quien edite esto: no va nada después del `await import`. El CLI
// puede llamar a process.exit() y cualquier línea de acá abajo sería código que
// a veces corre y a veces no, que es peor que no estar.
