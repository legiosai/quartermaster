// El item de quartermaster en la barra de arriba de GNOME.
//
// Esta extensión NO sabe qué es una cuota. Hace dos cosas: muestra el PNG que
// dibuja `bin/qm-indicator` y, cuando le hacen click, deja un pedido en un
// archivo para que ese proceso abra su panel. Todo el dibujo y todos los
// números viven allá.
//
// Existe porque el click izquierdo sobre un AppIndicator se lo queda la
// extensión que los soporta: hace `this.menu.toggle()` con el botón primario y
// no hay manera de enterarse de que pasó — su `AboutToShow` devuelve `false` y
// nunca llega al proceso. Con un item propio, el click es nuestro.
//
// La conversación va por archivos y no por DBus a propósito: son dos procesos
// que ya comparten un directorio de cache, un archivo se vigila con
// Gio.FileMonitor de los dos lados, y no hay que registrar ni un nombre de bus
// ni una interfaz para pasar «abrí el panel».

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CARPETA = GLib.build_filenamev([GLib.get_user_cache_dir(), 'quartermaster']);
// Lo que qm acaba de dibujar: {icono, ancho, alto}.
const ESTADO = GLib.build_filenamev([CARPETA, 'estado.json']);
// Mientras exista, qm esconde su propio item de AppIndicator: si no, quedan dos.
const VIVA = GLib.build_filenamev([CARPETA, 'extension-viva']);
// Donde se deja el click.
const PEDIDO = GLib.build_filenamev([CARPETA, 'pedido']);

const Boton = GObject.registerClass(
class Boton extends PanelMenu.Button {
    _init() {
        // El tercer argumento es dontCreateMenu: el panel no es un menú del
        // shell —lo dibuja qm y lo abre qm—, así que este botón no tiene menú
        // que abrir y el click queda libre.
        super._init(0.5, 'quartermaster', true);

        this._imagen = new St.Bin({yAlign: Clutter.ActorAlign.CENTER});
        this.add_child(this._imagen);
        this._ancho = 0;
        this._alto = 0;
        this._leer();

        this._vigia = Gio.File.new_for_path(ESTADO).monitor_file(
            Gio.FileMonitorFlags.NONE, null);
        this._vigia.connect('changed', () => this._leer());

        this.connect('button-press-event', () => {
            this._pedir('alternar');
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', event => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._pedir('alternar');
            return Clutter.EVENT_STOP;
        });
    }

    _leer() {
        let datos;
        try {
            const [ok, bytes] = GLib.file_get_contents(ESTADO);
            if (!ok)
                return;
            datos = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            return;  // sin estado no hay nada que mostrar todavía
        }
        if (!datos.icono || !datos.ancho || !datos.alto)
            return;
        this._ancho = datos.ancho;
        this._alto = datos.alto;
        // El nombre del archivo alterna entre dos: el shell cachea la textura
        // por ruta, y reescribiendo siempre la misma el item se quedaría con el
        // dibujo viejo.
        this._imagen.set_style(
            `background-image: url("file://${datos.icono}");` +
            'background-size: contain;' +
            'background-repeat: no-repeat;' +
            `width: ${datos.ancho}px;` +
            `height: ${datos.alto}px;`);
        this.accessible_name = datos.descripcion ?? 'quartermaster';
    }

    _pedir(accion) {
        // El tiempo va adentro para que dos clicks seguidos escriban contenidos
        // distintos: si el archivo queda igual, el monitor del otro lado puede
        // no avisar y el segundo click se pierde.
        try {
            GLib.file_set_contents(PEDIDO, `${accion} ${GLib.get_monotonic_time()}\n`);
        } catch (e) {
            logError(e, 'quartermaster: no pude dejar el pedido');
        }
    }

    destroy() {
        this._vigia?.cancel();
        this._vigia = null;
        super.destroy();
    }
});

export default class Quartermaster extends Extension {
    enable() {
        GLib.mkdir_with_parents(CARPETA, 0o755);
        this._boton = new Boton();
        Main.panel.addToStatusArea('quartermaster', this._boton, 0, 'right');
        // Recién acá: si se escribiera antes de que el item exista, qm podría
        // esconder el suyo y quedarían cero items en la barra.
        try {
            GLib.file_set_contents(VIVA, '');
        } catch (e) {
            logError(e, 'quartermaster: no pude avisar que estoy viva');
        }
    }

    disable() {
        // Primero el aviso: qm tiene que volver a mostrar su item ANTES de que
        // este desaparezca, para que no haya un momento sin nada arriba.
        try {
            GLib.unlink(VIVA);
        } catch (e) {
            // que no quede el item colgado por no poder borrar un archivo
        }
        this._boton?.destroy();
        this._boton = null;
    }
}
