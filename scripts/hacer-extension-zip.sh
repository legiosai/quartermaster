#!/bin/sh
# El zip de la extensión, con la forma que pide extensions.gnome.org.
#
# Por qué existe. La extensión está escrita desde hace rato y la única forma de
# instalarla es clonar el repo y correr `make extension`. extensions.gnome.org
# es el catálogo por defecto de GNOME —lo que se abre desde «Extensiones» en
# cualquier escritorio GNOME— y ahí no está, así que para quien no clona el
# repo, sencillamente no existe.
#
# El formato tiene una regla que se rompe sola si uno arma el zip a mano:
# metadata.json y extension.js van en la RAÍZ del zip, no adentro de un
# directorio con el uuid. Por eso se usa `gnome-extensions pack`, que además
# valida el metadata.json, y por eso el gate de abajo mira lo que salió en vez
# de confiar.
#
# Subirlo es a mano y con cuenta: https://extensions.gnome.org/upload/
# Ver paquetes/README.md para lo que mira el revisor.

set -e
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

fuente="$raiz/extension/quartermaster@legios"
destino=${1:-$raiz/dist}
mkdir -p "$destino"

[ -f "$fuente/metadata.json" ] || { echo "no está $fuente/metadata.json" >&2; exit 1; }

zip="$destino/quartermaster@legios.shell-extension.zip"
rm -f "$zip"

# `gnome-extensions pack` es el camino bueno —arma el zip y de paso valida el
# metadata.json— pero viene con gnome-shell, que en un runner de CI no está y
# que instalar para esto serían cientos de megas. Con `zip` sale lo mismo: la
# forma del archivo es tres archivos en la raíz, y eso lo comprueba el gate de
# abajo mire quien lo haya armado.
if command -v gnome-extensions >/dev/null 2>&1; then
  gnome-extensions pack "$fuente" --out-dir="$destino" --force
elif command -v zip >/dev/null 2>&1; then
  echo "· sin gnome-extensions: armando el zip con \`zip\`"
  (cd "$fuente" && zip -q -X "$zip" metadata.json extension.js stylesheet.css)
else
  echo "no tengo con qué armar el zip: falta \`gnome-extensions\` y falta \`zip\`." >&2
  exit 1
fi

[ -f "$zip" ] || { echo "gnome-extensions dijo que sí pero no está $zip" >&2; exit 1; }

# ── el gate del zip ────────────────────────────────────────────────────
# Tres cosas que el sitio rechaza y que no se ven mirando el directorio:
adentro=$(unzip -Z1 "$zip")

echo "$adentro" | grep -qx 'metadata.json' || {
  echo "✗ metadata.json no está en la raíz del zip: el sitio lo rechaza" >&2; exit 1; }
echo "$adentro" | grep -qx 'extension.js' || {
  echo "✗ extension.js no está en la raíz del zip" >&2; exit 1; }
echo "$adentro" | grep -qx 'stylesheet.css' || {
  echo "✗ el stylesheet no viajó: el panel saldría sin estilos" >&2; exit 1; }

# La versión la asigna el sitio; mandar una propia confunde el número de
# revisión con el del repo.
if grep -q '"version"[[:space:]]*:' "$fuente/metadata.json"; then
  echo "✗ metadata.json trae \"version\": ése número lo pone extensions.gnome.org." >&2
  echo "  Lo nuestro va en \"version-name\"." >&2
  exit 1
fi

# El metadata.json tiene que ser JSON válido y traer las cinco claves que el
# sitio exige. `gnome-extensions pack` lo valida; el camino de `zip` no, así
# que se valida acá y vale para los dos.
python3 - "$fuente/metadata.json" <<'PY'
import json, sys
ruta = sys.argv[1]
try:
    m = json.load(open(ruta, encoding='utf-8'))
except Exception as e:
    print(f"✗ {ruta} no es JSON válido: {e}", file=sys.stderr)
    sys.exit(1)
faltan = [k for k in ('uuid', 'name', 'description', 'shell-version', 'url') if k not in m]
if faltan:
    print(f"✗ al metadata.json le faltan claves que el sitio exige: {', '.join(faltan)}", file=sys.stderr)
    sys.exit(1)
if not isinstance(m['shell-version'], list) or not m['shell-version']:
    print("✗ shell-version tiene que ser una lista con al menos una versión", file=sys.stderr)
    sys.exit(1)
PY

# El uuid tiene que coincidir con el nombre del directorio, o al instalar queda
# en un lado y el shell lo busca en otro.
uuid=$(sed -n 's/.*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$fuente/metadata.json")
[ "$uuid" = "$(basename "$fuente")" ] || {
  echo "✗ el uuid ($uuid) no coincide con el directorio ($(basename "$fuente"))" >&2; exit 1; }

bytes=$(wc -c < "$zip")
echo "✓ $zip  (${bytes} bytes)"
echo "  subir a: https://extensions.gnome.org/upload/"
