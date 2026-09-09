# quartermaster

Cuánta cuota te queda, en todos tus perfiles de Claude Code.

> **Misión.** Que nadie se entere de que se quedó sin cuota chocándose contra el
> límite.

Ver [`SOUL.md`](SOUL.md) para la métrica, los non-goals y la apuesta falsable.

## El problema

Claude Code soporta varios perfiles vía `CLAUDE_CONFIG_DIR`, y cada perfil tiene
su propia cuenta y su propia credencial. Un asiento de trabajo y una
suscripción personal en la misma laptop es completamente normal.

Los monitores que existen leen **una** credencial: la del directorio por
defecto. En la máquina donde se escribió esto eso significa leer `~/.claude`,
que está vacío, mientras las dos cuentas reales viven en `~/.claude-personal`
(Max) y `~/.claude-teams` (Teramot). El resultado observado fue un monitor
polleando cada 120 segundos durante horas, escribiendo `credential expired —
gating poll` en su log, y mostrando nada.

## Primer hallazgo: dónde está la credencial

En macOS el servicio del llavero de un perfil es **determinista**:

| Directorio de configuración | Servicio del llavero |
|---|---|
| `~/.claude` (por defecto) | `Claude Code-credentials` |
| cualquier otro | `Claude Code-credentials-<sha256(ruta absoluta)[:8]>` |

Verificado contra items reales del llavero. Eso convierte el soporte
multi-perfil en un cálculo, no en una heurística.

## Estado

| Hito | Estado | Número comiteado |
|---|---|---|
| **H0** perfiles y preflight | ✅ mecanismo | `make demo-h0` — descubre perfiles y dice cuáles autentican, no sólo cuáles existen |
| **H1** consumo local real | ✅ **número** | [`numeros/h1.json`](numeros/h1.json) — 9 340 requests deduplicados, 2,8 G de tokens en 7 días, 946 ms |
| **H2** poll de cuota en vivo | ⚠️ escrito, **nunca ejecutado** | quedó como *refresco* opcional: H5 da el número sin él |
| **H3** `--watch` y `--json` | ✅ mecanismo | `make qm`, `qm --json`, `qm --watch`, `qm --umbral=N` |
| **H4** Linux y Windows verificados | 🟨 Linux ✅, Windows ⏳ | [`numeros/h4-linux.md`](numeros/h4-linux.md) |
| **H5** cuota sin red ni credencial | ✅ **número** | [`numeros/h5-cuota.md`](numeros/h5-cuota.md) · [`h5-cuota.json`](numeros/h5-cuota.json) |
| **H6** verlo sin ir a buscarlo | ✅ mecanismo | `make indicador` en GNOME · `qm --breve` en la statusline de Claude Code |
| **H7** que te avise antes de chocar | ✅ mecanismo | proyección por mínimos cuadrados + avisos al 80/95 % y al detectar choque |

**Advertencias, para que el README no mienta:**

- **El endpoint de cuota sigue sin llamarse ni una vez.** Después de H5 importa
  mucho menos —el número sale del disco— pero `qm --refrescar` no está probado.
- **El número del cache puede estar viejo.** Se refresca sólo cuando ese perfil
  corre Claude Code. `qm` imprime la edad siempre y la marca a partir de 6 h.
- **Windows no está verificado.** El adaptador asume
  `<directorio>/.credentials.json` igual que Linux. Es posible que Claude Code
  use DPAPI o el Credential Manager. Hay que probarlo antes de afirmar nada.
- **macOS va a abrir un prompt del llavero por perfil** si se usa `--refrescar`.
  El camino por defecto ya no toca el llavero.

## Segundo hallazgo: la cuota ya está en el disco

Claude Code guarda en el `.claude.json` de cada perfil la última respuesta de
cuota que recibió, bajo `cachedUsageUtilization`. El número de cuota **es un
dato de disco**: no hace falta red, y sobre todo **no hace falta credencial**,
así que se lee igual en un perfil con el token vencido — que es exactamente el
estado en el que la herramienta que motivó este repo se quedaba muda.

Y trae un segundo silencio, este adentro de un mismo perfil. La respuesta
incluye un array `limits[]` con barras que **no** tienen clave propia arriba:

