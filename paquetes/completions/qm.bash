# shellcheck shell=bash disable=SC2207
# El completado de qm para bash.
#
# Las banderas de abajo son una copia de las que documenta `qm --help`, y una
# copia se queda vieja en silencio: se agrega una bandera, el TAB no la ofrece y
# nadie se entera. test/completado.test.ts compara las dos listas y sale en rojo
# si difieren, así que una bandera nueva sin completado es un test roto.
#
# Los nombres de las cuentas, en cambio, no se copian: salen de
# `qm --json --breve`, que es la superficie para scripts y el camino rápido (no
# lee transcripciones). El campo es `perfil`, el mismo nombre que comparan
# --solo, --ocultar y --cuentas.
#
# Se instala en /usr/share/bash-completion/completions/qm (el .deb y el
# PKGBUILD) o en ~/.local/share/bash-completion/completions/qm (`make
# instalar`); bash-completion lo carga solo la primera vez que se tabula `qm`.
#
# SC2207 está apagado: es el COMPREPLY=($(compgen …)) de siempre, con IFS puesto
# a propósito, y mapfile no existe en el bash 3.2 de macOS.

_qm_cuentas() {
  qm --json --breve 2>/dev/null | sed -n 's/.*"perfil": *"\([^"]*\)".*/\1/p' | sort -u
}

_qm() {
  local banderas='--refrescar --json --watch --dias= --umbral= --esperar
    --cuenta= --redactado --breve --statusline --todas --mejor --aviso
    --idioma= --solo= --ocultar= --sin-codex --sin-antigravity --version
    --calentar --cuentas= --calentar-codex --diagnostico --desglose --help'

  # Después de `--` viene un comando (`qm --mejor -- claude`): eso no es de qm.
  local i
  for ((i = 1; i < COMP_CWORD; i++)); do
    if [[ ${COMP_WORDS[i]} == -- ]]; then
      type compopt &>/dev/null && compopt -o default 2>/dev/null
      COMPREPLY=()
      return
    fi
  done

  # La palabra entera, con su `=`: COMP_WORDS la parte en el `=` (está en
  # COMP_WORDBREAKS), y lo que importa es a qué bandera pertenece el valor.
  local linea=${COMP_LINE:0:COMP_POINT}
  local palabra=${linea##*[[:space:]]}
  # Lo que readline va a reemplazar: lo que sigue al último `=` si el `=` corta
  # palabras (lo normal), o la palabra entera si alguien lo sacó.
  local prefijo=''
  [[ $COMP_WORDBREAKS == *=* ]] || prefijo=${palabra%%=*}=

  local IFS=$'\n'
  case $palabra in
    --solo=* | --ocultar=* | --cuentas=*)
      # Listas separadas por comas: se completa la última, sin repetir las
      # que ya están.
      local valor=${palabra#*=} hechas='' n quedan=''
      [[ $valor == *,* ]] && hechas=${valor%,*},
      for n in $(_qm_cuentas); do
        [[ ,$hechas == *,"$n",* ]] || quedan+=$n$'\n'
      done
      COMPREPLY=($(compgen -P "$prefijo$hechas" -W "$quedan" -- "${valor##*,}"))
      ;;
    --cuenta=*)
      COMPREPLY=($(compgen -P "$prefijo" -W "$(_qm_cuentas)" -- "${palabra#*=}"))
      ;;
    --idioma=*)
      COMPREPLY=($(compgen -P "$prefijo" -W $'es\nen' -- "${palabra#*=}"))
      ;;
    --dias=* | --umbral=*)
      COMPREPLY=()
      ;;
    *)
      IFS=$' \t\n'
      COMPREPLY=($(compgen -W "$banderas" -- "$palabra"))
      # Las que esperan un valor pegado no llevan espacio atrás.
      if [[ ${#COMPREPLY[@]} -eq 1 && ${COMPREPLY[0]} == *= ]]; then
        type compopt &>/dev/null && compopt -o nospace 2>/dev/null
      fi
      ;;
  esac
}

complete -F _qm qm
