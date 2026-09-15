# La cuenta dormida deja de encabezar

Medido el 2026-09-14, en la misma máquina y en el mismo minuto, comparando el
árbol de trabajo contra `HEAD` (`c910137`) levantado en un `git worktree`
aparte. Las dos corridas vieron exactamente las mismas cuentas: una de Claude
(`team_tier_1`, en uso) y una de Codex (`free`, sin usar hacía 21 días, clavada
en 100 % del semanal).

## El antes y el después

| | antes (`c910137`) | después |
|---|---|---|
| `lo primero que te frena` | `codex · weekly_all 100% · reinicia en 14d23h` | `.claude · weekly_all 36% · reinicia en 2d17h` |
| `qm --breve` | `main 19/36%! · codex 100%!` | `main 19/36%` |
| waybar (`text`) | `codex 100%!` | `main 19/36%` |
| `qm --umbral=80` | sale **3** | sale **0** |
| `qm --esperar` | `100 % · esperando 14d23h (reinicia 10:17:03 PM)` — cortado a los 40 s, seguía esperando | `libre: la barra que más apremia va 36 % (umbral 80 %)`, sale 0 al instante |

El renglón de `--esperar` es el que más duele. La bandera existe para encadenar
—`qm --esperar && codex exec …`— y con una cuenta abandonada en 100 % el comando
de la derecha no se iba a ejecutar en **quince días**. No es un problema de
presentación: es la herramienta impidiendo trabajar por una cuenta que nadie usa.

La cuenta de Codex **no se escondió** en ninguna de las dos corridas. Sigue
entera, con sus barras, su reinicio y su presupuesto; lo que cambió es que va al
final y dice por qué: `dormida: sin usar hace 7 días · plan free`.

## Qué señales había, y cuáles se usaban

Las cuatro ya se calculaban antes del cambio. Ninguna entraba en la decisión.

| señal | de dónde sale | qué decía de esa cuenta | se usaba para |
|---|---|---|---|
| `plan` | el proveedor | `free` | dibujarse al lado del mail |
| consumo local | transcripciones | 0 requests en 7 días | dibujarse en el pie de la tarjeta |
| `creditosReset` | Codex | `0 reset(s) sin usar` | pegarse dentro de una frase |
| `ultimoUso` | archivos de sesión | **no existía para Codex** (`null` fijo) | decidir a qué cuenta consultarle |

La última es la más elocuente: el código ya tenía el concepto de «esta cuenta no
se está moviendo», y lo aplicaba a no molestar a un endpoint ajeno — no a lo que
pone adelante de los ojos. Y para Codex, que es la cuenta que más lo necesitaba,
el campo venía en `null` fijo. Ahora sale del rollout más nuevo, con un `stat`
por archivo y ningún parseo, así que también vale en `--breve`.

## Seis copias de la misma decisión

Elegir QUÉ PERFIL encabeza estaba escrito seis veces: `src/cli/qm.ts`,
`bin/qm-indicator`, `bin/qm-barra.swift`, `bin/qm-tray.ps1`,
`src/render/tablero.html` y `paquetes/waybar/qm-waybar`. Las seis decían «el
`frena` con el porcentaje más alto» y coincidían sólo por casualidad: arreglar
una habría dejado las otras cinco con el criterio viejo. Ahora el CLI lo emite
resuelto en `frenaPrimero` y las seis lo leen — que es lo que
`CONTRIBUTING.md` pide desde el principio.

## El gate, en rojo

El cambio rompió algo **en silencio** mientras se hacía, y sirve como evidencia
de que el gate hacía falta: cuando la cabecera pasó a leerse de `frenaPrimero`,
los fixtures todavía no traían ese campo, así que el panel se dibujó **sin
cabecera** — 944 px en vez de 1008 — y `make gate-dibujo` siguió verde. Ningún
gate miraba si la cabecera estaba.

`make gate-dibujo-rojo` prueba los dos rojos:

```
✓ el gate falla en rojo cuando el panel se queda sin cabecera
✓ el gate falla en rojo cuando encabeza una cuenta dormida
```

## Lo que NO se midió

- **macOS y Windows.** `bin/qm-barra.swift` y `bin/qm-tray.ps1` están cambiados
  con el mismo criterio, pero esta máquina no tiene `swiftc` ni `pwsh`, así que
  no se compilaron ni se dibujaron. Faltan `make gate-dibujo` en una Mac y
  `make gate-bandeja` en Windows antes de confiar en esas dos pantallas.
- **Una cuenta paga sin usar hace un mes.** El caso que el criterio protege —no
  bajarla, porque es la que estás esperando que se libere— está cubierto por
  test (`test/relevancia.test.ts`) pero no se vio en una máquina real: haría
  falta una cuenta paga abandonada, y acá no hay.
- **Más de dos cuentas.** El fixture `panel.json` tiene cinco y se dibuja bien,
  pero la comparación antes/después se hizo con las dos cuentas reales.
