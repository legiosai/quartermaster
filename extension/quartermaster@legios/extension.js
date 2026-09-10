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
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CARPETA = GLib.build_filenamev([GLib.get_user_cache_dir(), 'quartermaster']);
// Lo que qm acaba de dibujar: {icono, ancho, alto}.
const ESTADO = GLib.build_filenamev([CARPETA, 'estado.json']);
// Mientras esté FRESCO, qm esconde su propio item de AppIndicator: si no, quedan
// dos. Se le renueva la fecha cada tanto en vez de escribirlo y ya: si el shell
// se cae sin llamar a disable(), el archivo queda ahí y qm escondería su item
// para siempre — o sea, ningún icono en ningún lado, que es lo peor que puede
// pasar. Con la fecha, qm se da cuenta solo de que del otro lado no hay nadie.
const VIVA = GLib.build_filenamev([CARPETA, 'extension-viva']);
const LATIDO_SEGUNDOS = 30;
// Donde se deja el click.
const PEDIDO = GLib.build_filenamev([CARPETA, 'pedido']);

const Boton = GObject.registerClass(
class Boton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'quartermaster');

        this._imagen = new St.Bin({yAlign: Clutter.ActorAlign.CENTER});
        this.add_child(this._imagen);
        this._panel = null;
        this._estado = {};

        this._armarMenu();
        this._leer();

        this._vigia = Gio.File.new_for_path(ESTADO).monitor_file(
            Gio.FileMonitorFlags.NONE, null);
        this._vigia.connect('changed', () => this._leer());

        // Al abrir se le pide a qm que redibuje, así el panel que se ve es de
        // este momento y no del último refresco.
        this.menu.connect('open-state-changed', (_m, abierto) => {
            if (abierto)
                this._pedir('actualizar');
        });
    }

    _armarMenu() {
        // El panel entero es un actor del compositor y no una ventana de
        // XWayland. Ésa es toda la diferencia: una ventana o un menú de GTK no
        // logra sostener su agarre contra la actividad real del escritorio y se
        // cierra al tocarlo — medido con tres arquitecturas distintas. Acá rueda
        // y se cierra como cualquier menú del shell, porque ES uno.
        this._fila = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'qm-fila',
        });
        this._rodante = new St.ScrollView({
            hscrollbarPolicy: St.PolicyType.NEVER,
            vscrollbarPolicy: St.PolicyType.AUTOMATIC,
            overlayScrollbars: true,
            styleClass: 'qm-rodante',
        });
        this._lienzo = new St.Widget({xExpand: true, yExpand: true});
        if (this._rodante.set_child)
            this._rodante.set_child(this._lienzo);
        else
            this._rodante.add_actor(this._lienzo);
        this._fila.add_child(this._rodante);
        this.menu.addMenuItem(this._fila);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const actualizar = new PopupMenu.PopupMenuItem('Actualizar ahora');
        actualizar.connect('activate', () => this._pedir('actualizar'));
        this.menu.addMenuItem(actualizar);
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
        this._estado = datos;

        if (datos.icono && datos.ancho && datos.alto) {
            // El nombre del archivo alterna entre dos: el shell cachea la
            // textura por ruta, y reescribiendo siempre la misma el item se
            // quedaría con el dibujo viejo.
            this._imagen.set_style(
                `background-image: url("file://${datos.icono}");` +
                'background-size: contain;' +
                'background-repeat: no-repeat;' +
                `width: ${datos.ancho}px;` +
                `height: ${datos.alto}px;`);
            this.accessible_name = datos.descripcion ?? 'quartermaster';
        }

        if (!datos.panel || !datos.panelAncho || !datos.panelAlto) {
            this._fila.visible = false;
            return;
        }
        this._fila.visible = true;
        // El panel es más alto que muchas pantallas — ése es medio el punto— así
        // que se le da un techo y el resto rueda.
        const monitor = Main.layoutManager.primaryMonitor;
        const techo = Math.max(320, Math.floor((monitor?.height ?? 900) * 0.62));
        this._lienzo.set_style(
            `background-image: url("file://${datos.panel}");` +
            'background-size: contain;' +
            'background-repeat: no-repeat;' +
            `width: ${datos.panelAncho}px;` +
            `height: ${datos.panelAlto}px;`);
        this._rodante.set_style(
            `width: ${datos.panelAncho + 8}px;` +
            `max-height: ${Math.min(techo, datos.panelAlto)}px;`);
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
        this._latir();
        this._latido = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, LATIDO_SEGUNDOS, () => {
                this._latir();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _latir() {
        try {
            GLib.file_set_contents(VIVA, `${Date.now()}\n`);
        } catch (e) {
            logError(e, 'quartermaster: no pude avisar que estoy viva');
        }
    }

    disable() {
        if (this._latido) {
            GLib.source_remove(this._latido);
            this._latido = null;
        }
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
