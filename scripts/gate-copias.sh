#!/usr/bin/env bash
# Gate contra la segunda copia de los gates.
#
# Los gates vivían en ci.yml y release.yml tenía los suyos: cinco pasos de los
# trece. Nadie lo hizo a propósito — se desincronizó solo. Un gate nuevo se
# agrega donde duele, que es el CI, y el job de la release se queda como estaba,
# EN VERDE, sin que nada lo señale. Así fue como gate-dibujo, gate-cambios,
# gate-duraciones, gate-lazo, gate-presupuesto, gate-calentado,
# gate-winget-rojo y gate-paquetes-rojo dejaron de mirar un tag, con la
# cabecera de release.yml diciendo «corre los MISMOS gates que el CI».
#
# Arreglarlo una vez no alcanza: la copia vuelve la próxima vez que alguien
# tenga apuro. Esto comprueba la forma que lo impide —un solo gates.yml, y los
# dos workflows delegando en él— y no la lista de gates, que es justo lo que
# vuelve a quedar desactualizado.
#
# Lo que se comprueba es de FORMA a propósito: si ci.yml corre un gate propio,
# es una copia aunque hoy diga lo mismo que gates.yml.

set -euo pipefail
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

fallas=0
fallar() { echo "✗ $1" >&2; fallas=$((fallas + 1)); }

GATES=.github/workflows/gates.yml
CI=.github/workflows/ci.yml
REL=.github/workflows/release.yml

# ── 1. gates.yml existe y es llamable ──────────────────────────────────
if [ ! -f "$GATES" ]; then
  fallar "no existe $GATES: los gates volvieron a vivir en cada workflow"
else
  grep -q 'workflow_call' "$GATES" \
    || fallar "$GATES no tiene 'on: workflow_call': nadie puede llamarlo"
fi

# ── 2. los dos workflows delegan ───────────────────────────────────────
for wf in "$CI" "$REL"; do
  grep -q 'uses: \./\.github/workflows/gates\.yml' "$wf" \
    || fallar "$wf no llama a gates.yml: o corre otra cosa, o no corre nada"
done

# ── 3. y ninguno corre gates por su cuenta ─────────────────────────────
# El CI no tiene nada que correr fuera de gates.yml. La release sí —arma el
# .deb, publica, firma el repo de apt—, así que acá se mira sólo que no vuelva
# a aparecer un `make gate-…` o un scripts/gate-… suelto: eso es la copia.
if grep -nE '^\s+- (run|name):' "$CI" >/dev/null 2>&1; then
  fallar "$CI tiene pasos propios: los gates del CI van en gates.yml"
fi

sueltos=$(grep -nE 'make gate-|scripts/gate-|el-paquete-de-npm-corre' "$REL" \
          | grep -v '^\s*#' | grep -vE '^[0-9]+:\s*#' || true)
if [ -n "$sueltos" ]; then
  fallar "$REL corre gates por su cuenta — ésa es la copia que se desincroniza:"
  echo "$sueltos" | sed 's/^/    /' >&2
fi

# ── 4. que gates.yml tenga de verdad los tres jobs ─────────────────────
# Delegar en un gates.yml vacío pasaría los tres puntos de arriba.
for job in check dibujo bandeja; do
  grep -qE "^  $job:" "$GATES" \
    || fallar "$GATES no tiene el job '$job': se delega en un archivo incompleto"
done

if [ "$fallas" -ne 0 ]; then
  echo "" >&2
  echo "  Hay una segunda copia de los gates. La de la release fue la que se" >&2
  echo "  quedó atrás la vez pasada, y estuvo ocho gates corta durante quince" >&2
  echo "  versiones sin que nada se pusiera rojo." >&2
  exit 1
fi

echo "✓ un solo gates.yml, y ci.yml y release.yml delegan los dos en él"
