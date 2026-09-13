"""A qué cuentas se les pregunta en el próximo calentado.

POR QUÉ EXISTE. `cadencia()` tiene un argumento correcto y escrito: una barra
en 100 % no puede subir, y el instante del reinicio ya lo sabemos sin
preguntar, así que no hay que sondearla cada minuto. Eso es un argumento sobre
CADA CUÁNTO. Se había colado en `calentar()` como un argumento sobre A QUIÉN
—`40 <= tope < 100`— y ahí es un bug: la cuenta frenada quedaba fuera de todos
los calentados, o sea que la única que no podía enterarse de que se liberó era
justo la que estaba esperando liberarse.

Medido el 2026-09-13 en una cuenta real: weekly_all 96 % y weekly_scoped 100 %,
las dos `critical`, con el `resets_at` dos horas atrás. Nueve horas diciendo
«estás frenado» a alguien que estaba libre. Un solo
`qm --calentar --cuentas=…` devolvió 2 % y 0 %, las dos `normal`.

Se ejecuta el código DE VERDAD, sacado de bin/qm-indicator, y no una copia:
una regla copiada a un test es una regla que se puede editar en un solo lado.
Probado en rojo: `make gate-calentado-rojo`.
"""

import pathlib
import re
import sys
import textwrap
from datetime import datetime, timedelta, timezone

RAIZ = pathlib.Path(__file__).resolve().parent.parent
FUENTE = (RAIZ / "bin/qm-indicator").read_text(encoding="utf-8")


def funcion(nombre: str) -> str:
    r"""El cuerpo de un `def`, desde su línea hasta el primer renglón que vuelve
    a un sangrado menor o igual. Sirve para métodos y para funciones sueltas.

    La sangría se mide con `[ \t]*` y no con `\s*`: `\s` incluye el salto de
    línea, así que la versión con `\s*` empezaba a contar desde el renglón
    anterior y devolvía una sangría absurda —o directamente no encontraba el
    método—. Se notó porque este gate extraía la cadena vacía y no se quejaba.
    """
    m = re.search(rf"^([ \t]*)def {re.escape(nombre)}\(", FUENTE, re.MULTILINE)
    if m is None:
        raise SystemExit(f"✗ no encontré `def {nombre}(` en bin/qm-indicator")
    sangria, i = len(m.group(1)), m.start()
    lineas = FUENTE[i:].splitlines()
    corte = len(lineas)
    for n, linea in enumerate(lineas[1:], start=1):
        if linea.strip() and (len(linea) - len(linea.lstrip())) <= sangria:
            corte = n
            break
    cuerpo = textwrap.dedent("\n".join(lineas[:corte]))
    if not cuerpo.strip():
        raise SystemExit(f"✗ `{nombre}` salió vacía de bin/qm-indicator: la extracción está rota")
    return cuerpo


ambito: dict = {"datetime": datetime, "timezone": timezone}
for nombre in ("faltan", "_tope", "_ya_reinicio", "_vale_preguntar"):
    exec(compile(funcion(nombre), "qm-indicator", "exec"), ambito)  # noqa: S102

# `_vale_preguntar` es un método y llama a `self._tope` y a `self._ya_reinicio`,
# así que se rearma la parte de la clase que necesita en vez de inventar un
# `self` falso.
class Indicador:
    _tope = staticmethod(ambito["_tope"])
    _ya_reinicio = staticmethod(ambito["_ya_reinicio"])
    _vale_preguntar = ambito["_vale_preguntar"]


_vale = Indicador()._vale_preguntar


def iso(delta_horas: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=delta_horas)).isoformat()


def pieza(sesion=None, semanal=None, r_sesion=None, r_semanal=None) -> dict:
    return {
        "perfil": ".claude", "sesion": sesion, "semanal": semanal,
        "reinicia_sesion": r_sesion, "reinicia_semanal": r_semanal,
    }


CASOS = [
    # (qué es, pieza, se le pregunta?)
    ("una cuenta tranquila al 9 % no gasta un pedido",
     pieza(sesion=9, semanal=9, r_sesion=iso(2), r_semanal=iso(50)), False),
    ("una cuenta al 60 %, con su ventana abierta, sí",
     pieza(sesion=60, semanal=30, r_sesion=iso(2), r_semanal=iso(50)), True),
    ("una cuenta frenada al 100 % con la ventana TODAVÍA abierta, no: no puede subir",
     pieza(sesion=20, semanal=100, r_sesion=iso(2), r_semanal=iso(50)), False),
    ("una cuenta frenada al 100 % cuya semanal YA se reinició: SÍ — es el caso del bug",
     pieza(sesion=20, semanal=100, r_sesion=iso(2), r_semanal=iso(-2)), True),
    ("una cuenta al 9 % cuya sesión ya se reinició también: el número es de otra ventana",
     pieza(sesion=9, semanal=9, r_sesion=iso(-1), r_semanal=iso(50)), True),
    ("sin fecha de reinicio no se puede afirmar que venció",
     pieza(sesion=100, semanal=100, r_sesion=None, r_semanal=None), False),
]

fallas = 0
for que, t, esperado in CASOS:
    real = _vale(t)
    if real is esperado:
        print(f"  ✓ {que}")
    else:
        print(f"✗ {que}\n    esperaba {esperado} y dio {real}", file=sys.stderr)
        fallas += 1

# Y que el corte de arriba haya desaparecido de verdad del filtro. Si alguien
# reintroduce `< 100` en calentar(), los casos de arriba lo cazan igual, pero
# este mensaje dice DÓNDE.
if re.search(r"mueven\s*=.*<\s*100", FUENTE):
    print("✗ calentar() volvió a filtrar por `< 100`: la cuenta frenada no se entera de que se liberó",
          file=sys.stderr)
    fallas += 1

if fallas:
    print(f"\ngate de calentado: ROJO ({fallas})", file=sys.stderr)
    raise SystemExit(1)
print("gate de calentado: verde — la cuenta frenada vuelve a preguntar apenas pasa su reinicio")
