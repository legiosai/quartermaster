#!/usr/bin/env bash
# Cortar una versión: un comando, y de ahí salen todos los canales.
#
#   ./scripts/cortar-release.sh 0.1.7
#   ./scripts/cortar-release.sh patch
#
# Lo que hace acá: mover la versión a los siete lugares, correr los gates que se
# pueden correr en esta máquina, comitear y etiquetar. Lo que pasa después lo
# hace .github/workflows/release.yml, que con el tag publica en npm, arma el
# .deb y el instalador, crea la release y empuja a los canales que tengan su
# secreto configurado.
#
# POR QUÉ ETIQUETAR ES EL DISPARADOR. Porque es lo único que no se puede hacer
# por accidente: un push a main no publica nada, y un tag sí. Y porque el tag y
# el package.json tienen que decir lo mismo — el workflow lo comprueba antes de
# tocar nada, que es lo que evita publicar un paquete que no coincide con su
# release.

set -euo pipefail
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

pedido=${1:-}
if [ -z "$pedido" ]; then
  echo "uso: $0 <versión|patch|minor|major>" >&2
  echo "ahora: $(node -p "require('./package.json').version")" >&2
  exit 2
fi

# ── que el árbol esté limpio ───────────────────────────────────────────
# Etiquetar con cambios sin comitear deja un tag que no corresponde a nada
# reproducible, y eso se descubre cuando alguien quiere volver a esa versión.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ hay cambios sin comitear. Una versión se corta de un árbol limpio." >&2
  git status --short >&2
  exit 1
fi

rama=$(git rev-parse --abbrev-ref HEAD)
[ "$rama" = "main" ] || { echo "✗ estás en '$rama', no en main" >&2; exit 1; }

git fetch origin --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "✗ main y origin/main no están en el mismo commit" >&2
  exit 1
fi

# ── mover la versión ───────────────────────────────────────────────────
echo "· moviendo la versión"
node scripts/bumpear.mjs "$pedido"
version=$(node -p "require('./package.json').version")

# ── los gates que corren acá ───────────────────────────────────────────
echo ""
echo "· los gates"
npm run --silent typecheck
npm test >/dev/null 2>&1 && echo "  ✓ tests" || { echo "  ✗ tests" >&2; exit 1; }
./scripts/gate-paquetes.sh | tail -1
./scripts/el-paquete-de-npm-corre.sh | tail -1

# ── comitear y etiquetar ───────────────────────────────────────────────
echo ""
git add -A
git commit -q -m "$version"
git tag -a "v$version" -m "quartermaster $version"

echo "· listo, local:"
git --no-pager log --oneline -1
echo ""
echo "Para soltarlo a todos los canales:"
echo ""
echo "    git push origin main && git push origin v$version"
echo ""
echo "El tag dispara release.yml: npm (con provenance), el .deb, el instalador"
echo "de Windows, la release de GitHub, y los canales que tengan su secreto."
echo "Lo único que queda a mano es extensions.gnome.org, que no tiene API."
