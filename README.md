# quartermaster

Cuánta cuota te queda, en todas tus cuentas de agentes: cada perfil de Claude
Code y, si está instalado, Codex.

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
| **H2** poll de cuota en vivo | ✅ **número** | [`numeros/h2-endpoint.md`](numeros/h2-endpoint.md) — ejecutado por fin: con 95 min de cache, la sesión estaba **11 puntos** abajo y las semanales 0-2 |
| **H3** `--watch` y `--json` | ✅ mecanismo | `make qm`, `qm --json`, `qm --watch`, `qm --umbral=N` |
| **H4** Linux y Windows verificados | 🟨 Linux ✅, Windows ⏳ | [`numeros/h4-linux.md`](numeros/h4-linux.md) |
| **H8** Codex en la misma tabla | ✅ mecanismo | cuota del disco (rollouts) + refresco por app-server + consumo local; `src/adapters/codex.ts` |
| **H5** cuota sin red ni credencial | ✅ **número** | [`numeros/h5-cuota.md`](numeros/h5-cuota.md) · [`h5-cuota.json`](numeros/h5-cuota.json) |
| **H6** verlo sin ir a buscarlo | ✅ mecanismo | `make indicador` en GNOME · `make web` en el navegador · `qm --breve` en la statusline de Claude Code |
| **H7** que te avise antes de chocar | ✅ mecanismo | proyección por mínimos cuadrados + avisos al 80/95 % y al detectar choque |

**Advertencias, para que el README no mienta:**

- **El cache se equivoca en la sesión, no en las semanales.** Medido en
  [`numeros/h2-endpoint.md`](numeros/h2-endpoint.md): con 95 minutos de cache,
  las semanales estaban 0-2 puntos abajo y la **sesión 10 y 11**. La ventana de
  5 h se llena veinte veces más rápido que la de 7 días, así que la misma vejez
  duele veinte veces más. Para la pregunta urgente —«¿puedo seguir ahora?»— el
  disco solo no alcanza: hay que refrescar.
- **Las ramas de error del endpoint siguen sin ejecutarse.** Contestó bien en
  todos los perfiles; token vencido a mitad de camino y endpoint caído siguen
  sin probarse.
- **El número del cache puede estar viejo.** Claude Code lo refresca cuando
  quiere —medido: reescribió `.claude.json` 19 s antes y el bloque de cuota
  seguía siendo de hacía 83 minutos—. `qm` imprime la edad siempre.
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

## La otra cuenta: Codex

Un asiento de trabajo, una suscripción personal y **una cuenta de Codex** en la
misma laptop es tan normal como lo anterior, y la pregunta es la misma: ¿me
queda cuota? Desde `src/adapters/codex.ts`, `qm` la contesta para las dos
herramientas en la misma tabla.

```
codex              vos@ejemplo.com                · plus
                   credencial: la pone codex · 2 reset(s) sin usar
                   cache · hace 1m
                 ▸ session                  ███████████████ 100% warning reinicia en 27m
                   weekly_all               ██████████░░░░░  67% reinicia en 139h04m
                   local: 13,0M en 7d · 5,3M en 5h · 443 requests
```

### Una corrección

La primera versión de este README decía, en negrita, que **Codex no deja la
cuota en el disco**. Era falso. Se habían mirado tres rollouts de junio, que
traían `rate_limits: null`, y se generalizó a partir de ahí — el mismo error de
método que el repo le critica a los monitores que leen una sola credencial.

Los rollouts nuevos (codex-cli 0.153.4) **sí la traen**, adentro de los eventos
`token_count`, con el timestamp al lado. Así que Codex no es la excepción a H5:
es otro caso de H5. **El camino por defecto es el disco**, sin red y sin
credencial, y el app-server queda como refresco — lo que `--refrescar` es para
Claude. Medido: 212 ms para encontrar la lectura más nueva entre 138 rollouts.

Dos trampas que costaron un rato y que están cubiertas por tests:

- **Codex escribe varios baldes de límites.** Después del bueno
  (`limit_id: "codex"`) manda uno de `limit_id: "premium"` con `primary: null`.
  Quedarse con el último devolvía ese, y descartarlo descartaba el archivo
  entero — con el número bueno adentro, unos milisegundos antes.
- **Las dos puntas escriben distinto.** El rollout usa `snake_case`
  (`used_percent`, `rate_limit_reached_type`) y el app-server `camelCase`. Se
  normaliza en un solo lugar, y hay un test que exige que las dos den
  exactamente lo mismo: si divergen, el número cambia según de dónde salió, que
  es peor que no tener número. Ese test encontró que `rate_limit_reached_type`
  no se leía del disco, así que «ya te frenó» no marcaba nada.

### Y el piso, que también estaba

