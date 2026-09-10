"""Las cuatro escaleras de duración tienen que dar exactamente lo mismo.

Hay una implementación por lenguaje —TypeScript, Python, Swift, PowerShell— y
cada una vive en un renderizador distinto. La regla siempre estuvo escrita en los
comentarios; lo que faltaba era comprobarla. El resultado de no comprobarla:
convivieron DOS convenciones durante meses, tres GUIs de un lado y el CLI del
otro, en tres puntos a la vez (qué se dice de un instante pasado, si los minutos
se rellenan con cero, y si un día justo es `1d` o `1d0h`). Sobrevivió porque
nadie había comparado una GUI contra el CLI: Sol comparó dos GUIs entre sí.

El canon está congelado en test/fixtures/duraciones.json, sacado corriendo el
CLI. Cada implementación se EJECUTA y se compara contra esa tabla. Las que no
tienen intérprete en esta máquina se saltean diciéndolo — nunca se dan por
buenas en silencio.
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

RAIZ = pathlib.Path(__file__).resolve().parent.parent
TABLA = json.loads((RAIZ / "test/fixtures/duraciones.json").read_text())
CASOS = [(int(s), esperado) for s, esperado in TABLA["casos"]]


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


def por_typescript():
    guion = (
        "import {duracion} from './src/render/barras.ts';"
        f"const c={json.dumps([s for s, _ in CASOS])};"
        "console.log(JSON.stringify(c.map(s=>duracion(s*1000))));"
    )
    r = subprocess.run(["node", "--experimental-strip-types", "-e", guion],
                       cwd=RAIZ, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "node falló")
    return json.loads(r.stdout)


def por_python():
    spec = importlib.util.spec_from_loader(
        "qm", importlib.machinery.SourceFileLoader("qm", str(RAIZ / "bin/qm-indicator")))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return [m.duracion(s) for s, _ in CASOS]


def por_swift():
    fn = bloque(RAIZ / "bin/qm-barra.swift", "func duracion(_ segundos: Int) -> String {")
    casos = ", ".join(str(s) for s, _ in CASOS)
    guion = f'import Foundation\n{fn}\nprint([{casos}].map {{ duracion($0) }}.joined(separator: "\\n"))\n'
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "d.swift"
        p.write_text(guion)
        r = subprocess.run(["swift", str(p)], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "swift falló")
    return r.stdout.strip().split("\n")


def por_powershell():
    fn = bloque(RAIZ / "bin/qm-tray.ps1", "function Dur([int]$segundos) {")
    casos = ", ".join(str(s) for s, _ in CASOS)
    guion = f"{fn}\n@({casos}) | ForEach-Object {{ Dur $_ }}\n"
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "d.ps1"
        p.write_text(guion)
        r = subprocess.run(["pwsh", "-NoProfile", "-File", str(p)],
                           capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1] if r.stderr else "pwsh falló")
    return [l.strip() for l in r.stdout.strip().split("\n")]


IMPLEMENTACIONES = [
    ("TypeScript · el CLI", por_typescript, "node"),
    ("Python · el panel de GNOME", por_python, None),
    ("Swift · la barra de macOS", por_swift, "swift"),
    ("PowerShell · la bandeja", por_powershell, "pwsh"),
]


def main() -> int:
    # QM_GATE_EXIGE lista los intérpretes que TIENEN que estar. En una laptop no
    # hay ni swift ni pwsh y saltearlos es lo razonable; en CI, saltear en
    # silencio convertiría el gate en un adorno, así que cada job exige los que
    # su runner trae.
    exigidos = {x for x in os.environ.get("QM_GATE_EXIGE", "").split(",") if x}
    fallas, salteadas = 0, []
    for nombre, correr, binario in IMPLEMENTACIONES:
        if binario is not None and shutil.which(binario) is None:
            if binario in exigidos:
                print(f"GATE ROJO: falta {binario}, y este job lo exige "
                      f"(QM_GATE_EXIGE={','.join(sorted(exigidos))})", file=sys.stderr)
                fallas += 1
                continue
            salteadas.append(f"{nombre} (no hay {binario} en esta máquina)")
            continue
        try:
            salida = correr()
        except Exception as e:  # noqa: BLE001 — cualquier fallo es una falla del gate
            print(f"GATE ROJO: no pude correr {nombre}: {e}", file=sys.stderr)
            fallas += 1
            continue
        if len(salida) != len(CASOS):
            print(f"GATE ROJO: {nombre} devolvió {len(salida)} valores y esperaba "
                  f"{len(CASOS)}", file=sys.stderr)
            fallas += 1
            continue
        malos = [(s, esp, dio) for (s, esp), dio in zip(CASOS, salida) if esp != dio]
        if malos:
            fallas += 1
            print(f"GATE ROJO: {nombre} no coincide con el canon:", file=sys.stderr)
            for s, esp, dio in malos[:8]:
                print(f"    {s:>10} s → esperaba {esp!r}, dio {dio!r}", file=sys.stderr)
        else:
            print(f"  ✓ {nombre}: {len(CASOS)}/{len(CASOS)}")

    for s in salteadas:
        print(f"  · salteada: {s}")
    if fallas:
        return 1
    if salteadas:
        print("duraciones: coinciden las que se pudieron correr acá")
    else:
        print("duraciones: las cuatro coinciden")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
