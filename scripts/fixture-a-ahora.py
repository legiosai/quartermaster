"""Un fixture del panel con sus instantes corridos a «ahora».

    python3 scripts/fixture-a-ahora.py <fixture.json> <salida.json>

Los fixtures se sacaron un día de septiembre, y dibujados tal cual dicen que
todo reinicio ya pasó: todas las barras «vencidas», ninguna proyección hacia
adelante. Para MIRAR un panel —el artefacto que sube el CI— los instantes se
corren todos juntos lo que va de `generado` a ahora: los ISO y los `t` en
milisegundos del historial. Así el fixture dibuja hoy lo mismo que dibujó el
día que se sacó.

Lo usan las capturas de la barra de macOS (scripts/captura-barra.sh) y de la
bandeja de Windows (scripts/captura-bandeja.ps1). Vivía adentro del primero, y
copiarlo al segundo era empezar dos versiones de la misma cuenta.
"""

import json
import re
import sys
from datetime import datetime, timezone


def correr(x, delta, ms):
    if isinstance(x, dict):
        return {k: (v + ms if k == "t" and isinstance(v, (int, float)) else correr(v, delta, ms))
                for k, v in x.items()}
    if isinstance(x, list):
        return [correr(v, delta, ms) for v in x]
    if isinstance(x, str) and re.match(r"^\d{4}-\d\d-\d\dT", x):
        try:
            return (datetime.fromisoformat(x.replace("Z", "+00:00")) + delta).isoformat().replace("+00:00", "Z")
        except ValueError:
            return x
    return x


def main() -> int:
    entrada, salida = sys.argv[1], sys.argv[2]
    with open(entrada, encoding="utf-8") as f:
        d = json.load(f)
    gen = datetime.fromisoformat(d["generado"].replace("Z", "+00:00"))
    delta = datetime.now(timezone.utc) - gen
    ms = int(delta.total_seconds() * 1000)
    with open(salida, "w", encoding="utf-8") as f:
        json.dump(correr(d, delta, ms), f)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
