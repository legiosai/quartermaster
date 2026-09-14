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


ambito: dict = {"datetime": datetime, "timezone": timezone, "ACTIVA_SEGUNDOS": 600}
for nombre in ("faltan", "_tope", "_ya_reinicio", "_activa_hace_poco", "_vale_preguntar"):
    exec(compile(funcion(nombre), "qm-indicator", "exec"), ambito)  # noqa: S102

# `_vale_preguntar` es un método y llama a `self._tope` y a `self._ya_reinicio`,
# así que se rearma la parte de la clase que necesita en vez de inventar un
# `self` falso.
class Indicador:
    _tope = staticmethod(ambito["_tope"])
    _ya_reinicio = staticmethod(ambito["_ya_reinicio"])
    _activa_hace_poco = staticmethod(ambito["_activa_hace_poco"])
    _vale_preguntar = ambito["_vale_preguntar"]


_vale = Indicador()._vale_preguntar


def iso(delta_horas: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=delta_horas)).isoformat()


def pieza(sesion=None, semanal=None, r_sesion=None, r_semanal=None, uso=None) -> dict:
    return {
        "perfil": ".claude", "sesion": sesion, "semanal": semanal,
        "reinicia_sesion": r_sesion, "reinicia_semanal": r_semanal,
        "ultimo_uso": uso,
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

    # La cuenta que estás usando ahora, esté donde esté el nivel.
    ("una cuenta al 2 % que se está usando AHORA: sí — es el caso del segundo bug",
     pieza(sesion=2, semanal=5, r_sesion=iso(3), r_semanal=iso(50), uso=iso(-0.02)), True),
    ("la misma cuenta al 2 %, sin tocar hace dos horas: no",
     pieza(sesion=2, semanal=5, r_sesion=iso(3), r_semanal=iso(50), uso=iso(-2)), False),
    ("una cuenta al 2 % sin dato de último uso: no se inventa actividad",
     pieza(sesion=2, semanal=5, r_sesion=iso(3), r_semanal=iso(50), uso=None), False),
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

# ── que el lazo no se pueda matar solo ────────────────────────────────────
#
# `calentar()` empieza soltando `self.reloj`. Si después devuelve False sin
# reprogramar, la fuente de GLib se quita y nadie la vuelve a armar: el
# indicador no le pregunta más al endpoint en lo que le queda de vida.
#
# Pasó de verdad el 2026-09-13, después de una suspensión de 4,1 h: proceso
# vivo, dibujando cada pocos minutos, con la cuota leída hacía 5,2 horas.
cuerpo_calentar = funcion("calentar")
rama = cuerpo_calentar.split("if self.calentando:", 1)
if len(rama) != 2:
    print("✗ no encontré la guarda `if self.calentando:` en calentar()", file=sys.stderr)
    fallas += 1
else:
    # Hasta el siguiente `args =`, que es donde sigue el camino normal.
    guarda = rama[1].split("args =", 1)[0]
    if "programar_calentado" not in guarda:
        print("✗ calentar() sale de `if self.calentando:` sin reprogramar: "
              "el lazo se muere y no vuelve a preguntar nunca más", file=sys.stderr)
        fallas += 1
    elif "CALENTADO_PLAZO_US" not in guarda:
        print("✗ la bandera `calentando` no tiene plazo: si el callback no llega "
              "—una suspensión en el medio— se queda pegada para siempre", file=sys.stderr)
        fallas += 1
    else:
        print("  ✓ un calentado en vuelo reprograma el lazo, y la bandera tiene plazo")

# ── que se entere de la suspensión ────────────────────────────────────────
if "PrepareForSleep" not in FUENTE or "vigilar_suspension()" not in FUENTE:
    print("✗ el indicador no escucha PrepareForSleep: al volver de suspender muestra "
          "los números de antes de dormir hasta el próximo sondeo, y el sondeo corre "
          "contra un reloj que no avanzó", file=sys.stderr)
    fallas += 1
else:
    print("  ✓ escucha PrepareForSleep y pregunta al volver")

# ── la barra de macOS dice lo mismo ───────────────────────────────────────
#
# AppKit no existe en el runner, así que la regla de Swift no se puede CORRER
# acá: se comprueba que esté escrita con las mismas tres piezas y que el
# calentado la use. Pasó de verdad: GNOME se arregló el 2026-09-13 y la barra
# siguió con `tope >= 40` a secas, mandando además nombres cortos que
# `--cuentas` no reconocía.
SWIFT = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
m = re.search(r"func valePreguntar\(.*?\n}\n", SWIFT, re.S)
if m is None:
    print("✗ bin/qm-barra.swift no tiene `func valePreguntar(`", file=sys.stderr)
    fallas += 1
else:
    regla = m.group(0)
    for pieza_swift, que in (
        ("reiniciaSesion", "la cuenta cuya ventana ya se reinició"),
        ("ultimoUso", "la cuenta que se está usando ahora"),
        ("< 100", "el corte de arriba mientras la ventana siga abierta"),
    ):
        if pieza_swift not in regla:
            print(f"✗ valePreguntar() de la barra no mira {que} (`{pieza_swift}`)", file=sys.stderr)
            fallas += 1
    if not re.search(r"ACTIVA_SEGUNDOS: TimeInterval = 600\b", SWIFT):
        print("✗ ACTIVA_SEGUNDOS de la barra no es 600, como en qm-indicator", file=sys.stderr)
        fallas += 1
    if not re.search(r"ultimas\.filter\s*(\(\s*)?\{?\s*valePreguntar", SWIFT):
        print("✗ el calentado de la barra no filtra con valePreguntar()", file=sys.stderr)
        fallas += 1
    elif not re.search(r"valePreguntar[^\n]*\.map\(\\\.perfil\)", SWIFT):
        print("✗ la barra no manda el nombre completo del perfil a --cuentas", file=sys.stderr)
        fallas += 1
    else:
        print("  ✓ la barra de macOS usa la misma regla y manda nombres que --cuentas entiende")

if fallas:
    print(f"\ngate de calentado: ROJO ({fallas})", file=sys.stderr)
    raise SystemExit(1)
print("gate de calentado: verde — la cuenta frenada vuelve a preguntar apenas pasa su reinicio")
