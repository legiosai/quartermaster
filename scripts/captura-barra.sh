#!/bin/sh
# Dibuja el menú de la barra de macOS a partir de un fixture, sin cuenta ni red.
#
#   scripts/captura-barra.sh <binario de qm-barra> <salida> <fixture.json>...
#
# La barra le pide el JSON a `qm` (QM_RAIZ/bin/qm), así que alcanza con darle un
# `qm` que imprima el fixture. Los instantes del fixture se corren a «ahora»
# antes (scripts/fixture-a-ahora.py): un reinicio de septiembre dibujaría todas
# las barras «vencidas».
#
# Por cada fixture deja <nombre>-oscuro.png, <nombre>-claro.png y los dos del
# menú (<nombre>-menu-oscuro.png, <nombre>-menu-claro.png): es lo que escribe
# `qm-barra --captura`. Falla si alguno no salió.
set -eu

BINARIO=$1
SALIDA=$2
shift 2
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$SALIDA"

for FIXTURE in "$@"; do
  nombre=$(basename "$FIXTURE" .json)
  falso=$(mktemp -d)
  mkdir -p "$falso/bin"
  python3 "$RAIZ/scripts/fixture-a-ahora.py" "$FIXTURE" "$falso/datos.json"
  cat > "$falso/bin/qm" <<EOF
#!/bin/sh
# El qm de la captura: el JSON del fixture y nada más. Lo demás que la barra
# le pide (calentar Codex, por ejemplo) no tiene nada que hacer acá.
case " \$* " in
  *" --json "*) cat "$falso/datos.json" ;;
esac
exit 0
EOF
  chmod +x "$falso/bin/qm"

  # Sin `timeout` en macOS: perl lo hace igual. Una barra que no termina sola es
  # una captura que no salió, y el job no puede quedarse colgado esperándola.
  QM_RAIZ="$falso" perl -e 'alarm shift; exec @ARGV' 90 "$BINARIO" --captura "$SALIDA/$nombre.png"
  for sufijo in oscuro claro menu-oscuro menu-claro; do
    if [ ! -s "$SALIDA/$nombre-$sufijo.png" ]; then
      echo "✗ la barra no dibujó $nombre-$sufijo.png" >&2
      exit 1
    fi
  done
  echo "barra de macOS: $nombre dibujado (item y menú, en los dos temas)"
  rm -rf "$falso"
done