| Barra | % | Severidad | ¿activa? | Alcance |
|---|---:|---|---|---|
| `session` (= `five_hour`) | 8 | normal | no | — |
| `weekly_all` (= `seven_day`) | 59 | normal | no | — |
| **`weekly_scoped`** | **75** | **warning** | **sí** | modelo Fable |

`seven_day_opus`, `seven_day_sonnet` y otras diez venían `null`. Un monitor que
lea `five_hour` y `seven_day` —las dos que documenta la statusline— informa
**8 %**, se ve cómodo, y esconde la única barra con aviso. En esa cuenta el
error es de 67 puntos. Detalle y medición en
[`numeros/h5-cuota.md`](numeros/h5-cuota.md).

## La misma falla en Linux, y peor

`numeros/h4-linux.md` es la primera corrida fuera de macOS. Encontró 4 perfiles,
y con ellos una versión del problema original más difícil de notar: acá el
directorio por defecto **no** está vacío. Tiene 1,2 G de tokens y se ve
perfectamente sano.

> Un monitor que sólo lee `~/.claude` en esa máquina muestra un número
> creíble que deja afuera el **58,2 %** de los tokens y el **54 %** de los
> requests, todos del perfil de trabajo.

Un directorio vacío se nota. Un número que parece bien y está a la mitad, no.

## De dónde sale el endpoint de cuota

No está documentado. Se leyó del binario que Claude Code instala
(`node_modules/@anthropic-ai/claude-code/bin/claude.exe`), que contiene el call
site:

```
fetchUtilization: GET /api/oauth/usage (attempt
fetchUtilization: 200 after
```

La **forma** de la respuesta ya no se adivina: `cachedUsageUtilization` guarda
esa misma respuesta, y de ahí salieron las fixtures de `test/fixtures/`. Eso
confirmó lo que este README sospechaba antes de tener con qué probarlo: la
documentación de statusline embebida en el binario describe lo que Claude Code
**republica** (`used_percentage`, epoch en segundos), no lo que **recibe**
(`utilization`, ISO con offset). Un parser escrito sólo contra esa doc habría
leído mal las fechas.

Corolario operativo: **el endpoint puede desaparecer sin aviso**, y por eso ni
las transcripciones ni el cache son un fallback opcional (ver `SOUL.md`).

## Instalación

```bash
npm install
make instalar        # enlaza bin/qm en ~/.local/bin
qm                   # ya anda desde cualquier lado
```

`bin/qm` **busca solo un Node ≥ 22.6**: mira `$QM_NODE`, después el del `PATH`,
después las versiones de nvm de mayor a menor. Hace falta porque qm se lee
directo del TypeScript, y en una máquina donde `node` es un 20 —lo normal si el
sistema trae uno y las versiones nuevas viven en nvm, que sólo se carga en
shells interactivos— un shebang común falla con un error de sintaxis que no le
dice nada a nadie.

## Uso

```bash
qm                     # cuota y consumo de todos los perfiles.
                       # Sin red y sin credencial: la cuota sale del disco
qm --breve             # un renglón, en milisegundos. Para una statusline
qm --refrescar         # además pide el número al endpoint (token vigente)
qm --json              # para scripts
qm --watch 60          # se redibuja cada 60 s
qm --umbral=80         # código de salida 3 si alguna barra pasa el 80 %

make demo-h0           # ¿qué perfiles hay y cuáles autentican?
make demo-h1           # consumo de los últimos 7 días, por perfil
make numero-h5         # regenera numeros/h5-cuota.json, ya redactado
```

Requiere **Node ≥ 22.6** (lee TypeScript directamente, no hay paso de build).

## ¿Vas a chocarte antes de que se reinicie?

Es la pregunta que ni el porcentaje ni el consumo contestan solos. «Vas 75 %»
no dice nada sin saber a qué velocidad subís.

qm guarda una serie de lecturas por barra y le ajusta una recta:

```
ritmo: 12.4 pts/h · 100 % en 1h58m — antes del reinicio
```

Lo que importa no es la recta, es **cuándo no se dibuja**. Con dos lecturas, o
con una ventana que recién arranca, cualquier extrapolación es un número
inventado con cara de dato. Entonces dice:

