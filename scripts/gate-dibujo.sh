#!/bin/sh
# El gate de las superficies que el CI de Node no mira.
#
# `npm test` cubre el núcleo en TypeScript. Fuera de eso hay 1.400 líneas de
# Python que dibujan el panel y el item de GNOME, y una extensión de GNOME Shell
# en JavaScript, y hasta ahora no las revisaba nadie: en esta misma máquina se
# borró medio bin/qm-indicator con un corte mal puesto y el archivo siguió
# pasando el CI, porque el CI ni lo abría.
#
# Tres cosas, en orden de qué tan barato es equivocarse:
#
#   1. que compile — un error de sintaxis no llega a ejecutarse nunca;
#   2. que la extensión parsee — un error ahí lo ve GNOME al iniciar sesión,
#      que es el peor momento para enterarse;
#   3. que DIBUJE. Esto es lo que no se puede reemplazar por un import: con una
#      entrada fija, el panel y el item tienen que salir con las medidas de
#      siempre y con píxeles adentro. Un error de dibujo —una llamada a Cairo
#      con un argumento de menos, una medida que no coincide con lo que pinta—
#      no rompe la importación del módulo.

set -e
raiz=$(cd "$(dirname "$0")/.." && pwd)
cd "$raiz"

salida=$(mktemp -d)
trap 'rm -rf "$salida"' EXIT

fallar() {
  echo "GATE ROJO: $1" >&2
  exit 1
}

python3 -m py_compile bin/qm-indicator || fallar "bin/qm-indicator no compila"

# node --check quiere que el archivo se vea como módulo; la extensión usa
# import/export y con extensión .js node la lee como CommonJS.
cp -f "extension/quartermaster@legios/extension.js" "$salida/ext.mjs"
node --check "$salida/ext.mjs" || fallar "extension.js no parsea"

python3 bin/qm-indicator --desde test/fixtures/panel.json --oscuro \
  --captura "$salida/panel.png" >/dev/null || fallar "no dibujó el panel"
python3 bin/qm-indicator --desde test/fixtures/panel.json --oscuro \
  --captura-item "$salida/item.png" >/dev/null || fallar "no dibujó el item"

python3 - "$salida/panel.png" "$salida/item.png" <<'PY'
import sys
import cairo

def medir(ruta):
    s = cairo.ImageSurface.create_from_png(ruta)
    datos = bytes(s.get_data())
    # Cuántos píxeles tienen algo. Un PNG del tamaño correcto y enteramente
    # transparente pasa cualquier chequeo de medidas y no dibujó nada.
    pintados = sum(1 for i in range(3, len(datos), 4) if datos[i] != 0)
    return s.get_width(), s.get_height(), pintados

fallas = []
ancho, alto, pintados = medir(sys.argv[1])
if ancho != 360:
    fallas.append(f"el panel salió de {ancho} px de ancho y tiene que ser 360")
if not 600 <= alto <= 2400:
    fallas.append(f"el panel salió de {alto} px de alto, fuera de lo razonable")
if pintados < ancho * alto // 2:
    fallas.append(f"el panel está casi vacío: {pintados} píxeles con algo")

ancho, alto, pintados = medir(sys.argv[2])
if alto != 22:
    fallas.append(f"el item salió de {alto} px de alto y tiene que ser 22")
# La proporción es lo que decide si GNOME lo dibuja a lo ancho o lo encaja en un
# cuadrado de 16 px. Abajo de 1.5 los medidores se vuelven ilegibles.
if ancho < alto * 1.5:
    fallas.append(f"el item quedó de {ancho}x{alto}: GNOME lo va a encajar en un cuadrado")
if pintados == 0:
    fallas.append("el item no tiene un solo píxel dibujado")

if fallas:
    for f in fallas:
        print(f"GATE ROJO: {f}", file=sys.stderr)
    raise SystemExit(1)
print("dibujo verificado: panel 360 px y item ancho, los dos con píxeles adentro")
PY

echo "gate de dibujo: verde"
