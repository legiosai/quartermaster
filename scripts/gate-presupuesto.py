"""Las cinco frases de presupuesto tienen que decir los mismos números.

0.1.11 arregló en cinco lugares a la vez el mismo error: `porDia` sale del
porcentaje de AHORA, que ya tiene adentro lo gastado hoy, y las cinco pantallas
le restaban lo gastado otra vez. El núcleo pasó a mandar la resta hecha
(`porDiaHoy` y `restanteMedido`) y las cinco pasaron a leerla.

Lo que quedó sin comprobar es que sigan leyéndola. Medido el 2026-09-14, con el
árbol en `c910137`: se volvió a poner en `bin/qm-indicator` exactamente el doble
descuento que 0.1.11 había sacado —`porDia` en vez de `porDiaHoy`, la resta a
mano en vez de `restanteMedido`— y `make gate-dibujo`, `gate-tarjetas` y los 148
tests quedaron en verde. La regresión que costó una release entera volvía a
entrar sin que nada se pusiera rojo, porque `test/fixtures/panel.json` no traía
los campos nuevos: los tres gates que dibujan entraban siempre por la rama de
respaldo, la del `qm` anterior.

Es la misma historia que `gate-duraciones`: una regla escrita en cinco
comentarios y en ningún lado comprobada. Ahí convivieron dos convenciones
durante meses; acá el número que se compara es el que dice cuánto podés gastar.

El canon está congelado en test/fixtures/presupuesto.json, sacado corriendo el
núcleo. Cada implementación se EJECUTA con el mismo JSON y se compara contra esa
tabla. Las que no tienen intérprete en esta máquina se saltean diciéndolo —
nunca se dan por buenas en silencio.

Dos cosas que este gate NO compara, y las dice en la salida en vez de
esconderlas:

  - **el separador decimal.** El tablero escribe «16,1» y las otras cuatro
    «16.1». Los números se comparan como números; que el tablero use coma es una
    diferencia de dibujo que hay que decidir, no un rojo que este gate invente.
  - **la barra de macOS.** Su frase no está en una función: está adentro de un
    `switch` en el inicializador de una vista, así que no se puede extraer y
    correr como las otras cuatro, y no hay runner de macOS en el CI. De ella se
    comprueba la REDACCIÓN de los tres `String(format:)` contra el canon, que es
    lo que se puede medir desde acá. No es lo mismo que ejecutarla y se dice.

La hora de `medidoDesde` la escribe cada pantalla con el reloj de la máquina, así
que no se compara contra un string congelado: se exige que las pantallas digan
LA MISMA, que es la invariante que importa. El tablero llegó a decir «11:54 a.
m.» mientras las otras cuatro decían «11:54».
"""

import importlib.machinery
import importlib.util
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parent.parent
TABLA = json.loads((RAIZ / "test/fixtures/presupuesto.json").read_text(encoding="utf-8"))
CASOS = TABLA["casos"]


def bloque(ruta: pathlib.Path, arranque: str, abre: str = "{", cierra: str = "}") -> str:
    """El cuerpo de una función, contando llaves desde su primera línea."""
    texto = ruta.read_text(encoding="utf-8")
    i = texto.index(arranque)
    nivel, j = 0, i
    while True:
        if texto[j] == abre:
            nivel += 1
        elif texto[j] == cierra:
            nivel -= 1
            if nivel == 0:
                return texto[i:j + 1]
        j += 1


# ── cómo se compara ──────────────────────────────────────────────────────
#
# El núcleo escribe UN renglón; los que dibujan escriben DOS, y le pegan al
# primero el nombre de la ventana («· weekly_all») porque la tarjeta muestra
# tres barras y el número reparte una sola. Ninguna de las dos cosas es una
# diferencia de lo que se dice: se normalizan y se compara la frase.
HORA = re.compile(r"\d{2}:\d{2}")


def frase(renglones: list[str], barra: str | None) -> str:
    texto = " · ".join(r for r in renglones if r)
    if barra:
        texto = texto.replace(f" · {barra}", "")
    return " ".join(texto.split())


def numeros(texto: str) -> list[float]:
    """Los números de la frase, en orden, con coma o con punto."""
    sin_hora = HORA.sub("", texto)
    return [float(n.replace(",", ".")) for n in re.findall(r"\d+[.,]\d", sin_hora)]


def rama(texto: str) -> str:
    if "de acá a medianoche" in texto:
        return "reparto"
    if "desde las" in texto:
        return "medido"
    if "hoy" in texto:
        return "hoy"
    return "?"


