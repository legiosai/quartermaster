"""Dos invariantes del panel que no avisan cuando se rompen.

1 · Ninguna tarjeta puede ser más alta que una pantalla.
2 · Nada se dibuja fuera de la tarjeta.

El panel de GNOME es un `Gtk.Menu`, y un menú rueda ITEM por item: con un solo
item más alto que la pantalla no hay nada que rodar y el menú directamente no
abre — sin un error, sin un log, sin nada. Pasó de verdad: el panel creció a
946 px en un monitor cuya área útil son 728 y dejó de abrirse. Partirlo en una
tarjeta por cuenta lo arregló, pero sólo mientras ninguna tarjeta sola se pase.
"""

import importlib.machinery
import importlib.util
import sys

# El alto útil más chico que se puede esperar: una pantalla de 768 menos la
# barra de arriba y algo de aire.
TECHO = 700


def main() -> int:
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", "bin/qm-indicator"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    m.TEMA = m.Tema(True)
    m.FAMILIA = m.familia_del_sistema()

    pluma = m._pluma_de_medir()
    _, vistas = m.modelo_panel(m.leer_desde("test/fixtures/panel.json"))
    altos = [(type(v).__name__, round(v.medir(pluma))) for v in vistas]
    if not altos:
        print("GATE ROJO: el fixture no produjo ni una tarjeta", file=sys.stderr)
        return 1
    nombre, alto = max(altos, key=lambda x: x[1])
    if alto > TECHO:
        print(f"GATE ROJO: la tarjeta {nombre} mide {alto} px y no entra en una "
              f"pantalla de {TECHO} px útiles: el menú no va a abrir", file=sys.stderr)
        return 1

    if not margen_limpio(m):
        return 1

    print(f"tarjetas: la más alta es {nombre} con {alto} px, bajo el techo de {TECHO}; "
          f"y nada se sale del margen")
    return 0


def margen_limpio(m) -> bool:
    """Que ningún texto se dibuje fuera de la tarjeta.

    Cairo no recorta nada: un nombre de perfil más largo que la tarjeta se
    dibujaba por encima del borde y salía del panel. Se comprueba con el fixture
    de nombres largos, midiendo píxeles en la franja de afuera —que tiene que
    quedar exactamente del color del fondo— en vez de mirar la imagen a ojo.
    """
    import cairo

    datos = m.leer_desde("test/fixtures/panel-largos.json")
    alto = m.medir_panel(datos)
    sup = cairo.ImageSurface(cairo.FORMAT_ARGB32, m.ANCHO_PANEL, alto)
    cr = cairo.Context(sup)
    m.fondo_panel(cr, m.ANCHO_PANEL, alto)
    m.dibujar_panel(cr, datos, alto)
    sup.flush()

    pix = bytes(sup.get_data())
    stride = sup.get_stride()
    fondo = pix[(alto // 2) * stride + 4 * 4:(alto // 2) * stride + 4 * 4 + 4]
    # Dos píxeles adentro del borde de la tarjeta hacia afuera: ahí no va nada.
    # Arriba y abajo se saltan 18 px porque ahí está la curva de la esquina
    # redondeada del panel, que sí pasa por esa franja y no es un desborde.
    desde = m.ANCHO_PANEL - m.MARGEN + 2
    for y in range(18, alto - 18):
        fila = y * stride
        for x in range(desde, m.ANCHO_PANEL - 2):
            if pix[fila + x * 4:fila + x * 4 + 4] != fondo:
                print(f"GATE ROJO: hay algo dibujado en x={x}, fuera de la tarjeta "
                      f"(el margen empieza en {desde}): un texto largo se está "
                      f"saliendo en vez de cortarse", file=sys.stderr)
                return False
    return True


if __name__ == "__main__":
    raise SystemExit(main())