Los mismos rollouts tienen `total_token_usage`, así que Codex tiene el consumo
local que pide `SOUL.md`: aunque el app-server se caiga **y** el disco no traiga
barras, sigue habiendo un número. Se suma el último acumulado de cada sesión, no
los parciales, para no contar dos veces.

Tres decisiones más:

- **No tocamos su credencial.** Al app-server se le habla por el binario
  `codex`, que usa la suya. El mail y el plan salen de los claims del `id_token`
  que Codex ya guardó — se leen, no se copian.
- **Los nombres de las ventanas se igualan por duración.** El servidor manda
  `primary` y `secondary`, que no dicen nada; 300 minutos es la misma pregunta
  que la `session` de Claude, y 10 080 es la semanal. Igualarlos es lo que deja
  comparar las dos cuentas en la misma columna.
- **`codex` no se busca en el PATH y ya.** launchd arranca con
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; hay un `rutaCodex()` que mira también
  los lugares de siempre, y `QM_CODEX` para forzarlo.

## Instalación

```bash
npm install
make instalar        # enlaza bin/qm y bin/qm-web en ~/.local/bin
qm                   # ya anda desde cualquier lado
qm-web               # y el tablero también
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
qm --sin-codex         # no mirar la cuenta de Codex
qm --calentar-codex    # refresca sólo el cache de Codex, sin imprimir nada
qm-web                 # el tablero en el navegador, se redibuja cada 30 s

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

## En el navegador

El indicador de GNOME es la respuesta para GNOME. `qm-web` es la misma idea
donde no hay barra de GNOME —macOS, Windows, un Linux con otro escritorio—: un
tablero que se abre en el navegador y se redibuja solo cada 30 s.

```bash
make web              # levanta el tablero y abre el navegador
qm-web --puerto=8080  # en otro puerto (por defecto 7391)
qm-web --sin-abrir    # sólo imprime la URL
```

Muestra, de arriba abajo: **lo primero que te frena** —la peor barra de toda la
máquina, con su cuenta regresiva al reinicio corriendo en vivo y la proyección
si la hay—, y después una tarjeta por perfil con todas sus barras, la edad del
cache, el consumo local de la ventana y el desglose por modelo. Un perfil sin
número muestra la frase que dice por qué, igual que en la terminal.

Vale la misma regla que el indicador: **sólo dibuja**. `bin/qm-web` le pide el
JSON a `qm` por stdout y no sabe qué es una credencial ni habla HTTP con nadie.
Escucha únicamente en `127.0.0.1` — el tablero muestra mails y planes, y
`SOUL.md` dice que nada sale de la máquina.

Es JavaScript común, no TypeScript, a propósito: corre con cualquier Node ≥ 18 y
el requisito de 22.6 queda donde de verdad hace falta, adentro de `qm`.

## En la barra de menú de macOS

```bash
make barra             # lo compila la primera vez y lo arranca
make barra-autostart   # y que arranque solo al iniciar sesión, vía launchd
make barra-quitar      # para sacarlo
```

Queda un item arriba a la derecha que **se dibuja**. Por cada cuenta, tres
cosas, y cada una quiere decir siempre lo mismo:

```
✳ ▍37    ✳ ▍21    <> ▍100
```

- **El glifo dice qué suscripción es.** La *forma* es el producto —el asterisco
  es la marca de Claude, los chevrones son código—; el *color*, cuál de ellas.
  Esos colores son azul, violeta y magenta: deliberadamente lejos de la paleta
  de estado, porque los colores de estado están reservados y no pueden
  significar además «esta es la cuenta 2».
- **El medidor es la semanal**: ¿llego al final?
- **El número es la sesión de 5 h**: ¿puedo seguir ahora? Se tiñe con su propio
  estado, pero recién cuando aprieta — si se pintara siempre, el color dejaría
  de querer decir algo.

Antes el medidor mostraba «la que frena antes», que a veces era la semanal y a
veces la sesión — y cuando era la sesión dibujaba lo mismo que ya decía el
número al lado. Un encoding que cambia de significado según el dato no se lee de
un vistazo, que es lo único que hace la barra de menú.

`~` va pegado al número, porque califica a *ese* número: `~37` es «esta sesión
es de hace rato».

Cuando no entra, la escalera saca primero los glifos y **el número es lo último
que se cae**. Antes era al revés y el item quedaba mudo justo en la parte que se
viene a mirar: la identidad se recupera del orden y del menú, el número no se
recupera de nada.

Es lo que se hace en una barra de menú de macOS —una marca chica y callada, no
un renglón de texto— y además es lo único que entra: **91 puntos contra los 192
del renglón horizontal**, medido. Esa diferencia es la que decide si el sistema
lo muestra o lo esconde.

El item y que al desplegarlo muestra cada
cuenta con su ícono (asterisco para Claude, chevrones para Codex; SF Symbols no
trae los logos y estos dos se distinguen de un vistazo), con todas sus barras con todas sus barras, la edad del
cache, la proyección y el motivo cuando un perfil no tiene número. `!` es una
barra que el servidor marcó con aviso; `~` es un cache de más de 6 horas. Vale
la misma regla que el indicador de GNOME: **sólo dibuja**, le pide el JSON a
`qm --json --breve` (~150 ms, no toca las transcripciones) y no sabe qué es una
credencial.

Se compila con `swiftc`, que viene con las Command Line Tools: no hace falta
Xcode entero, ni empaquetar una `.app`, ni instalar SwiftBar ni nada. El binario
queda en `~/.cache/quartermaster/`, no en el repo. Se recompila solo cuando el
fuente cambia.

Al desplegarlo, cada cuenta es una fila **dibujada** —`VistaCuenta`, no un
renglón de texto—: ícono del producto, cuenta y plan, y después cada barra con
su medidor, su porcentaje, cuándo se reinicia, la edad del cache sobre la que
manda, y el ritmo en rojo cuando la proyección dice que chocás. Los bloques
`█░` de antes eran una tabla ASCII adentro de una app nativa.

Hace lo mismo que en GNOME: se entera solo (vigila el `.claude.json` de cada
perfil con `DispatchSource`, y se re-arma cuando Claude Code reescribe el
archivo por rename, que mata el descriptor), avisa al cruzar 80 % y 95 % y
cuando la proyección dice que chocás antes del reinicio, y no repite.

### Llegar tarde es la otra forma de mentir

Codex subió del 23 % al 100 % en cuarenta minutos y la barra mostró 93 %
durante siete de ellos. Mostraba la edad, así que no mentía — pero un número
que llega tarde a esa velocidad no sirve para nada. Fueron **tres** bugs
apilados, y ninguno hacía ruido:

- **App Nap.** Una app sin ventanas es el candidato perfecto, y macOS le corre
  los timers: un sondeo de 5 minutos no disparó en 7. Se arregla con
  `ProcessInfo.beginActivity` y timers con `tolerance = 0` en `.common`.
- **Cadencia fija.** Cinco minutos es inservible para una barra que sube 1,6
  puntos por minuto: se llega al 100 % adentro de una sola espera. Ahora la
  cadencia sale de lo que ya sabemos —cuán alto está y cuánto falta para el
  techo según la proyección—: 20 s arriba del 90 %, 45 s arriba del 75 %, 120 s
  arriba del 50 %, 5 min si no pasa nada. Y se recalcula **al terminar de
  dibujar**, que es cuando se conoce el estado; programarla en el arranque, con
  el estado todavía vacío, la dejaba clavada en 5 minutos.
- **El PATH de launchd.** `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, y `codex` vive
  en `/opt/homebrew/bin`. `spawn('codex')` fallaba **en silencio** justo en la
  instalación que importa —la que arranca sola— mientras andaba perfecto desde
  una terminal. Es el mismo bug que `bin/qm` ya resolvía para Node, y estaba sin
  resolver para Codex: ahora hay un `rutaCodex()` que busca en el PATH y en los
  lugares de siempre, y `QM_CODEX` para forzarlo.

