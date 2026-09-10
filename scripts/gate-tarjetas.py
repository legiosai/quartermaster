"""Ninguna tarjeta del panel puede ser más alta que una pantalla.

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
    print(f"tarjetas: la más alta es {nombre} con {alto} px, bajo el techo de {TECHO}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
