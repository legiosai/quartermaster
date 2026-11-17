#!/usr/bin/env bash
# Lo que escriben los workflows —el repo de apt firmado y descargas.json— vive
# en la rama `publicacion`, no en main.
#
#   scripts/publicacion.sh traer <ruta>...              # de la rama al checkout
#   scripts/publicacion.sh guardar <mensaje> <ruta>...  # del checkout a la rama, y push
#   scripts/publicacion.sh sitio <salida>               # la página: docs/ + lo de la rama
#
# POR QUÉ. GitHub Pages publicaba main:/docs tal cual, así que release.yml (el
# repo de apt) y descargas.yml (el conteo diario) comiteaban a main para que
# lo nuevo saliera en la página. Un workflow que empuja a main es un workflow
# que no deja protegerla: el ruleset de la organización —un PR con una
# aprobación— tenía a quartermaster de excepción por eso: el único repo
# excluido.
#
# Ahora los dos empujan a `publicacion`, una rama huérfana que tiene SÓLO lo
# generado, y .github/workflows/pages.yml arma la página con docs/ de main
# más lo de esa rama. Las rutas son las mismas en las dos ramas
# (docs/apt, docs/descargas.json), así que hacer-apt.sh y descargas.mjs
# escriben donde escribían y no se enteran del cambio.
#
# SI LA RAMA NO EXISTE. `guardar` la crea, huérfana, con lo que main tenga hoy
# de lo generado —ése es su primer commit, y dice de qué commit de main salió—
# y recién después comitea lo nuevo. `traer` y `sitio` se quedan con la copia
# de main y lo avisan. Si main tampoco tiene nada, NO se siembra de cero: el
# historial de descargas.json se perdería sin que nadie lo note, y un sitio sin
# apt/ rompe el `apt upgrade` de todos. Eso falla, en rojo.

set -euo pipefail
# Que `set -e` valga también adentro de $(…): sembrar() corre ahí, y sin esto
# un paso que falla en el medio sembraría un commit con un árbol vacío.
# (El bash 3.2 de macOS no lo tiene; ahí sólo se usa `sitio`, que no siembra.)
shopt -s inherit_errexit 2>/dev/null || true
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

RAMA=${QM_PUBLICACION_RAMA:-publicacion}
REMOTO=${QM_PUBLICACION_REMOTO:-origin}
# De dónde se siembra la rama la primera vez.
BASE=${QM_PUBLICACION_BASE:-main}
# Lo generado. Todo lo demás de docs/ es de main y se edita por PR.
GENERADOS=(docs/apt docs/descargas.json)
SUITE=stable

falla() { echo "::error::$*" >&2; exit 1; }
aviso() { echo "::warning::$*"; }
salida() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

es_generado() {
  local g
  for g in "${GENERADOS[@]}"; do [ "$1" = "$g" ] && return 0; done
  return 1
}

# Trae la rama a refs/remotes/$REMOTO/$RAMA. Sale 1 sólo si la rama no existe:
# un error de red o de permisos corta acá, porque «no pude preguntar» no es
# «no existe» y confundirlos sembraría una rama nueva encima de la de verdad.
traer_rama() {
  local rc=0
  # La ref entera: el patrón suelto de ls-remote compara por la cola, y
  # «publicacion» también es refs/heads/cualquier-cosa/publicacion.
  git ls-remote --exit-code "$REMOTO" "refs/heads/$RAMA" >/dev/null || rc=$?
  case $rc in
    0) git fetch --quiet --no-tags "$REMOTO" "+refs/heads/$RAMA:refs/remotes/$REMOTO/$RAMA" \
         || falla "no pude traer $REMOTO/$RAMA" ;;
    2) return 1 ;;
    *) falla "no pude preguntarle a $REMOTO por la rama $RAMA (git ls-remote salió $rc)" ;;
  esac
}

# El sha256 de un archivo; en macOS no hay sha256sum, hay shasum.
suma() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# Escribe <ruta> del commit <ref> adentro de <destino>, con la misma ruta.
extraer() {
  git archive --format=tar "$1" -- "$2" | tar -x -C "$3"
}