# ── las implementaciones ─────────────────────────────────────────────────
def por_typescript(casos: list[dict]) -> list[str | None]:
    """El núcleo. `frasePresupuesto` come el Presupuesto de adentro, no el JSON,
    así que se le arma uno con los campos que la frase usa. Un caso sin
    `porDiaHoy` es un JSON que el núcleo NUNCA emite —es el de un qm anterior—,
    y ahí no se lo llama: contestar por él sería inventar."""
    entradas = []
    for c in casos:
        e = c["entrada"]
        if e.get("porDiaHoy") is None:
            entradas.append(None)
            continue
        entradas.append({
            "estado": e["estado"],
            "motivo": e.get("motivo"),
            "porDiaHoy": e["porDiaHoy"],
            "quedaHoy": e["quedaHoy"],
            "gastadoHoy": e["gastadoHoy"],
            "restanteHoy": e["restanteHoy"],
            "gastadoMedido": e["gastadoMedido"],
            "restanteMedido": e["restanteMedido"],
            "medidoDesde": None if e["medidoDesde"] is None else e["medidoDesde"],
        })
    guion = (
        "import {frasePresupuesto} from './src/core/presupuesto.ts';"
        f"const cs={json.dumps(entradas)};"
        "console.log(JSON.stringify(cs.map(c=>c===null?null:frasePresupuesto("
        "{...c, medidoDesde: c.medidoDesde===null?null:new Date(c.medidoDesde).getTime()}))));"
    )
    r = subprocess.run(["node", "--experimental-strip-types", "-e", guion],
                       cwd=RAIZ, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "node falló")
    return json.loads(r.stdout)


def por_python(casos: list[dict]) -> list[str | None]:
    """El indicador de GNOME."""
    spec = importlib.util.spec_from_loader(
        "qmi", importlib.machinery.SourceFileLoader("qmi", str(RAIZ / "bin/qm-indicator")))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return [frase(m.renglones_presupuesto(c["entrada"]), c["entrada"].get("barra")) for c in casos]


def por_powershell(casos: list[dict]) -> list[str | None]:
    """La bandeja de Windows. Con StrictMode, como corre de verdad: leer una
    propiedad que no está es una excepción, y es justo lo que pasa con el JSON
    de un qm anterior."""
    fn = bloque(RAIZ / "bin/qm-tray.ps1", "function RenglonesPresupuesto($pre) {")
    entradas = json.dumps([c["entrada"] for c in casos])
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "p.ps1"
        datos = pathlib.Path(d) / "casos.json"
        datos.write_text(entradas, encoding="utf-8")
        salida = pathlib.Path(d) / "dicho.json"
        # La frase va a un archivo en UTF-8 y no por stdout: el Windows
        # PowerShell escribe la consola en la codepage de la máquina, y el `·`
        # y los acentos vuelven rotos o no vuelven. Un gate que compara frases
        # no puede depender de qué codepage tiene el runner.
        p.write_text(
            "Set-StrictMode -Version Latest\n"
            "$ErrorActionPreference = 'Stop'\n"
            f"{fn}\n"
            f"$casos = Get-Content -Raw -Encoding UTF8 '{datos}' | ConvertFrom-Json\n"
            "$dicho = foreach ($c in $casos) { ,@(RenglonesPresupuesto $c) }\n"
            "$json = $dicho | ConvertTo-Json -Depth 4\n"
            f"[System.IO.File]::WriteAllText('{salida}', $json, "
            "(New-Object System.Text.UTF8Encoding $false))\n",
            encoding="utf-8")
        # `-ExecutionPolicy Bypass` sólo existe en Windows: en el pwsh de Linux
        # es un parámetro que no está y el proceso ni arranca.
        orden = [EXE_PS, "-NoProfile"]
        if sys.platform == "win32":
            orden += ["-ExecutionPolicy", "Bypass"]
        r = subprocess.run(orden + ["-File", str(p)],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "powershell falló")
        dicho = json.loads(salida.read_text(encoding="utf-8"))
    return [frase(list(d), c["entrada"].get("barra")) for d, c in zip(dicho, casos)]


def por_tablero(casos: list[dict]) -> list[str | None]:
    """El tablero web. Dibuja pares clave/valor en HTML, no una frase: se le
    sacan los números y la rama, que es lo que tiene que coincidir."""
    fn = bloque(RAIZ / "src/render/tablero.html", "function presupuesto(pre) {")
    un = "const unDecimal = (n) => Number(n).toFixed(1).replace('.', ',');"
    guion = (
        "const esc = (s) => String(s);\n" + un + "\n" + fn + "\n"
        f"const cs={json.dumps([c['entrada'] for c in casos])};\n"
        "console.log(JSON.stringify(cs.map(c=>presupuesto(c))));"
    )
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "t.mjs"
        p.write_text(guion, encoding="utf-8")
        r = subprocess.run(["node", str(p)], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "node falló")
    salidas = []
    for html in json.loads(r.stdout):
        # El globo lleva el JSON adentro de un atributo, con sus propios números.
        limpio = re.sub(r"data-tip='[^']*'", "", html)
        limpio = re.sub(r"<[^>]+>", " ", limpio)
        salidas.append(" ".join(limpio.split()))
    return salidas