Medido después: refrescos cada 21 s con la sesión al 100 %.

### Y avisar de más es no avisar

Los avisos se recordaban **en memoria**, así que cada arranque volvía a
notificar todo lo que ya estaba cruzado — y arrancar pasa seguido: reinstalar,
actualizar, reiniciar sesión. Con Codex al 100 % eso son tres notificaciones
por arranque, siempre las mismas. Un aviso marca un *cruce*; repetirlo en cada
arranque es ruido, y el ruido enseña a ignorarlos, que es exactamente lo
contrario de lo que tienen que lograr.

Ahora se persisten en `~/.cache/quartermaster/avisados.json`, con la misma clave
de siempre (perfil, barra, minuto de reinicio, umbral), así que sobreviven al
reinicio y la ventana siguiente vuelve a avisar sola. El aviso de «no entro en
la barra» tampoco se re-arma: se re-armaba al volver a entrar, y un item que
oscila entre visible y tapado avisaba en cada vuelta.

### Y Claude también llegaba tarde, por otro motivo

Codex era el que se veía, pero Claude tenía el mismo problema con otra causa:
**Claude Code refresca su propio `cachedUsageUtilization` cuando quiere.**
Medido: reescribió `.claude.json` 19 s antes y el bloque de cuota seguía siendo
de hacía 83 minutos, con la sesión 11 puntos abajo de la realidad. Mirar el
disco más seguido no arregla nada — el número del disco no se mueve.

