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
Y en la primera corrida de verdad este gate encontró que la bandeja de Windows
contestaba «te queda 0.0 %» donde las otras cuatro decían 0.3.

El canon está congelado en test/fixtures/presupuesto.json, sacado corriendo el
núcleo. Cada implementación se EJECUTA con el mismo JSON y se compara contra esa
tabla. Las que no tienen intérprete en esta máquina se saltean diciéndolo —
nunca se dan por buenas en silencio—, y `QM_GATE_EXIGE` convierte el salteo en
rojo en los jobs cuyo runner sí los trae.

Dos cosas que no se comparan letra por letra, y se dicen en la salida en vez de
esconderlas:

  - **el separador decimal.** El tablero escribe «16,1» y las otras cuatro
    «16.1». Los números se comparan como números; que el tablero use coma es una
    diferencia de dibujo que hay que decidir, no un rojo que este gate invente.
  - **el respaldo de un `qm` anterior en la barra de macOS.** En las otras
    pantallas el `?? porDia` está adentro de la función que escribe; en Swift
    está en el parseo del JSON, una función más arriba. Ese caso se saltea ahí,
    diciéndolo.

La hora de `medidoDesde` la escribe cada pantalla con el reloj de la máquina, así
que no se compara contra un string congelado: se exige que las pantallas digan
LA MISMA, que es la invariante que importa. El tablero llegó a decir «11:54 a.
m.» mientras las otras cuatro decían «11:54».
"""

import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

RAIZ = pathlib.Path(__file__).resolve().parent.parent
TABLA = json.loads((RAIZ / "test/fixtures/presupuesto.json").read_text(encoding="utf-8"))
CASOS = TABLA["casos"]

# Lo que devuelve una pantalla para un caso que no le toca contestar.
SALTEADO = "—"


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
# diferencia de lo que se DICE: se normalizan y se compara la frase.
HORA = re.compile(r"\d{2}:\d{2}")


def frase(renglones, barra) -> str:
    texto = " · ".join(r for r in renglones if r)
    if barra:
        texto = texto.replace(f" · {barra}", "")
    return " ".join(texto.split())


def numeros(texto: str) -> list[float]:
    """Los números de la frase, en orden, con coma o con punto."""
    return [float(n.replace(",", ".")) for n in re.findall(r"\d+[.,]\d", HORA.sub("", texto))]


def rama(texto: str) -> str:
    if "de acá a medianoche" in texto:
        return "reparto"
    if "desde las" in texto:
        return "medido"
    if "hoy" in texto:
        return "hoy"
    return "?"


def sin_campos_nuevos(entrada: dict) -> bool:
    """El JSON de un `qm` anterior a 0.1.11."""
    return entrada.get("porDiaHoy") is None and entrada.get("restanteMedido") is None


# ── las implementaciones ─────────────────────────────────────────────────
#
# Todas leen la salida del hijo con encoding="utf-8" explícito. Sin eso Python
# la decodifica con la codepage de la máquina, que en Windows no es UTF-8: las
# cinco frases volvían con `é` y `·` rotos y el gate comparaba mojibake contra
# el canon. Medido en el CI el 2026-09-14, no supuesto.
def por_typescript() -> list[str]:
    """El núcleo. `frasePresupuesto` come el Presupuesto de adentro, no el JSON,
    así que se le arma uno con los campos que la frase usa. Un caso sin
    `porDiaHoy` es un JSON que el núcleo NUNCA emite —es el de un qm anterior—,
    y ahí no se lo llama: contestar por él sería inventar."""
    entradas = []
    for c in CASOS:
        e = c["entrada"]
        entradas.append(None if sin_campos_nuevos(e) else {
            "estado": e["estado"], "motivo": e.get("motivo"),
            "porDiaHoy": e["porDiaHoy"], "quedaHoy": e["quedaHoy"],
            "gastadoHoy": e["gastadoHoy"], "restanteHoy": e["restanteHoy"],
            "gastadoMedido": e["gastadoMedido"], "restanteMedido": e["restanteMedido"],
            "medidoDesde": e["medidoDesde"],
        })
    guion = (
        "import {frasePresupuesto} from './src/core/presupuesto.ts';"
        f"const cs={json.dumps(entradas)};"
        "console.log(JSON.stringify(cs.map(c=>c===null?null:frasePresupuesto("
        "{...c, medidoDesde: c.medidoDesde===null?null:new Date(c.medidoDesde).getTime()}))));"
    )
    r = subprocess.run(["node", "--experimental-strip-types", "-e", guion],
                       cwd=RAIZ, capture_output=True, text=True, encoding="utf-8", timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "node falló")
    return [SALTEADO if s is None else s for s in json.loads(r.stdout)]


def por_python() -> list[str]:
    """El indicador de GNOME."""
    spec = importlib.util.spec_from_loader(
        "qmi", importlib.machinery.SourceFileLoader("qmi", str(RAIZ / "bin/qm-indicator")))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return [frase(m.renglones_presupuesto(c["entrada"]), c["entrada"].get("barra")) for c in CASOS]


def por_powershell() -> list[str]:
    """La bandeja de Windows. Con StrictMode, como corre de verdad: leer una
    propiedad que no está es una excepción, y es justo lo que pasa con el JSON
    de un qm anterior."""
    fn = bloque(RAIZ / "bin/qm-tray.ps1", "function RenglonesPresupuesto($pre) {")
    with tempfile.TemporaryDirectory() as d:
        guion, datos, dicho = (pathlib.Path(d) / n for n in ("p.ps1", "casos.json", "dicho.txt"))
        datos.write_text(json.dumps([c["entrada"] for c in CASOS]), encoding="utf-8")
        # Un renglón por caso, a un archivo en UTF-8. Ni JSON ni stdout, y las
        # dos cosas medidas en el CI y no supuestas: el ConvertTo-Json del
        # PowerShell 5.1 envuelve cada arreglo en {value, Count}, y la consola de
        # Windows escribe en la codepage de la máquina, así que el `·` y los
        # acentos volvían rotos.
        guion.write_text(
            "Set-StrictMode -Version Latest\n"
            "$ErrorActionPreference = 'Stop'\n"
            f"{fn}\n"
            f"$casos = Get-Content -Raw -Encoding UTF8 '{datos}' | ConvertFrom-Json\n"
            "$dicho = foreach ($c in $casos) { (RenglonesPresupuesto $c) -join ' · ' }\n"
            f"[System.IO.File]::WriteAllLines('{dicho}', [string[]]$dicho, "
            "(New-Object System.Text.UTF8Encoding $false))\n",
            # Con BOM: el Windows PowerShell 5.1 lee un .ps1 sin BOM en la
            # codepage de la máquina, no en UTF-8, así que el `·` y los acentos
            # del guión —los de la frase, justamente— le llegaban rotos y la
            # bandeja «decía» otra cosa que las demás. Medido en el CI el
            # 2026-09-14. scripts/gate-bandeja.ps1 ya arranca con BOM por esto.
            encoding="utf-8-sig")
        orden = [EXE_PS, "-NoProfile"]
        if sys.platform == "win32":
            # Sólo existe en Windows: en el pwsh de Linux el proceso ni arranca.
            orden += ["-ExecutionPolicy", "Bypass"]
        r = subprocess.run(orden + ["-File", str(guion)],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "powershell falló")
        lineas = dicho.read_text(encoding="utf-8").splitlines()
    if len(lineas) != len(CASOS):
        raise RuntimeError(f"contestó {len(lineas)} renglones y esperaba {len(CASOS)}")
    return [frase([l], c["entrada"].get("barra")) for l, c in zip(lineas, CASOS)]


def por_tablero() -> list[str]:
    """El tablero web. Dibuja pares clave/valor en HTML, no una frase: de él se
    comparan los números y la rama, que es lo que tiene que coincidir."""
    fn = bloque(RAIZ / "src/render/tablero.html", "function presupuesto(pre) {")
    guion = (
        "const esc = (s) => String(s);\n"
        "const unDecimal = (n) => Number(n).toFixed(1).replace('.', ',');\n"
        f"{fn}\n"
        f"const cs={json.dumps([c['entrada'] for c in CASOS])};\n"
        "console.log(JSON.stringify(cs.map(c=>presupuesto(c))));"
    )
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "t.mjs"
        p.write_text(guion, encoding="utf-8")
        r = subprocess.run(["node", str(p)], capture_output=True, text=True, encoding="utf-8", timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "node falló")
    salidas = []
    for html in json.loads(r.stdout):
        # El globo lleva el JSON adentro de un atributo, con sus propios números.
        limpio = re.sub(r"<[^>]+>", " ", re.sub(r"data-tip='[^']*'", "", html))
        salidas.append(" ".join(limpio.split()))
    return salidas


def por_swift() -> list[str]:
    """La barra de macOS. Su frase no está en una función sino adentro de un
    `switch`, así que se le saca el cuerpo del `case` y se lo envuelve en una:
    `self.presupuesto = …` pasa a ser la salida y los valores del patrón pasan a
    ser parámetros. Es el mismo código con el `switch` de alrededor sacado.

    El caso del `qm` anterior no entra: en la barra el `?? porDia` está en el
    parseo del JSON, no acá."""
    texto = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    i = texto.index("case .reparte(_, let porDiaHoy")
    cuerpo = texto[texto.index(":", i) + 1:texto.index("case .no(let motivo)", i)]
    cuerpo = cuerpo.replace("self.presupuesto", "salida")
    entradas = []
    for c in CASOS:
        e = c["entrada"]
        if sin_campos_nuevos(e):
            entradas.append(None)
            continue
        entradas.append({
            "porDiaHoy": e["porDiaHoy"], "quedaHoy": e["quedaHoy"],
            "gastado": e["gastadoHoy"] if e["cubreElDia"] else e["gastadoMedido"],
            "restante": e["restanteMedido"], "cubreElDia": e["cubreElDia"],
            # El mismo instante que el ISO: la hora que dibuja tiene que ser la
            # misma que dicen las otras pantallas.
            "desde": None if e["medidoDesde"] is None else datetime.fromisoformat(
                e["medidoDesde"].replace("Z", "+00:00")).timestamp(),
        })
    with tempfile.TemporaryDirectory() as d:
        p, datos = pathlib.Path(d) / "b.swift", pathlib.Path(d) / "casos.json"
        datos.write_text(json.dumps([e for e in entradas if e is not None]), encoding="utf-8")
        p.write_text(
            "import Foundation\n"
            "func renglones(_ porDiaHoy: Double, _ quedaHoy: Double, _ gastado: Double?,\n"
            "               _ restante: Double?, _ desde: Date?, _ cubreElDia: Bool) -> [String] {\n"
            "  var salida: [String] = []\n"
            f"{cuerpo}\n"
            "  return salida\n"
            "}\n"
            "struct Caso: Decodable { let porDiaHoy: Double; let quedaHoy: Double\n"
            "  let gastado: Double?; let restante: Double?; let desde: Double?\n"
            "  let cubreElDia: Bool }\n"
            f'let d = try! Data(contentsOf: URL(fileURLWithPath: "{datos}"))\n'
            "for c in try! JSONDecoder().decode([Caso].self, from: d) {\n"
            "  print(renglones(c.porDiaHoy, c.quedaHoy, c.gastado, c.restante,\n"
            "                  c.desde.map { Date(timeIntervalSince1970: $0) }, c.cubreElDia)\n"
            '        .joined(separator: " · "))\n'
            "}\n", encoding="utf-8")
        r = subprocess.run(["swift", str(p)], capture_output=True, text=True, encoding="utf-8", timeout=300)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "swift falló")
    dichas = iter(r.stdout.strip().split("\n"))
    return [SALTEADO if e is None else next(dichas) for e in entradas]


def redaccion_swift() -> list[str]:
    """Sin swiftc no se puede ejecutar, pero la REDACCIÓN se lee igual: los
    `String(format:)` de la rama `.reparte` tienen que ser los del canon."""
    texto = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    i = texto.index("case .reparte(_, let porDiaHoy")
    return re.findall(r'String\(format: "([^"]+)"', texto[i:texto.index("case .no(let motivo)", i)])


def canon_a_formato(esperado: str) -> list[str]:
    """El canon partido en los dos pedazos que la barra escribe por separado, en
    el dialecto de `String(format:)`."""
    partes = esperado.split(" · ")
    fmt = []
    for p in (partes[0], " · ".join(partes[1:])):
        # El orden importa: primero se escapan los `%` que son literales, y
        # recién después se ponen los huecos, que traen `%` propios.
        f = re.sub(r"\d+\.\d", "%.1f", p.replace("%", "%%"))
        fmt.append(f.replace("{desde}", "%@"))
    return fmt


# ── el gate ──────────────────────────────────────────────────────────────
# En Windows, `powershell` PRIMERO: la bandeja corre con el Windows PowerShell
# 5.1, que es lo que hay en una máquina sin instalar nada, y es el mismo motivo
# por el que gate-bandeja.ps1 no va con pwsh. Fuera de Windows el único que hay
# es pwsh.
EXE_PS = shutil.which("powershell") or shutil.which("pwsh") or ""

def hay(requisito: str | None) -> bool:
    """Si en esta máquina se puede correr esa pantalla.

    `cairo` no es un binario en el PATH: el indicador de GNOME importa gi y
    cairo al cargarse, así que en el runner de Windows —donde la bandeja SÍ se
    puede correr— importarlo revienta. Eso es una pantalla que no se puede
    comprobar acá, no un gate roto."""
    if requisito is None:
        return True
    if requisito == "cairo":
        try:
            import gi  # noqa: F401
            import cairo  # noqa: F401
        except Exception:  # noqa: BLE001 — sin gi/cairo no hay indicador que correr
            return False
        return True
    return shutil.which(requisito) is not None


IMPLEMENTACIONES = [
    ("TypeScript · el núcleo", por_typescript, "node"),
    ("Python · el indicador de GNOME", por_python, "cairo"),
    ("Swift · la barra de macOS", por_swift, "swift"),
    ("PowerShell · la bandeja", por_powershell, "powershell" if sys.platform == "win32" else "pwsh"),
    ("JavaScript · el tablero", por_tablero, "node"),
]


def main() -> int:
    # QM_GATE_EXIGE lista los intérpretes que TIENEN que estar, igual que en
    # gate-duraciones: en una laptop saltear swift y pwsh es lo razonable; en un
    # runner que los trae, saltear en silencio convierte al gate en un adorno.
    exigidos = {x for x in os.environ.get("QM_GATE_EXIGE", "").split(",") if x}
    fallas: list[str] = []
    salteadas: list[str] = []
    corridas: dict[str, list[str]] = {}

    for nombre, correr, binario in IMPLEMENTACIONES:
        if not hay(binario):
            if binario in exigidos:
                fallas.append(f"falta {binario}, y este job lo exige "
                              f"(QM_GATE_EXIGE={','.join(sorted(exigidos))})")
                continue
            falta = "python3-gi y cairo" if binario == "cairo" else binario
            salteadas.append(f"{nombre} (no hay {falta} en esta máquina)")
            continue
        try:
            salida = correr()
        except Exception as e:  # noqa: BLE001 — un adaptador roto es un rojo, no un salteo
            fallas.append(f"no pude correr {nombre}: {e}")
            continue
        if len(salida) != len(CASOS):
            fallas.append(f"{nombre} devolvió {len(salida)} frases y esperaba {len(CASOS)}")
            continue
        corridas[nombre] = salida

    if not corridas and not fallas:
        fallas.append("no se pudo correr NINGUNA pantalla")

    for i, caso in enumerate(CASOS):
        esperado = caso["esperado"]
        horas: dict[str, str] = {}
        for nombre, salidas in corridas.items():
            dicho = salidas[i]
            if dicho == SALTEADO:
                continue
            hora = HORA.search(dicho)
            if hora:
                horas[nombre] = hora.group(0)
            # El tablero dibuja pares clave/valor: de él se comparan los números
            # y la rama. De los que escriben una frase, la frase entera.
            if "tablero" in nombre:
                if numeros(dicho) != numeros(esperado) or rama(dicho) != rama(esperado):
                    fallas.append(f"caso {i + 1} «{caso['nombre']}»\n    {nombre}\n"
                                  f"      esperaba  {rama(esperado)} {numeros(esperado)}\n"
                                  f"      dijo      {rama(dicho)} {numeros(dicho)}")
                continue
            comparable = HORA.sub("{desde}", dicho)
            if comparable != esperado:
                fallas.append(f"caso {i + 1} «{caso['nombre']}»\n    {nombre}\n"
                              f"      esperaba  {esperado}\n      dijo      {comparable}")
        if len(set(horas.values())) > 1:
            fallas.append(f"caso {i + 1}: la hora de medidoDesde no coincide entre pantallas: "
                          + ", ".join(f"{n} dice {h}" for n, h in horas.items()))

    # Sin swiftc la barra no se ejecuta, pero su redacción se lee igual.
    corrio_swift = any("Swift" in n for n in corridas)
    if not corrio_swift:
        dichos = redaccion_swift()
        for f in sorted({f for c in CASOS for f in canon_a_formato(c["esperado"])} - set(dichos)):
            fallas.append("la barra de macOS no escribe esta frase del canon:\n"
                          f"      {f}\n      escribe: " + " | ".join(dichos))

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1

    for nombre, salidas in corridas.items():
        salteados = sum(1 for s in salidas if s == SALTEADO)
        cola = f" · {salteados} salteado: el qm anterior no pasa por esta función" if salteados else ""
        print(f"  ✓ {nombre}: {len(CASOS) - salteados}/{len(CASOS)}{cola}")
    for s in salteadas:
        print(f"  · salteada: {s}")
    if salteadas:
        print(f"presupuesto: {len(CASOS)} casos, coinciden las pantallas que se pudieron correr acá")
    else:
        print(f"presupuesto: {len(CASOS)} casos, las cinco pantallas dicen lo mismo")
    if not corrio_swift:
        print("  · de la barra de macOS se comprobó la redacción, no la ejecución")
    print("  · el tablero escribe los números con coma; se comparan como números")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
