#!/bin/sh
# El .deb, armado desde el árbol de trabajo.
#
# No compila nada: qm lee el TypeScript directo, así que el paquete es el fuente
# más un enlace en /usr/bin. Por eso `Architecture: all`.
#
# La dependencia dice `nodejs` a secas y no `nodejs (>= 22.6)` a propósito.
# Debian 13 trae un 20, así que pedir 22.6 haría el paquete instalable en
# ninguna parte — y la versión nueva suele estar en nvm, que apt no ve. El
# lanzador ya busca un Node que sirva y, si no lo encuentra, lo dice con todas
# las letras y explica cómo conseguirlo. Mejor un paquete que instala y avisa
# que uno que apt se niega a instalar por una razón que no es cierta.

set -e
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

version=$(node -p "require('./package.json').version" 2>/dev/null ||
          sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$version" ] || { echo "no pude sacar la versión de package.json" >&2; exit 1; }

destino=${1:-$raiz/dist}
mkdir -p "$destino"
arma=$(mktemp -d)
trap 'rm -rf "$arma"' EXIT

mkdir -p "$arma/DEBIAN" "$arma/usr/lib/quartermaster" "$arma/usr/bin" \
         "$arma/usr/share/doc/quartermaster"

cp -r bin src scripts extension Makefile package.json "$arma/usr/lib/quartermaster/"
cp README.md LICENSE "$arma/usr/share/doc/quartermaster/"
# El lanzador sigue los symlinks para encontrar el src/, así que un enlace
# alcanza y no hay que duplicar el árbol.
ln -sf /usr/lib/quartermaster/bin/qm "$arma/usr/bin/qm"
find "$arma/usr/lib/quartermaster" -name '__pycache__' -prune -exec rm -rf {} +

cat > "$arma/DEBIAN/control" <<EOF
Package: quartermaster
Version: $version
Section: devel
Priority: optional
Architecture: all
Depends: nodejs
Suggests: python3-gi, python3-cairo, gir1.2-gtk-3.0, gir1.2-ayatanaappindicator3-0.1
Maintainer: Legios <valentintorassacolombero@gmail.com>
Homepage: https://github.com/legiosai/quartermaster
Description: Cuánta cuota te queda en todos tus perfiles de Claude Code
 Lee TODOS los CLAUDE_CONFIG_DIR de la máquina, no sólo el directorio por
 defecto, y suma Codex y los proveedores que guarda opencode.
 .
 El número no necesita red ni credenciales: sale del cache que Claude Code deja
 en el .claude.json de cada perfil, así que se lee aunque el token esté vencido.
 .
 Necesita Node >= 22.6, porque qm lee el TypeScript sin paso de build. El
 lanzador lo busca en el PATH y en nvm; si no encuentra uno que sirva, lo dice.
EOF

chmod 0755 "$arma/usr/lib/quartermaster/bin/qm" \
           "$arma/usr/lib/quartermaster/bin/qm-indicator" \
           "$arma/usr/lib/quartermaster/bin/qm-web" \
           "$arma/usr/lib/quartermaster/scripts/"*.sh 2>/dev/null || true

paquete="$destino/quartermaster_${version}_all.deb"
fakeroot dpkg-deb --build "$arma" "$paquete" >/dev/null
echo "$paquete"
