#!/usr/bin/env python3
"""La apariencia minimalista del panel de GNOME (issue #27): que dibuje, con su
ancho, y que cada barra tenga la letra que dice el diseño.

Y lo más importante: que la básica no cambie. Quien no tocó nada tiene que
seguir viendo exactamente el panel de antes, así que el panel sin `apariencia`
y el panel con `apariencia: basica` tienen que salir píxel por píxel iguales.
"""

import importlib.machinery
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import cairo

RAIZ = Path(__file__).resolve().parent.parent
FIXTURE = RAIZ / "test/fixtures/panel.json"


def cargar():
    """bin/qm-indicator no termina en .py: hay que darle el loader a mano."""
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", str(RAIZ / "bin/qm-indicator")))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def main() -> int:
    qm = cargar()
    qm.TEMA = qm.Tema(True)
    qm.FAMILIA = "Sans"
    fallas = []

    # 1 · las letras
    casos = [
        ({"clave": "session", "grupo": "session", "alcance": None}, "s"),
        ({"clave": "five_hour", "grupo": None, "alcance": None}, "s"),
        ({"clave": "weekly_all", "grupo": "weekly", "alcance": None}, "w"),
        ({"clave": "weekly_scoped", "grupo": "weekly", "alcance": "Fable"}, "wf"),
        ({"clave": "weekly", "grupo": None, "alcance": None}, "w"),
        ({"clave": "nimbus_quill", "grupo": None, "alcance": None, "nombre": "nimbus_quill"}, "nimbu…"),
    ]
    for v, esperada in casos:
        if qm.letra_de(v) != esperada:
            fallas.append(f"la letra de {v['clave']} salió «{qm.letra_de(v)}» y tiene que ser «{esperada}»")

    datos = json.loads(FIXTURE.read_text())
    with tempfile.TemporaryDirectory() as tmp:
        # 2 · dibuja, con su ancho y con píxeles adentro
        mini = dict(datos, apariencia="minimalista")
        ruta = f"{tmp}/mini.png"
        alto = qm.capturar(mini, ruta)
        s = cairo.ImageSurface.create_from_png(ruta)
        crudo = bytes(s.get_data())
        pintados = sum(1 for i in range(3, len(crudo), 4) if crudo[i] != 0)
        if s.get_width() != qm.ANCHO_MINI:
            fallas.append(f"la minimalista salió de {s.get_width()} px y tiene que ser {qm.ANCHO_MINI}")
        if s.get_height() != alto or not 150 <= alto <= 1200:
            fallas.append(f"la minimalista salió de {s.get_height()} px de alto (dijo {alto})")
        if pintados < s.get_width() * s.get_height() // 2:
            fallas.append(f"la minimalista está casi vacía: {pintados} píxeles con algo")
        # Tiene que ser más corta que el panel completo: es la razón de existir.
        completo = qm.medir_panel(datos)
        if alto >= completo:
            fallas.append(f"la minimalista ({alto} px) no es más corta que el panel completo ({completo} px)")

        # 3 · la básica, idéntica a no haber elegido nada
        qm.capturar(datos, f"{tmp}/sin.png")
        qm.capturar(dict(datos, apariencia="basica"), f"{tmp}/basica.png")
        qm.capturar(dict(datos, apariencia="neon"), f"{tmp}/neon.png")
        sin = Path(f"{tmp}/sin.png").read_bytes()
        if Path(f"{tmp}/basica.png").read_bytes() != sin:
            fallas.append("el panel con apariencia «basica» no es idéntico al de siempre")
        if Path(f"{tmp}/neon.png").read_bytes() != sin:
            fallas.append("una apariencia desconocida no cae en el panel de siempre")

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1
    print(f"minimalista: {qm.ANCHO_MINI} px, letras s/w/wf, y la básica idéntica a la de siempre")
    return 0


if __name__ == "__main__":
    sys.exit(main())
