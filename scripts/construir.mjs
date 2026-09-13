// Compila src/ a dist/ y copia los activos estáticos que el TypeScript no toca.
//
// Sólo hace falta para el tarball de npm: Node se niega a hacer type stripping
// bajo node_modules, que es donde vive un `npm install -g`. Las otras tres vías
// —make instalar, el .deb y brew— leen el TypeScript directo y no pasan por acá.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(RAIZ, 'dist'), { recursive: true, force: true });

// El tsc LOCAL, no `npx tsc`: npx resuelve por PATH y en una máquina con otro
// tsc adelante compila con la versión equivocada, o directamente no lo
// encuentra si node_modules no está instalado. El del lockfile o nada.
//
// Y se ejecuta el JS del paquete, no el shim de `node_modules/.bin`. El shim
// existe con ese nombre exacto sólo en POSIX: en Windows npm deja `tsc.cmd` y
// `tsc.ps1`, así que `execFileSync(.bin/tsc)` moría con
//
//   Error: spawnSync C:\...\node_modules\.bin\tsc ENOENT
//
// Medido en una VM de Windows 10: `npm run construir` no corría en Windows, y
// de eso cuelgan el instalador y el job de CI que lo compila. Correr el .js con
// el mismo Node que está corriendo esto no depende de la plataforma, ni del
// PATH, ni de que un .cmd se pueda lanzar sin shell.
const TSC = join(RAIZ, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(TSC)) {
  console.error('falta node_modules/typescript — corré `npm install` antes de construir');
  process.exit(1);
}
execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: RAIZ, stdio: 'inherit' });

// El tablero es HTML plano: tsc no lo ve y bin/qm-web lo busca en dist primero.
mkdirSync(join(RAIZ, 'dist', 'render'), { recursive: true });
cpSync(join(RAIZ, 'src', 'render', 'tablero.html'), join(RAIZ, 'dist', 'render', 'tablero.html'));

console.log('✓ dist/ construido — cli, adapters, core, render y el tablero');
