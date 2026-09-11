#!/usr/bin/env bash
# Gate: el tarball que sale a npm se instala Y CORRE.
#
# Existe por un defecto real. El repo lee el TypeScript directo, sin build, y eso
# anda para `make instalar`, el .deb y brew. Para npm NO: Node se niega a hacer
# type stripping de nada bajo node_modules
#   ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
# y `npm install -g` deja el paquete exactamente ahí. `npm install` decía "added
# 1 package" y después `qm` moría en cada invocación.
#
# Por eso el gate no comprueba que el tarball EXISTA ni que tenga los archivos:
# los tenía. Lo instala en un prefix limpio y lo ejecuta, que es la única forma
# de ver este defecto — vive en la ruta de instalación, no en el contenido.
#
# Probado en rojo: `make gate-npm-rojo` saca dist/ del tarball y esto falla con
# el mismo error que se midió el 2026-09-11.
set -euo pipefail

RAIZ=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$RAIZ"
npm run --silent construir >/dev/null
TARBALL=$(npm pack --silent --pack-destination "$TMP")

npm i -g --silent --prefix "$TMP/pref" "$TMP/$TARBALL" >/dev/null

# --breve es el camino más corto que toca todo: perfiles, cache y render.
if ! SALIDA=$("$TMP/pref/bin/qm" --breve 2>&1); then
  echo "✗ el paquete instalado no corre:" >&2
  echo "$SALIDA" | head -5 >&2
  exit 1
fi
[ -n "$SALIDA" ] || { echo "✗ qm --breve no imprimió nada desde el paquete instalado" >&2; exit 1; }
echo "  ✓ qm --breve desde el paquete instalado: $SALIDA"

if ! "$TMP/pref/bin/qm" --json --redactado >/dev/null 2>&1; then
  echo "✗ qm --json falla desde el paquete instalado" >&2
  exit 1
fi
echo "  ✓ qm --json desde el paquete instalado"

PAQ="$TMP/pref/lib/node_modules/@legios/quartermaster"
[ -f "$PAQ/dist/render/tablero.html" ] || { echo "✗ el tablero no llegó al paquete: qm-web no tendría qué servir" >&2; exit 1; }
echo "  ✓ el tablero viajó en el paquete"

echo "✓ el paquete de npm se instala y corre"
