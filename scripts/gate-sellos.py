#!/usr/bin/env python3
"""Que el nombre de cada dibujo no se repita nunca.

Cada refresco del indicador escribe un PNG nuevo y le deja la ruta a la
extensión de GNOME Shell. El shell cachea la textura POR RUTA y sólo suelta la
entrada vieja cuando su propio GFileMonitor le avisa que el archivo cambió: ese
aviso llega después de que la extensión ya leyó estado.json y pintó, y no vuelve
a pintar solo. O sea que reescribir una ruta que el shell ya vio deja el item
mostrando el dibujo anterior, y ahí se queda hasta que algo lo obliga a releer.

Pasarle el mouse por arriba lo obliga: el hover recalcula el estilo. Por eso el
bug se veía como «los números cambian cuando paso el mouse por la barra» — no
los cambiaba el hover, los destapaba.

Antes había una rotación de dos nombres (`barra-0.png` / `barra-1.png`) puesta
justamente para esquivar ese cache. No alcanza: con dos nombres, uno de cada dos
refrescos vuelve a caer sobre una ruta que el cache ya tiene. Hoy el nombre
lleva un sello que no se repite, y esto es lo que lo comprueba.
"""

import importlib.machinery
import importlib.util
import sys

# Son muchos y seguidos a propósito: así es como se pisan dos lecturas del reloj
# si la máquina no tiene la resolución que `time_ns` promete.
CUANTOS = 20_000


def cargar():
    """bin/qm-indicator no termina en .py: hay que darle el loader a mano."""
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", "bin/qm-indicator"))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def main() -> int:
    qmi = cargar()
    fallas = []

    sellos = [qmi.sello_nuevo() for _ in range(CUANTOS)]
    repetidos = len(sellos) - len(set(sellos))
    if repetidos:
        fallas.append(f"{repetidos} sellos repetidos de {CUANTOS}: dos dibujos "
                      "distintos compartirían nombre")
    if sellos != sorted(sellos):
        fallas.append("los sellos no siempre crecen")

    # Y con el reloj movido para atrás, que es lo que hace un ajuste de NTP.
    # Sin la guardia, el sello vuelve a un número ya usado y el nombre se repite.
    ultimo = sellos[-1]
    qmi.time.time_ns = lambda: 1
    if qmi.sello_nuevo() <= ultimo:
        fallas.append("con el reloj para atrás el sello vuelve a uno ya usado")

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1

    print(f"sellos: {CUANTOS} seguidos sin repetir uno, y un reloj que salta "
          "para atrás no los rompe")
    return 0


if __name__ == "__main__":
    sys.exit(main())