```
ritmo: todavía no sé el ritmo: hacen falta 3 lecturas y hay 1
```

«No sé si te vas a chocar» y «no te vas a chocar» son cosas distintas y se
muestran distinto. Dos guardas más: se descartan las lecturas de más de 2 h
—el ritmo de hace cuatro horas no predice el de ahora— y no se proyecta sobre
un movimiento menor a 2 puntos, porque el servidor manda enteros y subir uno
no se distingue de un redondeo.

La serie vive en `~/.cache/quartermaster/historial.jsonl` y se indexa por el
`medidoEn` de la cuota, no por el momento en que qm miró: leer diez veces el
mismo cache deja **una** muestra.

## En la barra de arriba de GNOME

```bash
make indicador     # lo arranca ahora
make autostart     # y que arranque solo al iniciar sesión
```

Queda un item en la barra que dice, por ejemplo:

```
main 75%! · teams 40%
```

y que al desplegarlo muestra cada perfil con todas sus barras, la edad del
cache, y el motivo cuando un perfil no tiene número. `!` es una barra que el
servidor marcó con aviso; `~` es un cache de más de 6 horas.

Tres cosas lo hacen algo más que un reloj:

- **Se entera solo.** Vigila el `.claude.json` de cada perfil con
  `Gio.FileMonitor`: cuando Claude Code refresca la cuota, el número cambia en
  el acto. Medido: de 82 % a 96 % en menos de 5 s sin reiniciar nada. El sondeo
  cada 5 min queda de red de seguridad.
- **Avisa sin que lo mires.** Notifica al cruzar 80 % y 95 %, y cuando la
  proyección pasa a decir que tocás el techo *antes* del reinicio — que es el
  momento útil, no cuando ya chocaste.
- **No repite.** Cada aviso se recuerda por perfil, barra y minuto de reinicio,
  así que una ventana avisa una vez y vuelve a avisar recién en la siguiente.

El icono acompaña: normal, `dialog-warning` desde 80 %, `dialog-error` al 95 %
o cuando la proyección dice que chocás. `bin/qm-indicator` no sabe qué es una
credencial: le pide el JSON a `qm` y dibuja.

Necesita el soporte de AppIndicator en GNOME —la extensión
`appindicatorsupport@rgcjonas.gmail.com`—, que es lo que convierte un
`StatusNotifierItem` en un item de la barra. Verificado en GNOME Shell 48.7
sobre Wayland. Para sacarlo: «Salir» en su propio menú, y
`rm ~/.config/autostart/quartermaster.desktop`.

## En la statusline de Claude Code

Es donde la herramienta cumple su misión: el número deja de ser algo que te
acordás de mirar y pasa a estar siempre a la vista. `--breve` no toca las
transcripciones, así que tarda ~85 ms en vez de un segundo.

En el `settings.json` del perfil:

```json
{
  "statusLine": { "type": "command", "command": "qm --breve" }
}
```

Sale así, con `!` para la barra que el servidor marcó con aviso y `~` para un
cache de más de 6 horas:

```
main 75%! · teams 40%
```

Ojo con lo que **no** hace: el cache se refresca cuando ese perfil corre Claude
Code, así que la statusline de un perfil se actualiza usándolo. Es suficiente
para la mecánica que importa —enterarte de que vas al 75 % mientras trabajás—
y no para vigilar un perfil que no estás usando.

## Diseño

```
src/core/         perfiles, tipos. No sabe de llaveros ni de HTTP.
src/adapters/     credenciales (llavero / archivo), transcripciones (JSONL),
                  cuota del cache (.claude.json) y del endpoint (HTTP), y el
                  parser de la forma de utilización que comparten los dos.
src/render/       barras y formato. Sin dependencias.
src/cli/          qm (el comando) y las demos de cada hito.
bin/              el lanzador que encuentra un Node, y el indicador de GNOME.
                  El indicador dibuja: le pide el JSON a qm y no sabe de
                  credenciales ni de HTTP.
```

La regla es la de siempre: si un nombre de vendor o una ruta de sistema
operativo aparece fuera de `src/adapters/`, es un bug de diseño.

## Licencia

MIT.
