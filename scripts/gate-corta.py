#!/usr/bin/env python3
"""Que una cuenta sin sesión de 5 h igual tenga número y medidor en la barra.

El item de la barra dibuja, por cuenta, un medidor y un número: los dos son la
ventana CORTA, la que contesta «¿puedo seguir trabajando ahora?». Casi siempre
es la sesión de 5 h. Pero hay planes que no la tienen —Codex Pro, medido el
2026-09-27: `sesion: null` y sólo `weekly_all` al 27 %— y la barra leía la
sesión a secas: la cuenta quedaba con la pista vacía y sin número, como si no
tuviera cuota, cuando la semanal era justamente la que la iba a frenar.

Esto comprueba las tres superficies: GNOME ejecutando el código de verdad, y la
barra de macOS y la bandeja de Windows por el texto, porque acá no hay AppKit ni
System.Drawing para correrlas.
"""

import importlib.machinery
import importlib.util
import sys
import tempfile
from pathlib import Path

import cairo

RAIZ = Path(__file__).resolve().parent.parent


def cargar():
    """bin/qm-indicator no termina en .py: hay que darle el loader a mano."""
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", str(RAIZ / "bin/qm-indicator")))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def ventana(clave: str, grupo: str, pct: float) -> dict:
    return {"clave": clave, "grupo": grupo, "nombre": clave, "porcentaje": pct,
            "preocupa": False, "reinicia": "2099-01-01T00:00:00.000Z"}


def perfil(nombre: str, producto: str, sesion, semanal) -> dict:
    frena = max((v for v in (sesion, semanal) if v), key=lambda v: v["porcentaje"])
    return {
        "perfil": nombre, "producto": producto,
        "cuota": {"estado": "ok", "sesion": sesion, "semanal": semanal,
                  "frena": frena, "mostrar": [v for v in (sesion, semanal) if v]},
    }


def pintados(ruta: str) -> int:
    datos = bytes(cairo.ImageSurface.create_from_png(ruta).get_data())
    return sum(1 for i in range(3, len(datos), 4) if datos[i] != 0)


def main() -> int:
    qmi = cargar()
    fallas = []

    con_sesion = perfil(".claude", "claude",
                        ventana("session", "session", 14), ventana("weekly_all", "weekly", 4))
    sin_sesion = perfil("codex", "codex", None, ventana("weekly_all", "weekly", 27))
    a, b = qmi.piezas_de({"perfiles": [con_sesion, sin_sesion]})

    if qmi._numero_de(a) != "14":
        fallas.append(f"con sesión, el número tiene que ser la sesión (14) y es {qmi._numero_de(a)!r}")
    if qmi._numero_de(b) != "27":
        fallas.append(f"sin sesión, el número tiene que ser la semanal (27) y es {qmi._numero_de(b)!r}")

    # Y que el medidor tenga algo adentro: la misma cuenta dibujada sin ninguna
    # ventana es la pista vacía, y la de 27 % tiene que pintar más que eso.
    vacia = dict(b, corta=None)
    with tempfile.TemporaryDirectory() as d:
        qmi.dibujar_item([b], f"{d}/con.png")
        qmi.dibujar_item([vacia], f"{d}/vacia.png")
        if pintados(f"{d}/con.png") <= pintados(f"{d}/vacia.png"):
            fallas.append("sin sesión, el medidor quedó vacío: la semanal no llegó al dibujo")

    swift = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    if "var corta: Int? { sesion ?? semanal }" not in swift:
        fallas.append("bin/qm-barra.swift: la ventana corta ya no cae en la semanal sin sesión")
    elif "barra(xb, t.sesion" in swift or "let s = t.sesion" in swift:
        fallas.append("bin/qm-barra.swift: el medidor o el número volvieron a leer la sesión a secas")

    tray = (RAIZ / "bin/qm-tray.ps1").read_text(encoding="utf-8")
    if "$corta = if ($null -ne $ses) { $ses } else { $sem }" not in tray:
        fallas.append("bin/qm-tray.ps1: la ventana corta ya no cae en la semanal sin sesión")

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1
    print("ventana corta verificada: sin sesión, la barra muestra la semanal en las tres superficies")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
