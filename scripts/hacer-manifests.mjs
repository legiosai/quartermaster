// Los manifests de winget y de scoop, con la versión y los hashes puestos.
//
// Por qué un generador y no cuatro archivos comiteados: los manifests llevan
// la versión en el NOMBRE DEL DIRECTORIO, en tres campos adentro y en dos URLs,
// más dos SHA256 que cambian en cada release. Eso editado a mano son seis
// lugares donde se puede olvidar uno, y el que se olvida no rompe nada visible:
// winget instala la versión vieja, o falla el hash después del download, que es
// cuando ya está publicado.
//
// Los hashes salen de scripts/hacer-setup.ps1, que los imprime justo después de
// armar los dos artefactos:
//
//   node scripts/hacer-manifests.mjs --exe <sha256 del setup> --zip <sha256 del zip>
//
// Deja todo en dist/paquetes/. Nada de esto se publica solo: el de winget va
// como PR a microsoft/winget-pkgs y el de scoop a un bucket. Ver paquetes/README.md.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const paquete = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8'));

const AYUDA = `hacer-manifests · los manifests de winget y scoop

  node scripts/hacer-manifests.mjs --exe <sha256> --zip <sha256> [--version X.Y.Z]

  --exe      SHA256 del quartermaster-<v>-setup.exe   (lo imprime hacer-setup.ps1)
  --zip      SHA256 del quartermaster-<v>-win.zip     (idem)
  --version  por defecto, la de package.json

Los dos hashes son obligatorios a propósito: un manifest con el hash de otra
versión es peor que uno que falta — falla recién cuando el usuario ya bajó el
archivo, y el error habla de integridad, no de un manifest mal armado.`;

const args = process.argv.slice(2);
const valor = (nombre) => {
  const i = args.indexOf(`--${nombre}`);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  const pegado = args.find((a) => a.startsWith(`--${nombre}=`));
  return pegado === undefined ? null : pegado.slice(nombre.length + 3);
};

if (args.includes('-h') || args.includes('--help')) {
  console.log(AYUDA);
  process.exit(0);
}

const version = valor('version') ?? paquete.version;
const shaExe = (valor('exe') ?? '').toUpperCase();
const shaZip = (valor('zip') ?? '').toUpperCase();

for (const [nombre, sha] of [['--exe', shaExe], ['--zip', shaZip]]) {
  if (!/^[0-9A-F]{64}$/.test(sha)) {
    console.error(`falta o está mal ${nombre}: espero un SHA256 de 64 hex y vino "${sha}"\n\n${AYUDA}`);
    process.exit(2);
  }
}

const ID = 'Legios.Quartermaster';
const BASE = `https://github.com/legiosai/quartermaster/releases/download/v${version}`;
const EXE = `${BASE}/quartermaster-${version}-setup.exe`;
const ZIP = `${BASE}/quartermaster-${version}-win.zip`;
// El AppId del .iss, con el sufijo que Inno le agrega en el registro. winget lo
// usa para reconocer que ya está instalado y para saber qué desinstalar.
const CODIGO_PRODUCTO = '{7B1D2C64-5B3E-4E0A-9A1E-2F7C4C2B8E11}_is1';

const escribir = (relativo, texto) => {
  const destino = join(RAIZ, 'dist', 'paquetes', relativo);
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, texto, 'utf8');
  console.log(`  ✓ dist/paquetes/${relativo}`);
};

// ── winget ──────────────────────────────────────────────────────────────
// La ruta es la que pide microsoft/winget-pkgs: manifests/<primera letra en
// minúscula>/<Publicador>/<Paquete>/<versión>/.
const dirWinget = `winget/manifests/l/Legios/Quartermaster/${version}`;

