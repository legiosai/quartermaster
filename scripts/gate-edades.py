#!/usr/bin/env python3
"""Que cada barra de una lectura más vieja que su cuenta diga su propia edad.

Desde `qm --statusline` una cuenta puede mezclar lecturas: la sesión y la
semanal llegan por la statusline en cada prompt, y el resto de las barras
—weekly_scoped, las que no tienen clave propia— sigue siendo de la última
lectura del endpoint. `qm --json` lo dice con `medidoEn` por ventana (null = la
de la cuenta). El día que se escribió esto la barra que frenaba la cuenta Ultra
era justo una de esas: `iguana_necktie` al 44 %, de hace 24 minutos, al lado de
una cuenta que decía «última hace 10s». Un panel que sólo muestra la edad de la
cuenta presenta ese 44 % como si fuera de ahora.

Dos cosas, en las cuatro superficies:

  1. la barra con `medidoEn` dice «leída hace …» y la que no lo trae no repite
     nada (su edad ya está en el renglón de lecturas);
  2. el «viejo» del item de la barra es la edad de lo que se DIBUJA, no la de la
     cuenta: con la statusline encima la cuenta puede ser de recién y la sesión
     de una lectura de ayer.

GNOME se comprueba ejecutando el código; macOS, Windows y el tablero por el
texto, porque acá no hay AppKit, System.Drawing ni navegador.
"""

import importlib.machinery
import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def cargar():
    """bin/qm-indicator no termina en .py: hay que darle el loader a mano."""
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", str(RAIZ / "bin/qm-indicator")))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def hace(minutos: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutos)).isoformat().replace("+00:00", "Z")


def ventana(clave: str, grupo, pct: float, medido_en=None) -> dict:
    return {"clave": clave, "grupo": grupo, "nombre": clave, "porcentaje": pct,
            "preocupa": False, "reinicia": "2099-01-01T00:00:00.000Z", "medidoEn": medido_en}


def main() -> int:
    qmi = cargar()
    fallas = []

    # 1 · el panel: la barra de la lectura vieja dice su edad, las otras no.
    sesion = ventana("session", "session", 31)
    semanal = ventana("weekly_all", "weekly", 12)
    vieja = ventana("iguana_necktie", None, 44, hace(24))
    cuenta = {
        "perfil": ".claude", "producto": "claude",
        "cuota": {"estado": "ok", "origen": "statusline", "edadSegundos": 10,
                  "mostrar": [sesion, semanal, vieja], "frena": vieja,
                  "sesion": sesion, "semanal": semanal},
    }
    vista = qmi.VistaCuenta(cuenta, 0)
    pies = {b["nombre"]: b["pie"] for b in vista.barras}
    if "leída hace 24m" not in pies.get("iguana_necktie", ""):
        fallas.append(f"GNOME: la barra de la lectura vieja no dice su edad: {pies.get('iguana_necktie')!r}")
    if any("leída" in pies.get(k, "") for k in ("session", "weekly_all")):
        fallas.append("GNOME: una barra sin `medidoEn` propio repite una edad")

    # La cabecera, que suele mostrar justo esa barra.
    resumen = qmi.VistaResumen.desde({
        "frenaPrimero": {"perfil": ".claude", "ventana": vieja},
        "perfiles": [cuenta],
    })
    if resumen is None or resumen.medido_en != vieja["medidoEn"]:
        fallas.append("GNOME: la cabecera no se entera de la edad propia de la barra que encabeza")

    # 2 · el item: «viejo» es la edad de la ventana corta, no la de la cuenta.
    def pieza(corta_medida):
        ses = ventana("session", "session", 31, corta_medida)
        p = {"perfil": ".claude", "producto": "claude",
             "cuota": {"estado": "ok", "edadSegundos": 10, "sesion": ses, "semanal": semanal,
                       "frena": ses, "mostrar": [ses, semanal]}}
        return qmi.piezas_de({"perfiles": [p]})[0]

    if not pieza(hace(7 * 60))["viejo"]:
        fallas.append("GNOME: la sesión de hace 7 h no marca «viejo» porque la cuenta es de recién")
    if pieza(None)["viejo"]:
        fallas.append("GNOME: una sesión de la misma lectura que la cuenta (10 s) se marca «viejo»")

    # macOS, Windows y el tablero: por el texto.
    swift = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    if 'medidoEn: fecha(v["medidoEn"])' not in swift:
        fallas.append("bin/qm-barra.swift: no lee `medidoEn` de cada ventana")
    if '"leída hace \\(duracion(e))"' not in swift:
        fallas.append("bin/qm-barra.swift: el pie de la barra no dice su edad propia")
    if "$0?.edad(p.edadSegundos)" not in swift:
        fallas.append("bin/qm-barra.swift: el «viejo» del item volvió a ser la edad de la cuenta")

    tray = (RAIZ / "bin/qm-tray.ps1").read_text(encoding="utf-8")
    if "Escribir $g (PieBarra $v)" not in tray:
        fallas.append("bin/qm-tray.ps1: el pie de la barra no pasa por PieBarra (sin edad propia)")
    if "$v.PSObject.Properties['medidoEn']" not in tray:
        fallas.append("bin/qm-tray.ps1: lee `medidoEn` sin preguntar si está (StrictMode revienta con un qm viejo)")
    if "EdadDe $cuota.sesion $cuota" not in tray:
        fallas.append("bin/qm-tray.ps1: el «~» de la sesión volvió a ser la edad de la cuenta")

    tablero = (RAIZ / "src/render/tablero.html").read_text(encoding="utf-8")
    if tablero.count("edadPropia(v)") < 2:
        fallas.append("src/render/tablero.html: el medidor o el héroe no muestran la edad propia de la barra")

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1
    print("edades verificadas: cada barra de una lectura más vieja dice la suya, en las cuatro superficies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
