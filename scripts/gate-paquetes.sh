#!/usr/bin/env bash
# Gate de los paquetes que se mandan a catálogos ajenos.
#
# Estos archivos tienen una particularidad incómoda: **el error se descubre del
# otro lado**. Un PKGBUILD con el .SRCINFO desactualizado lo rechaza el AUR, un
# manifest de winget con la versión vieja apunta a un artefacto que no existe, y
# un metadata.json con "version" adentro lo devuelve extensions.gnome.org. En
# los tres casos hay una persona esperando y una vuelta entera perdida.
#
# Todo lo que se comprueba acá es de forma, y se comprueba porque la versión
# vive en SIETE lugares:
#
#   package.json · PKGBUILD · .SRCINFO · el version-name de la extensión ·
#   las dos landings · y los manifests que se generan
#
# Editar seis de siete no rompe nada visible. Ése es el problema.

set -euo pipefail
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

fallas=0
fallar() { echo "✗ $1" >&2; fallas=$((fallas + 1)); }

version=$(node -p "require('./package.json').version")
echo "· versión de package.json: $version"

# ── 1. la versión, en todos lados ──────────────────────────────────────
pkgver=$(sed -n 's/^pkgver=//p' paquetes/aur/PKGBUILD)
[ "$pkgver" = "$version" ] || fallar "el PKGBUILD dice $pkgver y package.json dice $version"

srcver=$(sed -n 's/^\tpkgver = //p' paquetes/aur/.SRCINFO)
[ "$srcver" = "$version" ] || fallar "el .SRCINFO dice $srcver y package.json dice $version"

extver=$(sed -n 's/.*"version-name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
         "extension/quartermaster@legios/metadata.json")
[ "$extver" = "$version" ] || fallar "el version-name de la extensión dice $extver"

for pagina in docs/index.html docs/es/index.html; do
  if grep -q 'quartermaster-[0-9.]*-setup\.exe' "$pagina"; then
    web=$(grep -o 'quartermaster-[0-9.]*-setup\.exe' "$pagina" | head -1 | sed 's/quartermaster-//; s/-setup\.exe//')
    [ "$web" = "$version" ] || fallar "$pagina nombra el instalador $web"
  fi

  # Y el pie, que es lo que un lector toma por «la versión» sin abrir ninguna
  # pestaña. Estaba fuera del gate, y es justo lo que le pasó: docs/es/index.html
  # anunció v0.1.2 durante cuatro releases —con el nombre del instalador, el
  # PKGBUILD, el .SRCINFO y la extensión los cuatro en 0.1.6— y el gate en verde.
  # El nombre del instalador vive en una pestaña que hay que clickear; el pie
  # está siempre a la vista.
  pie=$(grep -o 'releases">v[0-9][0-9.]*</a>' "$pagina" | head -1 | sed 's|.*">v||; s|</a>||' || true)
  if [ -z "$pie" ]; then
    fallar "$pagina no dice ninguna versión en el pie (¿cambió la forma del enlace?)"
  elif [ "$pie" != "$version" ]; then
    fallar "$pagina dice v$pie en el pie y package.json dice $version"
  fi
done

# ── 2. el PKGBUILD y el .SRCINFO, de acuerdo ───────────────────────────
# El AUR rechaza el push si no coinciden, y el mensaje no dice en qué campo.
pkgdesc=$(sed -n 's/^pkgdesc="\(.*\)"$/\1/p' paquetes/aur/PKGBUILD)
grep -qF "pkgdesc = $pkgdesc" paquetes/aur/.SRCINFO || fallar "el pkgdesc del .SRCINFO no es el del PKGBUILD"

# ── 3. la extensión, con lo que exige el sitio ─────────────────────────
python3 - <<'PY' || fallas=$((fallas + 1))
import json, sys
m = json.load(open('extension/quartermaster@legios/metadata.json', encoding='utf-8'))
mal = []
for k in ('uuid', 'name', 'description', 'shell-version', 'url'):
    if k not in m: mal.append(f'falta {k}')
if 'version' in m:
    mal.append('trae "version": ese número lo pone extensions.gnome.org, lo nuestro va en version-name')
if m.get('uuid') != 'quartermaster@legios':
    mal.append('el uuid no coincide con el directorio')
for x in mal: print(f'✗ metadata.json: {x}', file=sys.stderr)
sys.exit(1 if mal else 0)
PY

# ── 4. los manifests se pueden generar ─────────────────────────────────
# Con hashes de mentira: lo que se comprueba es que el generador corra y que lo
# que sale sea YAML y JSON válidos con la versión correcta.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
falso=$(printf 'a%.0s' $(seq 64))
node scripts/hacer-manifests.mjs --exe "$falso" --zip "$falso" >/dev/null
dir="dist/paquetes/winget/manifests/l/Legios/Quartermaster/$version"
[ -d "$dir" ] || fallar "el generador no dejó $dir"
python3 - "$dir" "$version" <<'PY' || fallas=$((fallas + 1))
import json, sys, glob, os
dir, version = sys.argv[1], sys.argv[2]
try:
    import yaml
except ImportError:
    print('· (sin PyYAML: no se valida la forma del YAML de winget)')
    yaml = None
mal = []
if yaml:
    for f in glob.glob(os.path.join(dir, '*.yaml')):
        d = yaml.safe_load(open(f, encoding='utf-8'))
        if d.get('PackageVersion') != version:
            mal.append(f'{os.path.basename(f)}: PackageVersion {d.get("PackageVersion")}')
        if d.get('PackageIdentifier') != 'Legios.Quartermaster':
            mal.append(f'{os.path.basename(f)}: PackageIdentifier {d.get("PackageIdentifier")}')
s = json.load(open('dist/paquetes/scoop/quartermaster.json', encoding='utf-8'))
if s.get('version') != version:
    mal.append(f'scoop: version {s.get("version")}')
if version not in s.get('url', ''):
    mal.append('scoop: la url no apunta a esta versión')
for x in mal: print('✗ ' + x, file=sys.stderr)
sys.exit(1 if mal else 0)
PY

if [ "$fallas" -ne 0 ]; then
  echo "" >&2
  echo "gate de paquetes: ROJO ($fallas)" >&2
  exit 1
fi
echo "gate de paquetes: verde — la versión coincide en los siete lugares (pie de las dos landings incluido), el .SRCINFO va con el PKGBUILD, la extensión tiene la forma que pide el sitio, y los manifests se generan"
