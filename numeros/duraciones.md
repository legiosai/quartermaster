# Las duraciones eran dos convenciones, no un bug

**Encontrado y cerrado el 2026-09-10.**

El repo tiene cuatro implementaciones de la misma escalera de duración, una por
lenguaje. La regla de que todas den lo mismo estaba escrita en los comentarios
de tres de ellas. No la daban, y lo interesante es que **no era que a una le
faltara una rama: eran dos convenciones enteras**, tres GUIs de un lado y el CLI
del otro, en tres puntos a la vez.

Medido corriendo las cuatro con los mismos segundos, no leyendo el código:

| segundos | CLI (`src/render/barras.ts`) | Swift, PowerShell, Python |
|---|---|---|
| −1 | `vencido` | `ya` |
| 3600 | `1h00m` | `1h` |
| 3660 | `1h01m` | `1h1m` |
| 11280 | `3h08m` | `3h8m` |
| 86400 | `1d` | `1d0h` |
| 604800 | `7d` | `7d0h` |

## Por qué sobrevivió

Las dos partes que lo tocaron el mismo día usaron el mismo método —poner dos
renderizadores lado a lado con los mismos datos— y eligieron anclas distintas:

- Una comparó el panel de Windows contra el de GNOME, vio `127d19h` contra
  `3067h28m`, y alineó Python con Swift y PowerShell.
- La otra comparó el panel de GNOME contra el CLI y lo alineó con `barras.ts`.

**Nadie había comparado una GUI contra el CLI.** Tres de los cuatro coincidían
entre sí, así que cualquier comparación entre GUIs daba tranquilizadoramente
bien. La mayoría no era el canon: era el error repetido tres veces.

## Cómo se cerró

Ganó el CLI. `src/render/barras.ts` dice de sí mismo «todo lo que se imprime pasa
por acá», es la única con tests, y un panel que cuenta distinto que la terminal
el mismo reinicio no se puede distinguir de una mentira. Swift, PowerShell y
Python se alinearon.

Y la tabla dejó de ser un acuerdo entre comentarios: está congelada en
`test/fixtures/duraciones.json`, sacada corriendo el CLI, y
`scripts/gate-duraciones.py` **ejecuta las cuatro** y las compara contra ella.

Probado en rojo:

| Sabotaje | Qué dijo el gate |
|---|---|
| sacarle la rama de día justo a Python | `86400 s → esperaba '1d', dio '1d0h'` |
| exigir `pwsh` donde no está | `falta pwsh, y este job lo exige` |

Lo segundo importa tanto como lo primero: en una laptop no hay ni `swift` ni
`pwsh`, y saltearlos es razonable; en CI, saltear en silencio convertiría el gate
en un adorno. Cada job declara con `QM_GATE_EXIGE` los intérpretes que su runner
trae — Ubuntu comprueba PowerShell, un runner de macOS comprueba Swift.