escribir(
  `${dirWinget}/${ID}.yaml`,
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: ${ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`,
);

escribir(
  `${dirWinget}/${ID}.installer.yaml`,
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: ${ID}
PackageVersion: ${version}
InstallerType: inno
Scope: user
InstallModes:
  - interactive
  - silent
  - silentWithProgress
InstallerSwitches:
  Silent: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
  SilentWithProgress: /SILENT /SUPPRESSMSGBOXES /NORESTART
UpgradeBehavior: install
ProductCode: '${CODIGO_PRODUCTO}'
# qm lee el TypeScript sin paso de build: sin Node 22.6 el comando se instala y
# no arranca. Declararlo acá es lo que hace que winget lo resuelva solo.
Dependencies:
  PackageDependencies:
    - PackageIdentifier: OpenJS.NodeJS.LTS
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  # neutral y no x64: adentro del paquete no hay un solo binario compilado, es
  # JavaScript. La arquitectura la pone el Node de la máquina.
  - Architecture: neutral
    InstallerUrl: ${EXE}
    InstallerSha256: ${shaExe}
ManifestType: installer
ManifestVersion: 1.6.0
`,
);

escribir(
  `${dirWinget}/${ID}.locale.en-US.yaml`,
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Legios
PublisherUrl: https://github.com/legiosai
PublisherSupportUrl: https://github.com/legiosai/quartermaster/issues
PackageName: quartermaster
PackageUrl: https://quartermaster.legios.com.ar/
License: MIT
LicenseUrl: https://github.com/legiosai/quartermaster/blob/main/LICENSE
Copyright: Copyright (c) Legios
ShortDescription: How much quota you have left, across every agent account on the machine.
Description: |-
  quartermaster reads the quota of every Claude Code profile on the machine —not just the
  default one— plus Codex and the providers stored by opencode, and shows them in one place:
  the terminal, the Windows notification area, or a local dashboard in the browser.

  The number needs no network and no credentials: it comes from the cache Claude Code already
  writes to disk, so it still works on a profile whose token expired. Nothing leaves the
  machine except the quota poll itself, to the same host Claude Code already talks to.

  Requires Node.js 22.6 or newer.
Moniker: quartermaster
Tags:
  - claude
  - claude-code
  - cli
  - codex
  - opencode
  - quota
  - rate-limit
  - tray
  - usage
ReleaseNotesUrl: https://github.com/legiosai/quartermaster/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`,
);

escribir(
  `${dirWinget}/${ID}.locale.es-ES.yaml`,
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.locale.1.6.0.schema.json
PackageIdentifier: ${ID}
PackageVersion: ${version}
PackageLocale: es-ES
Publisher: Legios
PackageName: quartermaster
License: MIT
ShortDescription: Cuánta cuota te queda, en todas tus cuentas de agentes.
Description: |-
  quartermaster lee la cuota de todos los perfiles de Claude Code de la máquina —no sólo el
  de por defecto—, más Codex y los proveedores que guarda opencode, y los muestra juntos:
  en la terminal, en el área de notificación de Windows o en un tablero local.

  El número no necesita red ni credenciales: sale del cache que Claude Code ya deja en disco,
  así que se lee aunque el token esté vencido.

  Necesita Node.js 22.6 o más nuevo.
ManifestType: locale
ManifestVersion: 1.6.0
`,
);

// ── scoop ───────────────────────────────────────────────────────────────
// scoop no quiere instaladores: descomprime, arma shims y desinstala borrando
// el directorio. Por eso apunta al zip portable y no al .exe.
const scoop = {
  version,
  description: 'Cuánta cuota te queda en todos los perfiles de Claude Code de la máquina, más Codex y opencode.',
  homepage: 'https://quartermaster.legios.com.ar/',
  license: 'MIT',
  // El piso es 22.6 y nodejs-lts lo pasa. Sin esto el shim se instala y no
  // arranca, que es el defecto que este repo ya cometió una vez en npm.
  depends: 'main/nodejs-lts',
  url: ZIP,
  hash: shaZip.toLowerCase(),
  bin: [
    ['bin\\qm.cmd', 'qm'],
    ['bin\\qm-web.cmd', 'qm-web'],
    ['bin\\qm-tray.cmd', 'qm-tray'],
  ],
  shortcuts: [['bin\\qm-tray.cmd', 'quartermaster (bandeja)', '', 'bin\\quartermaster.ico']],
  notes: [
    'La bandeja no arranca sola: `qm-tray` la levanta, y el acceso directo del menú Inicio también.',
    'Para que arranque al iniciar sesión, poné ese acceso directo en la carpeta Inicio (shell:startup).',
    'El tablero en el navegador: `qm-web`.',
  ],
  checkver: { github: 'https://github.com/legiosai/quartermaster' },
  autoupdate: {
    url: 'https://github.com/legiosai/quartermaster/releases/download/v$version/quartermaster-$version-win.zip',
  },
};
escribir('scoop/quartermaster.json', JSON.stringify(scoop, null, 4) + '\n');

console.log(`\nmanifests de ${ID} ${version} listos.`);
console.log('winget: PR a microsoft/winget-pkgs con el directorio de arriba.');
console.log('scoop:  copiar el .json al bucket (legiosai/scoop-bucket).');
