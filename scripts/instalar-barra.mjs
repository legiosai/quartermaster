// postinstall: decir que la barra existe. Y nada más.
//
// QUÉ HACÍA ANTES, Y POR QUÉ CAMBIÓ. Este script escribía un
// ~/Library/LaunchAgents/com.legios.quartermaster.barra.plist, lo cargaba con
// launchctl y lanzaba el proceso — todo eso adentro de un `npm install -g`.
// Resolvía un problema real: quien instalaba por npm en macOS no veía ninguna
// señal, y la barra es el punto entero del programa.
//
// Pero un postinstall que registra un agente de arranque es exactamente el
// patrón que hace que alguien mire el paquete de reojo, y acá pesa doble: esto
// lee credenciales OAuth del llavero. Un proyecto que pide confianza para leer
// tokens no puede gastarla instalando cosas que no le pidieron. Y hay una razón
// práctica además de la de confianza: `npm ci --ignore-scripts` es lo normal en
// CI y en cualquier organización con políticas, así que el camino "mágico"
// tampoco era confiable.
//
// Así que ahora el postinstall IMPRIME y el usuario decide. Es un renglón más
// de trabajo para él y una objeción menos para el proyecto.
//
// Sigue sin fallar nunca una instalación: sale 0 pase lo que pase.

import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// En silencio donde no corresponde: una instalación local como dependencia, un
// contenedor de build, un CI. El aviso es para quien acaba de instalar la
// herramienta a mano.
if (process.env['npm_config_global'] !== 'true' || process.env['CI']) process.exit(0);

const so = platform();
const lineas = ['', 'quartermaster instalado. `qm` ya anda.'];

if (so === 'darwin' && existsSync(join(RAIZ, 'bin', 'qm-barra'))) {
  lineas.push(
    '',
    'Para verlo sin ir a buscarlo, la barra de menú:',
    '',
    '    qm-barra                       arrancarla ahora',
    '    qm-barra --instalar-arranque   y que arranque sola al iniciar sesión',
    '',
    'Eso escribe un LaunchAgent en ~/Library/LaunchAgents. No lo hace esta',
    'instalación: lo hacés vos cuando quieras.',
  );
} else if (so === 'linux') {
  lineas.push(
    '',
    'Para verlo sin ir a buscarlo:',
    '',
    '    qm-web                         el tablero en el navegador',
    '',
    'Y en GNOME, el indicador de la barra de arriba: ver el README.',
  );
} else if (so === 'win32') {
  lineas.push(
    '',
    'Para verlo sin ir a buscarlo:',
    '',
    '    qm-web                         el tablero en el navegador',
    '',
    'La bandeja del área de notificación viene en el instalador de Windows.',
  );
}

lineas.push('', '    qm --breve                     lo que va en una statusline', '');
console.log(lineas.join('\n'));
process.exit(0);
