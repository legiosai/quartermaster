#!/usr/bin/env python3
"""Que la curva del panel dibuje hacia dónde vas, y que diga lo mismo que la frase.

Debajo de las barras, el panel de GNOME escribe el ritmo: «3.7 pts/h · 100 % en
15h56m — antes del reinicio». La curva de la barra que frena sigue esa misma
recta, punteada, desde el último punto hasta el reinicio. Si toca el 100 % antes,
el tramo que queda hasta el reinicio va en rojo y dice cuánto tiempo serías sin
cuota, que es lo que la frase no deja ver.

Cuatro casos, dibujados de verdad y leídos por lo que se escribió en la tarjeta:

  1. choca a días del reinicio: «sin cuota 2d5h», el 100 % con su hora y el
     reinicio con la suya;
  2. no choca: la recta termina en el reinicio con el porcentaje al que llegás;
  3. la serie está plana: no se proyecta nada;
  4. el techo ya pasó: no hay frase de ritmo, y tampoco recta. El dibujo y la
     frase salen de la misma condición y no pueden contradecirse.

Y nada se dibuja fuera de la tarjeta, que es lo primero que rompe un rótulo
puesto a mano.
"""

import importlib.machinery
import importlib.util
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cairo

RAIZ = Path(__file__).resolve().parent.parent
H = 3_600_000


def cargar():
    """bin/qm-indicator no termina en .py: hay que darle el loader a mano."""
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", str(RAIZ / "bin/qm-indicator")))
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


def iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def cuenta(desde: int, hasta: int, horas: float, ritmo: float | None, reinicio_h: float,
           techo_h: float | None = None) -> dict:
    """Una cuenta cuya semanal subió de `desde` a `hasta` en las últimas `horas`."""
    ahora = time.time() * 1000
    n = 20
    historia = [{"t": int(ahora - 30_000 - horas * H * (1 - i / (n - 1))),
                 "porcentaje": round(desde + (hasta - desde) * i / (n - 1))} for i in range(n)]
    semanal = {"clave": "weekly_all", "grupo": "weekly", "nombre": "weekly_all",
               "porcentaje": hasta, "preocupa": False, "reinicia": iso(ahora + reinicio_h * H)}
    if ritmo is None:
        proy = {"estado": "plano", "muestras": n}
    else:
        techo = ahora + (techo_h if techo_h is not None else (100 - hasta) / ritmo) * H
        proy = {"estado": "sube", "ritmoPuntosPorHora": ritmo, "techo": iso(techo),
                "chocasAntesDelReinicio": techo < ahora + reinicio_h * H, "muestras": n}
    return {
        "perfil": ".claude", "producto": "claude",
        "cuota": {"estado": "ok", "origen": "endpoint", "edadSegundos": 30,
                  "mostrar": [semanal], "frena": semanal, "semanal": semanal,
                  "historia": historia},
        "proyeccion": proy,
    }


def dibujar(qmi, p: dict):
    """La tarjeta dibujada de verdad; devuelve la vista, lo escrito y la imagen."""
    escrito: list[str] = []

    class Espia(qmi.Pluma):
        def escribir(self, x, y, texto, *a, **k):
            escrito.append(texto)
            return super().escribir(x, y, texto, *a, **k)

    vista = qmi.VistaCuenta(p, 0)
    medida = cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1)
    alto = int(vista.medir(Espia(cairo.Context(medida), qmi.FAMILIA))) + 2
    escrito.clear()
    sup = cairo.ImageSurface(cairo.FORMAT_ARGB32, qmi.ANCHO_PANEL, alto)
    cr = cairo.Context(sup)
    vista.pintar(cr, Espia(cr, qmi.FAMILIA), 0)
    sup.flush()
    return vista, escrito, sup


def fuera_de_la_tarjeta(qmi, sup) -> int:
    """Columnas con tinta a la derecha del borde de la tarjeta."""
    datos, paso = sup.get_data(), sup.get_stride()
    desde = qmi.ANCHO_PANEL - qmi.MARGEN + 2
    return sum(1 for y in range(sup.get_height()) for x in range(desde, qmi.ANCHO_PANEL)
               if datos[y * paso + x * 4 + 3] != 0)


def main() -> int:
    qmi = cargar()
    qmi.TEMA = qmi.Tema(True)
    fallas = []

    # 1 · choca: 59 puntos a 3.7 por hora son 15.9 h, y el reinicio está a 2d21h.
    p = cuenta(34, 41, 1.9, 3.7, reinicio_h=69.5, techo_h=69.5 - 53.5)
    vista, escrito, sup = dibujar(qmi, p)
    fut = vista.futuro
    if not fut:
        fallas.append("choca antes del reinicio y la curva no proyecta nada")
    else:
        if fut["p_fin"] != 100 or fut["techo"] is None:
            fallas.append(f"choca y la recta no termina en el techo: {fut!r}")
        techo = qmi.cuando_local(p["proyeccion"]["techo"])
        reinicio = qmi.cuando_local(p["cuota"]["frena"]["reinicia"])
        for esperado in ("sin cuota 2d5h", f"100 % {techo}", f"reinicio {reinicio}"):
            if esperado not in escrito:
                fallas.append(f"choca y la curva no dice «{esperado}»: {escrito!r}")
    if not vista.ritmo or "antes del reinicio" not in vista.ritmo:
        fallas.append(f"la frase del ritmo no dice que choca: {vista.ritmo!r}")
    if fuera_de_la_tarjeta(qmi, sup):
        fallas.append("la curva con la proyección dibuja fuera de la tarjeta")

    # 2 · no choca: 68 % a 4 pts/h con el reinicio a 2h40m termina en ~79 %.
    p = cuenta(62, 68, 1.5, 4.0, reinicio_h=2 + 40 / 60)
    vista, escrito, sup = dibujar(qmi, p)
    fut = vista.futuro
    reinicio = qmi.cuando_local(p["cuota"]["frena"]["reinicia"])
    if not fut:
        fallas.append("sube sin chocar y la curva no proyecta nada")
    else:
        if fut["techo"] is not None or not 78 <= fut["p_fin"] <= 80:
            fallas.append(f"sin chocar, la recta tiene que terminar en el reinicio cerca de 79 %: {fut!r}")
        if f"~79 % al reinicio · {reinicio}" not in escrito:
            fallas.append(f"sin chocar, la curva no dice a cuánto llegás al reinicio: {escrito!r}")
    if any(t.startswith(("sin cuota", "100 %")) for t in escrito):
        fallas.append(f"sin chocar, la curva habla de quedarse sin cuota: {escrito!r}")
    if fuera_de_la_tarjeta(qmi, sup):
        fallas.append("la curva sin chocar dibuja fuera de la tarjeta")

    # 3 · plana: ni recta ni rótulos de proyección.
    vista, escrito, _ = dibujar(qmi, cuenta(50, 51, 1.5, None, reinicio_h=30))
    if vista.futuro or any("al reinicio" in t or t.startswith("sin cuota") for t in escrito):
        fallas.append("una serie plana dibuja una proyección")

    # 4 · el techo ya pasó: sin frase y sin recta, las dos por la misma razón.
    vista, escrito, _ = dibujar(qmi, cuenta(90, 100, 1.5, 6.0, reinicio_h=30, techo_h=-0.2))
    if vista.ritmo or vista.futuro:
        fallas.append(f"con el techo en el pasado hay frase ({vista.ritmo!r}) o recta ({vista.futuro!r})")

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1
    print("proyección verificada: la curva sigue la recta del ritmo hasta el reinicio y marca el tiempo sin cuota")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
