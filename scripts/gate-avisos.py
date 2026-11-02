#!/usr/bin/env python3
"""Que los avisos del escritorio se vayan solos, también el grave.

Hasta 0.1.21 el aviso grave de GNOME (frenada, o choque antes del reinicio)
salía con urgencia `critical` y sin vencimiento, y GNOME deja esos clavados en
pantalla hasta que alguien los cierra. Un aviso de cuota que tapa una esquina
durante horas se termina cerrando sin leer. Ahora todos son `normal` con
AVISO_MS, y lo grave se distingue por el ícono.

GNOME se comprueba ejecutando `Avisos.notificar` contra un bus de mentira y
mirando lo que le manda a org.freedesktop.Notifications. Windows y macOS, por
el texto: acá no hay System.Windows.Forms ni osascript.
"""

import importlib.machinery
import importlib.util
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
TECHO_MS = 15_000  # «unos segundos»: más que esto ya es quedarse


def cargar():
    """bin/qm-indicator no termina en .py: hay que darle el loader a mano."""
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", str(RAIZ / "bin/qm-indicator")))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


class BusDeMentira:
    def __init__(self) -> None:
        self.llamadas = []

    def call_sync(self, nombre, ruta, interfaz, metodo, parametros, *resto):
        self.llamadas.append((metodo, parametros.unpack()))
        return None


def main() -> int:
    qmi = cargar()
    fallas = []

    # 1 · GNOME: lo que de verdad sale por DBus, grave y normal.
    avisos = object.__new__(qmi.Avisos)  # sin __init__: no hay bus de sesión en CI
    avisos.bus = BusDeMentira()
    avisos.notificar("frenada", "main: weekly_all al 100 %", True)
    avisos.notificar("cerca", "main: weekly_all al 90 %", False)
    if len(avisos.bus.llamadas) != 2:
        fallas.append(f"GNOME: esperaba 2 llamadas a Notify, hubo {len(avisos.bus.llamadas)}")
    for (metodo, args), grave in zip(avisos.bus.llamadas, (True, False)):
        cual = "el grave" if grave else "el normal"
        _app, _reemplaza, icono, _titulo, _cuerpo, _acciones, pistas, vence = args
        if metodo != "Notify":
            fallas.append(f"GNOME: {cual} llamó a {metodo}, no a Notify")
        urgencia = pistas.get("urgency")
        if urgencia == 2:
            fallas.append(f"GNOME: {cual} sale con urgencia critical: GNOME lo deja clavado hasta que lo cerrás")
        if not 0 < vence <= TECHO_MS:
            fallas.append(f"GNOME: {cual} vence en {vence} ms (0 = nunca); tiene que irse en unos segundos")
        esperado = qmi.ICONO_GRAVE if grave else qmi.ICONO_AVISO
        if icono != esperado:
            fallas.append(f"GNOME: {cual} usa el ícono {icono!r}; lo grave se distingue por el ícono ({esperado!r})")

    # 2 · Windows: el mismo tiempo para los dos, y corto.
    ps1 = (RAIZ / "bin/qm-tray.ps1").read_text(encoding="utf-8")
    globos = re.findall(r"ShowBalloonTip\(([^,]+),", ps1)
    if not globos:
        fallas.append("Windows: no encontré ShowBalloonTip en bin/qm-tray.ps1")
    for arg in globos:
        if arg.strip() != "$AVISO_MS":
            fallas.append(f"Windows: ShowBalloonTip({arg.strip()}, …) no usa $AVISO_MS")
    m = re.search(r"^\$AVISO_MS = (\d+)\s*$", ps1, re.M)
    if not m or not 0 < int(m.group(1)) <= TECHO_MS:
        fallas.append(f"Windows: $AVISO_MS = {m.group(1) if m else 'falta'}; tiene que ser unos segundos")

    # 3 · macOS: un banner (`display notification`), nunca un diálogo que espera un click.
    swift = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    if "display notification" not in swift:
        fallas.append("macOS: bin/qm-barra.swift ya no avisa con `display notification`")
    if re.search(r"display (alert|dialog)", swift):
        fallas.append("macOS: bin/qm-barra.swift usa `display alert`/`display dialog`, que se queda hasta un click")

    for f in fallas:
        print(f"✗ {f}", file=sys.stderr)
    if fallas:
        return 1
    print("gate de avisos: verde — los avisos se van solos en GNOME, Windows y macOS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
