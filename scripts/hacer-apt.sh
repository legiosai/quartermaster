#!/bin/sh
# El repositorio apt, armado dentro de docs/ para que lo sirva la misma página.
#
# No es un .deb suelto colgado de una release: es un repo firmado, así que
# `apt upgrade` trae la versión nueva sola y apt verifica la firma antes de
# instalar nada. Vive en GitHub Pages porque es estático — un repo apt es un
# árbol de archivos y un par de índices, no un servicio.
#
# La clave: se firma con la que ya tiene el mantenedor en la máquina. Si el
# agente de gpg no la tiene cacheada, esto va a pedir la contraseña, y eso está
# bien: firmar un repo de paquetes no es algo que deba pasar sin que nadie mire.

set -e
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

CLAVE=${QM_CLAVE_GPG:-B001E953E4CB848F}
SUITE=stable
APT="$raiz/docs/apt"

deb=$(./scripts/hacer-deb.sh "$raiz/dist")
version=$(dpkg-deb -f "$deb" Version)

rm -rf "$APT"
mkdir -p "$APT/pool/main/q/quartermaster" "$APT/dists/$SUITE/main/binary-all"
cp -f "$deb" "$APT/pool/main/q/quartermaster/"

cd "$APT"
dpkg-scanpackages --multiversion pool /dev/null > "dists/$SUITE/main/binary-all/Packages" 2>/dev/null
gzip -9c "dists/$SUITE/main/binary-all/Packages" > "dists/$SUITE/main/binary-all/Packages.gz"

apt-ftparchive \
  -o "APT::FTPArchive::Release::Origin=Legios" \
  -o "APT::FTPArchive::Release::Label=quartermaster" \
  -o "APT::FTPArchive::Release::Suite=$SUITE" \
  -o "APT::FTPArchive::Release::Codename=$SUITE" \
  -o "APT::FTPArchive::Release::Architectures=all" \
  -o "APT::FTPArchive::Release::Components=main" \
  -o "APT::FTPArchive::Release::Description=quartermaster · Legios" \
  release "dists/$SUITE" > "$raiz/dist/Release.tmp"
# A un temporal y después se mueve: la redirección de la shell crea el archivo
# ANTES de que corra el comando, así que apt-ftparchive encontraba un Release
# vacío adentro del directorio que estaba escaneando y lo listaba en su propia
# lista de sumas.
mv "$raiz/dist/Release.tmp" "dists/$SUITE/Release"

# InRelease (firma incorporada) y Release.gpg (separada): apt moderno usa la
# primera, pero la segunda no cuesta nada y cubre a los que todavía no.
gpg --batch --yes --default-key "$CLAVE" --clearsign \
    -o "dists/$SUITE/InRelease" "dists/$SUITE/Release"
gpg --batch --yes --default-key "$CLAVE" -abs \
    -o "dists/$SUITE/Release.gpg" "dists/$SUITE/Release"
gpg --armor --export "$CLAVE" > legios.gpg

echo "repo apt armado: quartermaster $version, firmado con $CLAVE"
