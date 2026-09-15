// El item de quartermaster en la barra de arriba de GNOME — variante 43/44.
//
// POR QUÉ HAY DOS COPIAS DE ESTO. `extension/quartermaster@legios/` es la
// versión viva, escrita contra la API que GNOME estrenó en la 45: módulos ESM
// (`import`) y una clase que extiende `Extension`. La 43 y la 44 no entienden
// nada de eso — cargan extensiones con `imports.gi` y llaman a una función
// `init()` suelta. No es una diferencia de detalle que se pueda tapar con un
// `if`: son dos sintaxis de módulo que no conviven en un archivo.
//
// Así que esto es la MISMA extensión con el envoltorio viejo. El cuerpo —cómo
// se pinta el item, cómo se arma el menú, cómo se habla con qm-indicator— es
// idéntico a propósito, para que un arreglo en uno se pueda leer y copiar en el
// otro sin traducir.
//
// Debian 12 es la razón concreta de que exista: trae GNOME 43 y va a seguir
// soportada años. Sin esto, en Debian estable el item cae al camino de
// AppIndicator, y ahí pasan las dos cosas que esta extensión evita: el PNG
// ancho del medidor entra en una casilla cuadrada de 16 px y se ve minúsculo, y
// el click se lo queda el menú del shell, que le rompe el agarre al menú de GTK
// de qm-indicator — el panel aparece y desaparece en el mismo instante.
//
// ── y lo de siempre ──────────────────────────────────────────────────────
//
// Esta extensión NO sabe qué es una cuota. Hace dos cosas: muestra el PNG que
// dibuja `bin/qm-indicator` y, cuando le hacen click, deja un pedido en un
// archivo para que ese proceso abra su panel. Todo el dibujo y todos los
// números viven allá.

const {Clutter, Gio, GLib, GObject, St} = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

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

        this._imagen = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._imagen);
        this._panel = null;
        this._estado = {};

        this._armarMenu();
        this._leer();

        this._vigia = Gio.File.new_for_path(ESTADO).monitor_file(
            Gio.FileMonitorFlags.NONE, null);
        this._idVigia = this._vigia.connect('changed', () => this._leer());

        // Al abrir se le pide a qm que redibuje, así el panel que se ve es de
        // este momento y no del último refresco.
        this._idMenu = this.menu.connect('open-state-changed', (_m, abierto) => {
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
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            style_class: 'qm-rodante',
        });
        // El hijo de un St.ScrollView tiene que implementar StScrollable, y un
        // St.Widget pelado NO lo implementa. St.BoxLayout sí — comprobado
        // también contra el typelib de esta versión (St-1.0 con Clutter-11):
        //
        //   St.BoxLayout implementa: ... Scrollable
        //
        // En 43 el ScrollView todavía no tiene `set_child`: se le cuelga el hijo
        // con `add_actor`, que es lo que hace la rama de abajo. La misma rama
        // está en la versión 45+ al revés, así que el archivo se lee igual en
        // las dos.
        this._lienzo = new St.Widget({x_expand: true, y_expand: true});
        this._caja = new St.BoxLayout({x_expand: true, y_expand: true});
        this._caja.add_child(this._lienzo);
        // `add_actor` SIEMPRE, sin preguntar si existe `set_child`.
        //
        // Preguntar era el error. En la 43 el St.ScrollView hereda `set_child`
        // de St.Bin, así que la pregunta da que sí y se toma el camino de la
        // 46 — pero acá `set_child` cuelga el actor como un hijo cualquiera y
        // NO lo registra como el contenido que se rueda, que es lo que hace el
        // `add` del ClutterContainer al que llega `add_actor`. El ScrollView se
        // queda sin contenido y dibuja nada más que su barra de rodar.
        //
        // Del lado del usuario eso se ve como un menú que abre bien y aparece
        // vacío, con una rayita gris arriba a la izquierda. Comprobado contra
        // el typelib de esta versión:
        //
        //   St.ScrollView  set_child=no
        //   St.Bin         set_child=SÍ   <- de acá lo hereda
        //
        // Este archivo es SÓLO para 43 y 44, así que no hay nada que detectar:
        // en las dos el camino correcto es el mismo.
        this._rodante.add_actor(this._caja);
        this._fila.add_child(this._rodante);
        this.menu.addMenuItem(this._fila);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const actualizar = new PopupMenu.PopupMenuItem('Actualizar ahora');
        actualizar.connect('activate', () => this._pedir('actualizar'));
        this.menu.addMenuItem(actualizar);
    }

    _leer() {
        // ASÍNCRONO, y no por elegancia: esto corre ADENTRO del proceso de
        // GNOME Shell, que es el compositor. Una lectura sincrónica que se
        // demore —un disco ocupado, un cache en un filesystem lento— congela el
        // escritorio entero, no sólo este item.
        Gio.File.new_for_path(ESTADO).load_contents_async(null, (archivo, res) => {
            let datos;
            try {
                const [ok, bytes] = archivo.load_contents_finish(res);
                if (!ok)
                    return;
                datos = JSON.parse(new TextDecoder().decode(bytes));
            } catch (e) {
                return;  // sin estado no hay nada que mostrar todavía
            }
            this._pintar(datos);
        });
    }

    /** Lo que antes hacía la segunda mitad de _leer(), ya con los datos. */
    _pintar(datos) {
        this._estado = datos;

        if (datos.icono && datos.ancho && datos.alto) {
            // Acá está la mitad del arreglo en Debian: el ancho y el alto salen
            // del JSON, que es lo que qm DIBUJÓ. AppIndicator no puede hacer
            // esto —mete cualquier icono en una casilla cuadrada— y por eso un
            // medidor de 44×22 se ve como una mancha.
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
        // Las dos señales primero, el monitor después: desconectar algo que ya
        // no existe es un error, y cancelar un monitor cuyo handler sigue
        // conectado deja el handler colgado del objeto.
        if (this._idMenu) {
            this.menu.disconnect(this._idMenu);
            this._idMenu = null;
        }
        if (this._idVigia && this._vigia) {
            this._vigia.disconnect(this._idVigia);
            this._idVigia = null;
        }
        if (this._vigia)
            this._vigia.cancel();
        this._vigia = null;
        super.destroy();
    }
});

// El envoltorio viejo: una clase suelta y un `init()` que la devuelve. En 45+
// esto mismo es `export default class Quartermaster extends Extension`.
class Quartermaster {
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
        if (this._boton)
            this._boton.destroy();
        this._boton = null;
    }
}

function init() {
    return new Quartermaster();
}