Lo que lo arregla es H2, que por fin se ejecutó: `qm --calentar` le pide el
número al endpoint de cada perfil y al app-server de Codex, y lo guarda. Con
Claude hay un detalle que no es opcional: **la lectura fresca no se puede
guardar donde Claude Code guarda la suya**. `.claude.json` es de él; este repo
lee credenciales y configuración, no las escribe. Así que va a un cache propio
(`~/.cache/quartermaster/endpoint.json`) y `qm` usa **la más nueva de las dos**,
la de Claude Code o la nuestra, mostrando siempre la edad de la que ganó.

El resultado es que `--breve` sigue tardando milisegundos y ya no lee un número
de hace hora y media: la barra calienta el cache en su sondeo adaptativo y las
lecturas rápidas encuentran algo de hace segundos.

### El título se mide, no se elige

La barra de menú de una Mac con muesca tiene mucho menos lugar del que aparenta.
Los items se acomodan de derecha a izquierda y **el sistema esconde, sin decir
nada y con `isVisible` en `true`, al que caería abajo de la muesca**. Medido en
la máquina donde se escribió esto: `NSScreen.auxiliaryTopRightArea` daba 645
puntos a la derecha de la muesca, ya ocupados, y
`personal ~50% · teams 42%` necesita 192.

Por eso el texto no se elige: hay una **escalera** —el porcentaje con su marca,
el porcentaje pelado, y nada— y se prueba uno, se mide dónde quedó, y si no
entró se sigue con el siguiente. Los medidores no se negocian: son 30 puntos y
dicen lo esencial aunque el número se caiga. En una Mac sin muesca o en un
monitor externo entra el primero y se ve una cuenta por renglón.

### Diseñar a ciegas fue el error

Nada de esto se podía ver: `screencapture` no sirve para mirar la barra —con
varias pantallas se muda a la que tiene el foco, y encima el sistema esconde el
item sin avisar—, así que las tres primeras versiones se dibujaron sin verlas y
las tres estuvieron mal. La última, la de dos renglones, salía **recortada por
arriba** y nadie se enteró hasta que hubo con qué mirarla.

Por eso existe `qm-barra --captura ruta.png`: el item se renderiza a sí mismo
sobre los dos fondos que puede tocarle y escribe dos PNG. No depende de qué
pantalla mire nadie. Cualquier cambio al dibujo se mira ahí antes de creerle.

```bash
qm-barra --captura /tmp/barra.png   # escribe barra-claro.png y barra-oscuro.png
```

Otro detalle que costó una tarde: el test de «no entró» **no puede ser
`frame.minX < 0`**. En una pantalla ubicada a la izquierda de la principal las
coordenadas globales son negativas y el item se ve perfecto; hay que comparar
contra el `frame` de su propia pantalla.

Y si ni el compacto entra, **lo dice**: notifica una vez, porque un número que
no se ve es el mismo bug que el silencio. La salida en ese caso es la de macOS:
**cmd-arrastrar** el item a un hueco de la barra (queda guardado, el item tiene
`autosaveName`), liberar algún ícono, o mirar el tablero con `make web`.

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
personal 23/75%! · teams 9/42% · codex 49/59%
```

Son **dos números por cuenta a propósito**: el primero es la sesión y el segundo
la barra que te frena antes. Contestan preguntas distintas —«¿puedo seguir
ahora?» y «¿llego al final de la semana?»— y una sola de las dos deja media
respuesta. Cuando la que frena ES la sesión, se muestra un número solo.

Ojo con lo que **no** hace: el cache se refresca cuando ese perfil corre Claude
Code, así que la statusline de un perfil se actualiza usándolo. Es suficiente
para la mecánica que importa —enterarte de que vas al 75 % mientras trabajás—
y no para vigilar un perfil que no estás usando.

## Diseño

```
src/core/         perfiles, tipos. No sabe de llaveros ni de HTTP.
src/adapters/     credenciales (llavero / archivo), transcripciones (JSONL),
                  cuota del cache (.claude.json) y del endpoint (HTTP), el
                  parser de la forma de utilización que comparten los dos, y
                  codex (JSON-RPC contra su app-server, con cache propio).
src/cli/          qm (el comando) y las demos de cada hito.
src/render/       barras y formato para la terminal, y tablero.html para el
                  navegador. Sin dependencias.
bin/              el lanzador que encuentra un Node, el indicador de GNOME y el
                  servidor del tablero. Los tres dibujan y nada más: le piden el
                  JSON a qm y no saben de credenciales ni de HTTP.
```

La regla es la de siempre: si un nombre de vendor o una ruta de sistema
operativo aparece fuera de `src/adapters/`, es un bug de diseño.

## Licencia

MIT.