# ── la barra de macOS: la redacción, no la ejecución ──────────────────────
def redaccion_swift() -> list[str]:
    """Los tres `String(format:)` de la rama `.reparte`, con los huecos puestos
    donde el canon tiene un número o la hora. No se ejecuta —la frase no está en
    una función y no hay macOS en el CI— pero que se le cambie una palabra a una
    de las tres sí se ve desde acá."""
    texto = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    i = texto.index("case .reparte(_, let porDiaHoy")
    j = texto.index("case .no(let motivo)", i)
    return re.findall(r'String\(format: "([^"]+)"', texto[i:j])


def canon_a_formato(esperado: str) -> list[str]:
    """El canon partido en los tres pedazos que la barra escribe por separado, en
    el dialecto de `String(format:)`."""
    partes = esperado.split(" · ")
    fmt = []
    for p in [partes[0], " · ".join(partes[1:])]:
        # El orden importa: primero se escapan los `%` que son literales, y
        # recién después se ponen los huecos, que traen `%` propios.
        f = p.replace("%", "%%")
        f = re.sub(r"\d+\.\d", "%.1f", f)
        fmt.append(f.replace("{desde}", "%@"))
    return fmt


# ── el gate ──────────────────────────────────────────────────────────────
# En Windows, `powershell` PRIMERO: la bandeja corre con el Windows PowerShell
# 5.1, que es lo que hay en una máquina sin instalar nada. Comprobarla contra el
# pwsh 7 —que el runner también tiene— sería comprobar un intérprete que la
# bandeja no usa, que es el mismo motivo por el que gate-bandeja.ps1 va con
# `powershell`. Fuera de Windows el único que hay es pwsh.
EXE_PS = shutil.which("powershell") or shutil.which("pwsh") or ""

PANTALLAS = [
    ("el núcleo (src/core/presupuesto.ts)", por_typescript, shutil.which("node"), "no hay node"),
    ("el indicador de GNOME (bin/qm-indicator)", por_python, True, ""),
    ("la bandeja de Windows (bin/qm-tray.ps1)", por_powershell, EXE_PS, "no hay pwsh ni powershell"),
    ("el tablero web (src/render/tablero.html)", por_tablero, shutil.which("node"), "no hay node"),
]


def main() -> int:
    fallas: list[str] = []
    corridas: dict[str, list[str | None]] = {}

    for nombre, fn, hay, porque in PANTALLAS:
        if not hay:
            print(f"  · salteada: {nombre} ({porque})")
            continue
        try:
            corridas[nombre] = fn(CASOS)
        except Exception as e:  # noqa: BLE001 — un adaptador roto es un rojo, no un salteo
            fallas.append(f"{nombre} no se pudo correr: {e}")

    if not corridas:
        print("GATE ROJO: no se pudo correr NINGUNA pantalla", file=sys.stderr)
        return 1

    for i, caso in enumerate(CASOS):
        esperado = caso["esperado"]
        horas: dict[str, str] = {}
        for nombre, salidas in corridas.items():
            dicho = salidas[i]
            if dicho is None:
                continue
            hora = HORA.search(dicho)
            if hora:
                horas[nombre] = hora.group(0)
            # El tablero dibuja pares clave/valor: de él se comparan los números
            # y la rama. De los que escriben una frase, la frase entera.
            if "tablero" in nombre:
                if numeros(dicho) != numeros(esperado) or rama(dicho) != rama(esperado):
                    fallas.append(
                        f"caso {i + 1} «{caso['nombre']}»\n"
                        f"    {nombre}\n"
                        f"      esperaba  {rama(esperado)} {numeros(esperado)}\n"
                        f"      dijo      {rama(dicho)} {numeros(dicho)}")
                continue
            comparable = HORA.sub("{desde}", dicho)
            if comparable != esperado:
                fallas.append(
                    f"caso {i + 1} «{caso['nombre']}»\n"
                    f"    {nombre}\n"
                    f"      esperaba  {esperado}\n"
                    f"      dijo      {comparable}")
        if len(set(horas.values())) > 1:
            fallas.append(f"caso {i + 1}: la hora de medidoDesde no coincide entre pantallas: "
                          + ", ".join(f"{n.split(' (')[0]} dice {h}" for n, h in horas.items()))

    # La barra de macOS: la redacción de sus tres formatos contra el canon.
    dichos = redaccion_swift()
    quiere = {f for c in CASOS for f in canon_a_formato(c["esperado"])}
    faltan = quiere - set(dichos)
    if faltan:
        for f in sorted(faltan):
            fallas.append("la barra de macOS (bin/qm-barra.swift) no escribe esta frase del canon:\n"
                          f"      {f}\n      escribe: " + " | ".join(dichos))

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1

    cubiertas = ", ".join(n.split(" (")[0] for n in corridas)
    print(f"presupuesto: {len(CASOS)} casos, las mismas cuentas en {cubiertas}")
    if EXE_PS:
        print(f"  · la bandeja se corrió con {pathlib.Path(EXE_PS).stem}")
    print("  · de la barra de macOS se comprobó la redacción, no la ejecución")
    print("  · el tablero escribe los números con coma; se comparan como números")
    return 0


if __name__ == "__main__":
    sys.exit(main())
