// postinstall: en macOS, deja la barra de menú andando y arrancando sola.
//
// Por qué existe: `npm install -g` dejaba el CLI en el PATH y NINGUNA señal
// visible. La barra es lo que uno mira sin ir a buscarlo —el punto entero del
// programa— y venía dentro del paquete sin que nada la arrancara ni la pusiera
// en el PATH. Quien instalaba por npm en macOS instalaba y no pasaba nada.
//
// ESTE SCRIPT NUNCA FALLA UNA INSTALACIÓN. Sale 0 pase lo que pase: un
// postinstall que rompe `npm install` por no poder dibujar un ícono es un trato
// pésimo. Si algo no sale, lo dice y sigue.
//
// Y no corre donde no corresponde: sólo macOS, sólo instalación global, nunca
// en CI, nunca como root. Un contenedor de build no quiere un agente de launchd.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ETIQUETA = 'com.legios.quartermaster.barra';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${ETIQUETA}.plist`);
const BARRA = join(RAIZ, 'bin', 'qm-barra');

const saltar = (motivo) => {
  // En silencio: no es un error, es que acá no va.
  if (process.env['QM_DEBUG_POSTINSTALL']) console.log(`qm: sin barra (${motivo})`);
  process.exit(0);
};

try {
  if (platform() !== 'darwin') saltar('no es macOS');
  if (process.env['npm_config_global'] !== 'true') saltar('no es una instalación global');
  if (process.env['CI']) saltar('CI');
  if (typeof process.getuid === 'function' && process.getuid() === 0) saltar('root');
  if (!existsSync(BARRA)) saltar('no está bin/qm-barra');

  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${ETIQUETA}</string>
  <key>ProgramArguments</key><array><string>${BARRA}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`,
    'utf8',
  );

  // unload primero: si ya había una apuntando al checkout viejo, queda colgada.
  try {
    execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' });
  } catch {
    /* no estaba cargada */
  }
  execFileSync('launchctl', ['load', PLIST], { stdio: 'ignore' });

  // launchd la arranca por RunAtLoad, pero la PRIMERA vez tiene que compilar el
  // Swift y eso tarda. Se lanza también en paralelo y desasociada, así que el
  // ícono aparece durante el install y no varios segundos después.
  spawn(BARRA, [], { detached: true, stdio: 'ignore' }).unref();

  console.log('qm: barra de menú instalada — arranca sola al iniciar sesión');
  console.log('    sacarla:  launchctl unload ' + PLIST);
} catch (e) {
  console.log(`qm: no pude dejar la barra andando (${e && e.message ? e.message : e}).`);
  console.log('    el CLI quedó bien: probá `qm`. La barra: `qm-barra`.');
}
process.exit(0);
