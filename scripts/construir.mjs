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
// encuentra si node_modules no está instalado. El binario del lockfile o nada.
const TSC = join(RAIZ, 'node_modules', '.bin', 'tsc');
if (!existsSync(TSC)) {
  console.error('falta node_modules/.bin/tsc — corré `npm install` antes de construir');
  process.exit(1);
}
execFileSync(TSC, ['-p', 'tsconfig.build.json'], { cwd: RAIZ, stdio: 'inherit' });

// El tablero es HTML plano: tsc no lo ve y bin/qm-web lo busca en dist primero.
mkdirSync(join(RAIZ, 'dist', 'render'), { recursive: true });
cpSync(join(RAIZ, 'src', 'render', 'tablero.html'), join(RAIZ, 'dist', 'render', 'tablero.html'));

console.log('✓ dist/ construido — cli, adapters, core, render y el tablero');