# ── traer: lo de la rama, al checkout ───────────────────────────────────
# Para el que lee lo anterior antes de escribir: descargas.mjs guarda un
# historial de un renglón por día y «esta semana» se calcula contra él.
# Correrlo sobre la copia de main sería correrlo sobre un historial viejo.
cmd_traer() {
  [ $# -gt 0 ] || falla "uso: $0 traer <ruta>..."
  local r
  for r in "$@"; do es_generado "$r" || falla "$r no es de lo generado (${GENERADOS[*]})"; done
  if ! traer_rama; then
    aviso "la rama $RAMA no existe todavía: queda la copia de main de $*"
    return 0
  fi
  local ref="$REMOTO/$RAMA"
  for r in "$@"; do
    if git cat-file -e "$ref:$r" 2>/dev/null; then
      rm -rf "$r"
      extraer "$ref" "$r" .
      echo "· $r: de $RAMA ($(git rev-parse --short "$ref"))"
    else
      aviso "$r no está en $RAMA: queda la copia de main"
    fi
  done
}

# ── sembrar: la rama, la primera vez ────────────────────────────────────
# Un commit sin padres con lo que $BASE tiene de lo generado, tomado tal cual
# —mismos blobs— del árbol de $BASE. Imprime el sha del commit.
sembrar() {
  git fetch --quiet --no-tags "$REMOTO" "$BASE" || falla "no pude traer $REMOTO/$BASE para sembrar $RAMA"
  local base hay=() g indice arbol
  base=$(git rev-parse FETCH_HEAD)
  for g in "${GENERADOS[@]}"; do
    git cat-file -e "$base:$g" 2>/dev/null && hay+=("$g")
  done
  [ ${#hay[@]} -gt 0 ] || falla "la rama $RAMA no existe y $BASE no tiene ninguno de ${GENERADOS[*]}." \
    "No la siembro vacía: el historial de descargas.json y el repo de apt empezarían de cero sin que" \
    "nadie lo note. Si la rama se borró, recreala desde su último commit."
  aviso "la rama $RAMA no existe: la creo con lo que $BASE tiene en $(git rev-parse --short "$base") (${hay[*]})" >&2
  indice=$(mktemp)
  rm -f "$indice"
  git ls-tree -r "$base" -- "${hay[@]}" | GIT_INDEX_FILE=$indice git update-index --index-info
  arbol=$(GIT_INDEX_FILE=$indice git write-tree)
  rm -f "$indice"
  git commit-tree "$arbol" -m "lo generado, sembrado desde $BASE ($(git rev-parse --short "$base"))" \
    -m "${hay[*]} vivían en $BASE y los comiteaban los workflows. Desde acá viven en la rama $RAMA."
}

# Empuja HEAD a la rama. Si rebota es que otro workflow empujó en el medio —la
# release y el conteo diario escriben archivos distintos, así que el rebase no
# choca—: se pone encima de lo suyo y se vuelve a intentar.
empujar() {
  local intento
  for intento in 1 2 3 4 5; do
    if git push --quiet "$REMOTO" "HEAD:refs/heads/$RAMA"; then
      echo "· $RAMA ← $(git log -1 --format='%h %s')"
      salida subido si
      return 0
    fi
    echo "· el push a $RAMA rebotó (intento $intento): me pongo encima de lo que hay"
    sleep $((intento * 3))
    traer_rama || falla "la rama $RAMA desapareció en el medio del push"
    git rebase --quiet "$REMOTO/$RAMA" || { git rebase --abort || true; falla "el rebase sobre $REMOTO/$RAMA chocó"; }
  done
  falla "no pude empujar a $RAMA en cinco intentos"
}

# ── guardar: lo del checkout, a la rama ─────────────────────────────────
cmd_guardar() {
  [ $# -ge 2 ] || falla "uso: $0 guardar <mensaje> <ruta>..."
  local mensaje=$1 r inicio
  shift
  for r in "$@"; do
    es_generado "$r" || falla "$r no es de lo generado (${GENERADOS[*]})"
    [ -e "$r" ] || falla "$r no existe en el checkout: no hay nada que guardar"
  done
  if traer_rama; then inicio="$REMOTO/$RAMA"; else inicio=$(sembrar); fi

  arbol=$(mktemp -d)
  trap 'cd "$raiz"; git worktree remove --force "$arbol" >/dev/null 2>&1 || rm -rf "$arbol"' EXIT
  git worktree add --quiet --detach "$arbol" "$inicio"

  for r in "$@"; do
    rm -rf "${arbol:?}/$r"
    mkdir -p "$arbol/$(dirname "$r")"
    cp -a "$r" "$arbol/$r"
  done

  cd "$arbol"
  # Con rutas, `git add` también anota lo que se borró adentro: el .deb de la
  # versión anterior sale del pool igual que salía de main.
  git add -- "$@"
  if git diff --cached --quiet && [ "$inicio" = "$REMOTO/$RAMA" ]; then
    echo "· $RAMA: sin cambios en $*"
    salida subido no
    return 0
  fi
  git diff --cached --quiet || git commit --quiet -m "$mensaje"
  empujar
}

# ── sitio: lo que sirve GitHub Pages ────────────────────────────────────
# docs/ de este checkout, y encima lo generado de la rama: cada ruta generada
# se REEMPLAZA entera, no se mezcla, para que un .deb viejo que quedó en docs/
# de main no aparezca en el pool al lado del nuevo.
cmd_sitio() {
  [ $# -eq 1 ] || falla "uso: $0 sitio <salida>"
  local out ref="" g rel tmp padre
  # La salida se vacía entera, así que se mira ANTES de tocar nada: ni «.», ni
  # el repo, ni algo que lo contenga, ni algo adentro de docs/.
  case "$(basename "$1")" in .|..|/) falla "la salida tiene que ser un directorio con nombre: $1" ;; esac
  padre=$(dirname "$1")
  mkdir -p "$padre"
  out="$(cd "$padre" && pwd -P)/$(basename "$1")"
  case "$out/" in
    "$raiz/" | "$raiz/docs/"*) falla "la salida no puede ser el repo ni quedar adentro de docs/: $out" ;;
  esac
  case "$raiz/" in
    "$out/"*) falla "la salida no puede contener al repo: $out" ;;
  esac
  rm -rf "$out"
  mkdir -p "$out"
  cp -a docs/. "$out/"

  if traer_rama; then
    ref="$REMOTO/$RAMA"
  else
    aviso "la rama $RAMA no existe: la página sale con la copia de main de lo generado"
  fi
  for g in "${GENERADOS[@]}"; do
    rel=${g#docs/}
    if [ -n "$ref" ] && git cat-file -e "$ref:$g" 2>/dev/null; then
      rm -rf "${out:?}/$rel"
      tmp=$(mktemp -d)
      extraer "$ref" "$g" "$tmp"
      mv "$tmp/$g" "$out/$rel"
      rm -rf "$tmp"
      echo "· $rel: de $RAMA ($(git rev-parse --short "$ref"))"
    elif [ -e "$out/$rel" ]; then
      if [ -n "$ref" ]; then aviso "$g no está en $RAMA: va la copia de main"; fi
      echo "· $rel: de main"
    else
      falla "$g no está ni en $RAMA ni en main: la página saldría sin eso"
    fi
  done

  comprobar "$out"
  echo "sitio armado en $out: $(find "$out" -type f | wc -l) archivos"
}

# Lo mínimo para que `apt update` y la página anden. Si algo de esto falta, el
# despliegue no ocurre y queda el anterior, que es el error que se quiere: el
# otro —publicar un repo de apt a medias— se ve en la máquina de cada usuario.
comprobar() {
  local out=$1 f mal=0 apt="$1/apt/dists/$SUITE"
  for f in CNAME index.html descargas.json apt/legios.gpg \
           "apt/dists/$SUITE/Release" "apt/dists/$SUITE/InRelease" "apt/dists/$SUITE/Release.gpg" \
           "apt/dists/$SUITE/main/binary-all/Packages" "apt/dists/$SUITE/main/binary-all/Packages.gz"; do
    [ -s "$out/$f" ] || { echo "::error::falta $f, o está vacío" >&2; mal=1; }
  done
  [ "$mal" -eq 0 ] || exit 1

  # Cada .deb que el índice promete, en el pool.
  while read -r f; do
    [ -f "$out/apt/$f" ] || { echo "::error::Packages promete apt/$f y no está" >&2; mal=1; }
  done < <(sed -n 's/^Filename: //p' "$apt/main/binary-all/Packages")

  # Las sumas del Release, contra los índices que hay al lado: un Release de
  # una corrida con el Packages de otra es un `apt update` que rechaza todo.
  for f in main/binary-all/Packages main/binary-all/Packages.gz; do
    local dice tiene
    dice=$(awk -v f="$f" '/^SHA256:/{s=1;next} /^[^ ]/{s=0} s && $3==f {print $1}' "$apt/Release")
    tiene=$(suma "$apt/$f")
    if [ -z "$dice" ] || [ "$dice" != "$tiene" ]; then
      echo "::error::el Release no tiene la suma de $f que hay en el sitio" >&2; mal=1
    fi
  done

  # Y las dos firmas, con la clave que se publica al lado, como las mira apt.
  if command -v gpgv >/dev/null && command -v gpg >/dev/null; then
    local llavero
    llavero=$(mktemp -d)
    # Con un GNUPGHOME propio, para no tocar el llavero de quien lo corra.
    GNUPGHOME=$llavero gpg --batch --quiet --dearmor -o "$llavero/legios.gpg" "$out/apt/legios.gpg"
    gpgv --quiet --keyring "$llavero/legios.gpg" "$apt/InRelease" 2>/dev/null \
      || { echo "::error::la firma de InRelease no verifica con apt/legios.gpg" >&2; mal=1; }
    gpgv --quiet --keyring "$llavero/legios.gpg" "$apt/Release.gpg" "$apt/Release" 2>/dev/null \
      || { echo "::error::Release.gpg no verifica el Release con apt/legios.gpg" >&2; mal=1; }
    rm -rf "$llavero"
  else
    aviso "sin gpg/gpgv acá: las firmas del repo de apt no se comprobaron"
  fi

  [ "$mal" -eq 0 ] || exit 1
  echo "· apt: índices, sumas, firmas y pool en orden"
}

orden=${1:-}
[ $# -gt 0 ] && shift
case "$orden" in
  traer) cmd_traer "$@" ;;
  guardar) cmd_guardar "$@" ;;
  sitio) cmd_sitio "$@" ;;
  *) sed -n '5,7p' "$0" | sed 's/^# *//' >&2; exit 2 ;;
esac
