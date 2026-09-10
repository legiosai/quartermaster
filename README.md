# quartermaster

Cuánta cuota te queda, en todas tus cuentas de agentes: cada perfil de Claude
Code y, si está instalado, Codex.

> **Misión.** Que nadie se entere de que se quedó sin cuota chocándose contra el
> límite.

Ver [`SOUL.md`](SOUL.md) para la métrica, los non-goals y la apuesta falsable.

## Instalar

```sh
brew install legiosai/tap/quartermaster        # macOS y Linux
npm install -g @legios/quartermaster           # cualquier lado
```

En Debian y Ubuntu, el `.deb` de la [última
release](https://github.com/legiosai/quartermaster/releases/latest):

```sh
sudo apt install ./quartermaster_0.1.2_all.deb
```

O desde el repo, sin instalar nada global:

```sh
git clone https://github.com/legiosai/quartermaster && cd quartermaster
npm install && make instalar    # deja `qm` en ~/.local/bin
```

Necesita **Node >= 22.6**: `qm` lee el TypeScript sin paso de build, y eso
recién existe desde ahí. El lanzador lo busca en el `PATH` y en las versiones de
nvm; si no encuentra uno que sirva, lo dice y explica cómo conseguirlo. Por eso
el `.deb` depende de `nodejs` a secas y no de `nodejs (>= 22.6)`: Debian 13 trae
un 20, y pedir 22.6 haría un paquete que no se instala en ninguna parte por una
razón que además no es cierta —la versión nueva suele estar en nvm, que apt no
ve—. Mejor un paquete que instala y avisa.

El `.deb` se arma con `scripts/hacer-deb.sh`, que no compila nada: el paquete es
el fuente más un enlace en `/usr/bin`, y por eso es `Architecture: all`.

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
| **H6** verlo sin ir a buscarlo | ✅ mecanismo | `make indicador` en GNOME · `make tray` en Windows · `make web` en el navegador · `qm --breve` en la statusline de Claude Code |
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

## Elegir qué se muestra

Descubrir todo es la misión; **mostrar** todo es una preferencia. Con cuatro
cuentas la barra de menú ya no entra, y una cuenta que no usás es ruido
permanente.

```bash
qm --solo=codex,personal     # sólo esas
qm --ocultar=teams           # todas menos esa
```

o fijo, en `~/.config/quartermaster/config.json`:

```json
{ "ocultar": ["main"] }
```

Se acepta el nombre corto (`main`, `personal`, `teams`, `codex`) o el completo
del perfil. `mostrar` gana sobre `ocultar`. Como todos los que dibujan leen el
JSON de `qm`, la selección vale igual en la terminal, en la barra y en el
tablero, sin configurar nada tres veces.

Un detalle que es una regla del repo: **si el filtro no coincide con ninguna
cuenta, se muestran todas** y se dice que el filtro no pegó. Casi siempre es un
nombre mal escrito, y quedarse con una pantalla vacía y sin explicación es
exactamente el bug que motivó todo esto.

## Sumar otra herramienta: Gemini, GLM, MiniMax

La pregunta no es «¿se puede?» sino **de dónde sale el número**. Un proveedor
tiene que contestar tres cosas, y sólo la primera es obligatoria:

| | Qué es | Si falta |
|---|---|---|
| **1. Qué cuentas hay** | descubrir directorios/credenciales | no hay fila |
| **2. Cuánta cuota queda** | barras con % y reinicio | hay fila y una frase que dice por qué no hay número |
| **3. Cuánto consumiste** | el piso local, de transcripciones | se informa `null`, nunca `0` |

Hoy hay dos formas resueltas, y las dos sirven de molde:

- **Claude Code** — la cuota está en `.claude.json` (H5) y el endpoint es el
  refresco (H2).
- **Codex** — la cuota está en los rollouts y el app-server es el refresco. El
  consumo sale de los mismos archivos.

### GLM y MiniMax: estaban adentro de opencode

No hacía falta un CLI propio de cada uno. Los dos planes viven en **opencode**,
y opencode deja en `~/.local/share/opencode/opencode.db` una tabla `session` con
`model`, `cost` y cinco columnas de tokens. O sea: **el piso está**, local, sin
red y sin credencial, igual que las transcripciones de Claude y los rollouts de
Codex.

```
minimax    MiniMax-M3    2,7M en 7d · 2 sesiones
glm        glm-5.3       837,3k en 7d · 1 sesión
openai     gpt-5.6-sol   549,3k en 7d · 4 sesiones
grok       —             0 en 7d · último uso hace 8d21h
kimi       —             0 en 7d · último uso hace 14d18h
```

El descubrimiento y el consumo son dos preguntas distintas: las cuentas se
listan por **último uso** (30 días) y no por lo que gastaron en la ventana. Si
sólo se listara lo segundo, una cuenta que usás cada tanto desaparecería de la
lista — y «no aparece» es exactamente lo que este repo existe para que no pase.
Grok aparece con 0 en la semana y la fecha real al lado.

Dos decisiones:

- **No se lee `auth.json` de opencode.** Los proveedores se descubren de la base
  de sesiones, que además dice cuáles se usaron de verdad y no cuáles están
  configurados. La única forma segura de no filtrar una clave es no leerla.
- **La cuota no se inventa.** Son planes por API key: el porcentaje sólo existe
  en el endpoint de cada proveedor y hace falta la clave para pedirlo. La fila
  trae consumo y una frase que dice por qué no hay barra — nunca un 0 % que
  parezca un dato. Es un estado nuevo y explícito, `sin-cuota-legible`, distinto
  de «no hay límites» y de «todavía no se escribió».

### Dos correcciones en la misma fila

La fila de un plan de opencode traía dos cosas mal, y las dos salieron de
mirarla en la pantalla, no de leer el código.

**El plan mostraba el modelo.** Donde las otras filas ponen `team_tier_1` o
`plus`, la de opencode ponía `glm-5.3`. Eso salía de `plan: c.modelo` — el id
del modelo más usado en la ventana. Un modelo no es un plan: no dice qué pagás,
y **cambia solo** cuando cambiás de modelo. Además ya estaba en el desglose por
modelo, que es su lugar, así que aparecía dos veces. Ahora ese campo lleva el
proveedor, y la columna significa lo mismo en todas las filas.

**Y el mapa de nombres no aplicaba nunca.** Las claves eran `zai-coding-plan`,
`minimax-coding-plan`, `kimi-for-coding`. El `providerID` que opencode guarda en
esta máquina es **`zai`** a secas. Verificado contra la base: los proveedores
reales son `zai`, `openai`, `amazon-bedrock`, `anthropic` y `opencode-go`. O sea
que el nombre lindo no se aplicaba y la fila se llamaba `zai` en vez de `glm`.
Ahora están las dos formas de cada uno, porque no hay motivo para creer que el
`providerID` sea estable entre instalaciones — y esa suposición es justo la que
falló acá.

Ojo con esto último si tenés scripts: la cuenta ahora se llama `glm`, así que un
`--solo=zai` o un `--ocultar=zai` hay que actualizarlo.

### Se probó de verdad antes de rendirse

No alcanza con decir «no se puede». Se buscó el porcentaje por los cuatro
caminos que había, con los endpoints reales sacados del binario de opencode:

| Camino | Resultado |
|---|---|
| Cabeceras en la base de opencode | sólo las de OpenAI (`x-codex-*`), y sólo en respuestas con error |
| `GET /models` con la clave | Z.ai **200**, MiniMax **200** — sin una sola cabecera `x-ratelimit-*` |
| Una llamada real de 1 token | MiniMax **200**, sin cabeceras. xAI **403**: el token OAuth que guarda opencode está vencido |
| Un archivo suyo en el disco | no existe |

**Pero la llamada real encontró otra cosa.** Z.ai contestó `429` con esto:

```json
{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted.
          Your limit will reset at 2026-09-11 18:35:24"}}
```

O sea que el porcentaje no existe, pero **los dos datos que se usan sí**:
¿me frenaron? y ¿cuándo me libero? Y no hace falta salir a la red para
tenerlos, porque **opencode guarda esas respuestas**: en su base hay límites
alcanzados por proveedor, con la fecha de reinicio adentro del texto —incluida
la ventana de 5 h de Grok—. Se leen del disco, gratis y sin credencial, igual
que todo lo demás.

Así que una cuenta de opencode que está frenada **sí muestra barra**: 100 %,
con su reinicio y su «libre en». Una que no lo está no afirma nada — dice
cuándo fue la última vez que la frenaron, porque un límite de la semana pasada
no dice nada de hoy.

Lo que encontré en esta máquina para la que falta:

- **Gemini CLI 0.59.0** — instalado, autenticado (`oauth-personal`). Pero en
  `~/.gemini` **no hay ningún número de cuota ni de uso**: hay credenciales,
  cuentas, `installation_id` y estado de UI, y nada más. Su límite además no es
  un porcentaje sino requests por día, así que ni siquiera encaja en la forma
  `VentanaCuota` sin decidir antes qué significa «80 %» ahí. Da para el punto 1
  hoy; el 2 necesita encontrarle una fuente, y el 3 un lugar donde cuente
  tokens, que tampoco aparece.
El molde está y la selección de arriba ya prevé que sobren cuentas: con siete,
`--ocultar` deja de ser un lujo.

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

Queda un item en la barra que **se dibuja**: un medidor vertical por cuenta, en
el orden del panel, más el glifo del producto y el número de la sesión. Es el
mismo dibujo que el item de la barra de macOS y con las mismas medidas — tres
cuentas entran en el ancho de una palabra:

```
✳ ▮ 8   ✳ ▮ 22   ‹› ▮ 42
```

El glifo dice QUÉ suscripción es —la forma, el producto; el color, cuál de
ellas—. El medidor es **siempre la semanal**, pintado por severidad. El número
es **siempre la sesión de 5 h**, que es la que contesta «¿puedo seguir ahora?»,
y se tiñe recién cuando aprieta. Sin marcas al lado del número: un `~` de
«cache viejo» pegado a la cifra obliga a saber qué significa para poder leer la
cifra, y la edad del cache ya está escrita con todas las letras en el panel.

Que un dibujo entre en la barra de GNOME depende de una puerta que la extensión
deja abierta sin documentar: si el nombre del ícono empieza con `/` lo toma como
un archivo, y si esa imagen es **ancha** —`width >= height * 1.5`— la dibuja a
lo ancho en vez de encajarla en el cuadrado de 16 px de un ícono. El archivo
además tiene que estar en un directorio escribible del usuario (va a
`~/.cache/quartermaster`), y el nombre se alterna entre dos porque el shell
cachea la textura por ruta: reescribiendo siempre la misma, el item se queda con
el dibujo viejo y parece que la cuota no se mueve.

**Click del medio: el panel** — el anillo de «lo primero que te frena», un
medidor de verdad por barra, la curva pegada a la que frena y el ritmo en rojo
cuando chocás antes del reinicio. Se cierra con un click afuera, con Escape, o
con otro click del medio.

Las cuentas que todavía no tienen número van juntas en una sola tarjeta al
final. Antes cada una gastaba una tarjeta entera para decir la misma frase, y en
una pantalla de 768 px el panel ya no entraba; juntas ahorran ~120 px y además
se leen mejor, porque no son tres misterios distintos sino un hecho con varios
nombres. Se agrupan por frase: dos cuentas pueden estar calladas por motivos
distintos, y ahí la frase importa.

Es el mismo contenido que el panel de la barra de macOS, pero **no es una copia
del dibujo**: acá va con la paleta de estado de Adwaita en vez de la de Apple,
con una tarjeta redondeada por cuenta —la «boxed list» con la que GNOME agrupa
cosas— en vez de líneas de pelo, y con cuerpos de letra más grandes, porque
Cantarell es más grande que la tipografía del sistema de Apple y con las medidas
de allá los renglones quedaban apretados y el texto rozando el borde.

El click izquierdo lo tiene tomado la extensión de AppIndicator: abre su propio
menú y no hay forma de enterarse de que pasó (su `AboutToShow` no llega hasta el
proceso). Se probó también la bandeja legacy XEmbed como salida —ahí el ícono es
una ventana nuestra— pero la bandeja lo fuerza a 16×16, que se lleva puestos los
medidores. Así que con AppIndicator ese menú quedó en **dos renglones**
—«Panel de cuota» y «Salir»— y ver el panel cuesta dos clicks. Para que cueste
uno está `make extension`, más abajo.
Antes repetía cada perfil con cada barra en bloques `█░`, que es lo único que
GNOME sabe dibujar ahí adentro: los items viajan por DBus y del otro lado la
extensión hace `label.set_text(...)`, texto pelado y sin markup. Un muro de
texto delante del dibujo bueno es peor que no tener menú.

El panel se arma con **un item de menú por tarjeta**, no como una sola
superficie. Un menú rueda item por item: con un único item más alto que la
pantalla no hay nada que rodar y el menú **no abre**, sin un error en ningún
lado. Venía midiendo 740 px contra 728 de área útil —entraba raspando— y en
cuanto creció dejó de abrirse. `make gate-dibujo` ahora falla si una tarjeta
sola pasa de 700 px.

**El panel es un `Gtk.Menu` propio** —popeado por este proceso, no por DBus— y
no una ventana suelta. La razón se midió: en este escritorio ninguna ventana
sostiene el foco. Se probaron los cuatro tipos (UTILITY, NORMAL, DIALOG,
POPUP_MENU) y las cuatro lo pierden solas entre 0,15 s y 4,6 s después de abrir,
sin que nadie toque nada, porque mutter se lo devuelve al lado Wayland. Cerrar
al perder el foco cerraba el panel solo; agarrar el asiento a mano tampoco
alcanzaba, porque un agarre de XWayland no ve los clicks que caen sobre una
ventana Wayland. Un menú de GTK, en cambio, agarra el puntero como lo agarra
cualquier menú del escritorio: el click afuera y el Escape salen gratis, y la
caja redondeada, la sombra y el fondo los pone el tema.

Dos detalles que cuestan una tarde si no están escritos:

- **Hay que pasarle un evento de disparo** a `popup_at_rect()`. El panel lo abre
  un mensaje de DBus, así que no hay ningún evento de GDK a mano; sin uno, GTK
  avisa `no trigger event for menu popup` y el agarre que toma se rompe solo a
  los pocos segundos — el menú se cerraba sin que nadie tocara nada. Con un
  evento sintético se queda abierto indefinidamente (medido: 20 s sin
  moverse).
- **El tiempo de ese evento va en `CURRENT_TIME`.** Pedirle la hora al servidor
  con `x11_get_server_time()` sobre la ventana raíz **cuelga el proceso**:
  escribe una propiedad y espera un `PropertyNotify` que la raíz nunca manda.

Y una trampa de tema que dejó el panel ilegible una tarde: GNOME dice
`color-scheme = prefer-dark`, pero **una app GTK3 no se entera sola** — su
`gtk-application-prefer-dark-theme` sigue en `False` y el menú que hace de fondo
se dibuja CLARO. El panel, pintado con los colores oscuros de GNOME, quedaba
blanco sobre blanco. Ahora se hacen las dos cosas: se le pasa la preferencia a
GTK, y los grises del dibujo se sacan del **color de texto del propio menú** —
que no puede mentir sobre qué fondo tiene debajo— en vez de un ajuste que puede
no corresponderse con él.

Sigue haciendo falta X11 para una sola cosa: `popup_at_rect()` contra la ventana
raíz, que es lo que pega el panel arriba a la derecha. Por eso el proceso arranca
con `GDK_BACKEND=x11`; al item de la barra no le cambia nada, es DBus puro.
`QM_SIN_X11=1` lo fuerza a Wayland, donde el panel abre igual pero lo ubica el
compositor.

`bin/qm-indicator --captura panel.png` dibuja el panel a un archivo sin abrir
ventana, y `--captura-item item.png` el item de la barra; `--claro` / `--oscuro`
fuerzan el tema. Son las mismas funciones de dibujo que usan el panel y la
barra, así que los PNG no son una segunda implementación que se parece.

Cuatro cosas lo hacen algo más que un reloj:

- **Pregunta él.** `qm --breve` lee del disco y no habla con nadie, que es lo
  que lo hace instantáneo — pero entonces el número es tan fresco como la última
  vez que *alguien* preguntó, y Claude Code refresca su propio cache cuando
  quiere: medido acá, **1 día y 11 horas** sin tocarlo, con la semanal 14 puntos
  abajo de la realidad (75 % en pantalla, 89 % de verdad). Así que el indicador
  corre `qm --calentar` él mismo, como ya hacían la barra de macOS y la bandeja
  de Windows, y deja el número en el cache para que las lecturas sigan siendo de
  disco. La cadencia es la misma de macOS —300 s de base, 240 arriba del 50 %,
  120 arriba del 75 %, 60 arriba del 90 %, con piso de 60 s— y sólo se refrescan
  las cuentas que se mueven: pedirle el número a una que va al 9 % es gastar un
  pedido para confirmar que no pasó nada.

  Con una corrección sobre la política de macOS: **una barra en 100 no cuenta
  como alta**. Ya no puede subir, así que hasta el reinicio no hay nada nuevo
  que leer —y el instante del reinicio se sabe sin preguntar—. Contándola, el
  sondeo se iba al piso de 60 s para mirar un número congelado: un pedido por
  minuto, a un endpoint que no es nuestro, para confirmar que seguís frenado.
- **Dice de cuándo es cada número.** Cada tarjeta cierra con `lecturas: cada
  ~4m · última hace 42s`, y el panel con `próxima lectura en 3m 16s`, que baja a
  la vista mientras lo mirás. El «cada cuánto» no es la cadencia que el programa
  se propone sino la **medida**: el historial se indexa por `medidoEn` —el
  instante que informa el servidor, no el momento en que qm miró el disco— así
  que cada muestra es una lectura real y los huecos entre muestras son los
  intervalos entre lectura y lectura. Va la mediana y no el promedio, porque una
  sola pausa larga (la máquina suspendida) no dice nada del ritmo normal.
- **Se entera solo.** Vigila el `.claude.json` de cada perfil con
  `Gio.FileMonitor`: cuando Claude Code refresca la cuota, el número cambia en
  el acto. Medido: de 82 % a 96 % en menos de 5 s sin reiniciar nada. El sondeo
  cada 5 min queda de red de seguridad.
- **Avisa sin que lo mires.** Notifica al cruzar 80 % y 95 % —por **todas** las
  barras, no sólo por la que frena: la semanal puede estar tranquila mientras la
  de sesión te para, y al revés— y cuando la proyección pasa a decir que tocás
  el techo *antes* del reinicio, que es el momento útil y no cuando ya chocaste.
- **Y avisa cuando te liberás**, que es el único aviso que sirve para hacer algo
  distinto ahora mismo: la ventana se reinició habiendo estado contra el techo.
  Un porcentaje solo no alcanza para verlo —3 % puede ser «recién empezás» o
  «acabás de salir de estar frenado»— así que se guarda el minuto de reinicio
  junto al número en `previos.json`: cuando el minuto cambia, la ventana es
  otra. Justo el momento en que dejaste de mirar la barra, porque no había nada
  que mirar.
- **No repite.** Cada aviso de umbral se recuerda por perfil, barra y minuto de
  reinicio, así que una ventana avisa una vez y vuelve a avisar recién en la
  siguiente. El de liberación no lleva memoria a propósito: tiene que sonar
  cada vez que pasa.

El icono acompaña: normal, `dialog-warning` desde 80 %, `dialog-error` al 95 %
o cuando la proyección dice que chocás. `bin/qm-indicator` no sabe qué es una
credencial: le pide el JSON a `qm` y dibuja.

Necesita el soporte de AppIndicator en GNOME —la extensión
`appindicatorsupport@rgcjonas.gmail.com`—, que es lo que convierte un
`StatusNotifierItem` en un item de la barra. Verificado en GNOME Shell 48.7
sobre Wayland. Para sacarlo: «Salir» en su propio menú, y
`rm ~/.config/autostart/quartermaster.desktop`.

Un detalle del click del medio que cuesta una tarde si no está escrito: el
objetivo de `set_secondary_activate_target()` tiene que ser un item que **viva
adentro del menú** y esté marcado visible. Con un widget suelto —o con uno sin
`show()`— libayatana descarta el evento y no dice nada. Y como el menú se
reconstruye en cada refresco, hay que volver a apuntarlo cada vez o el click
deja de hacer efecto en silencio.

### Un click, con extensión propia

```bash
make extension          # instala y habilita quartermaster@legios
make extension-quitar   # y lo deshace
```

`extension/quartermaster@legios` es una extensión de GNOME Shell de unas cien
líneas que **no sabe qué es una cuota**. Hace dos cosas: muestra el PNG que
dibuja `qm-indicator` y, cuando le hacen click, deja un pedido en un archivo
para que ese proceso abra su panel. Todo el dibujo y todos los números siguen
viviendo del lado de Python. A cambio, el item es nuestro y **el primer click
abre el panel** — y el segundo lo cierra.

Mientras la extensión está habilitada escribe `~/.cache/quartermaster/extension-viva`,
y al verlo `qm-indicator` pone su propio item de AppIndicator en `PASSIVE` para
que no queden dos diciendo lo mismo. No lo destruye: la extensión se puede
apagar en cualquier momento y el item vuelve solo, sin reiniciar nada.

La conversación va por archivos y no por DBus a propósito: son dos procesos que
ya comparten un directorio de cache, un `Gio.FileMonitor` de cada lado alcanza,
y no hay que registrar un nombre de bus ni una interfaz para decir «abrí el
panel». Con una trampa que hay que saber: **una escritura son varios eventos de
inotify** —se midieron tres, `changed`, `changed`, `changes-done-hint`— así que
el pedido se junta con un temporizador antes de atenderlo. Sin eso, un click
abría el panel y los dos eventos siguientes lo cerraban en el mismo instante, y
desde afuera parecía que el item no hacía nada.

**GNOME Shell no carga una extensión recién instalada en Wayland**: hay que
cerrar sesión y volver a entrar una vez. `ReloadExtension` está deprecada y
devuelve error, y `EnableExtension` sobre una que el shell todavía no vio
devuelve `false`.

### El gate que faltaba

`npm test` cubre el núcleo en TypeScript, y hasta acá eso era todo lo que
miraba el CI. Afuera quedaban las 1.400 líneas de Python que dibujan el panel y
el item, y la extensión de GNOME Shell. No es hipotético: sacando código muerto
de `bin/qm-indicator`, un corte demasiado ancho se llevó puesto el bloque entero
del panel —unas 700 líneas— y el archivo siguió compilando, así que el CI siguió
en verde. Se descubrió a mano.

```bash
make gate-dibujo
```

Mira tres cosas, en orden de qué tan barato es equivocarse: que el indicador
**compile**, que la extensión **parsee** —un error ahí lo ve GNOME al iniciar
sesión, que es el peor momento para enterarse— y que **dibuje**, con
`test/fixtures/panel.json` de entrada, saliendo con las medidas de siempre y con
píxeles adentro. Lo tercero es lo que no se puede reemplazar por un import: un
error de Cairo no rompe la importación del módulo.

Y el chequeo de píxeles no es decorativo: un PNG del tamaño correcto y
enteramente transparente pasa cualquier verificación de medidas sin haber
dibujado nada. Probado en rojo contra cuatro sabotajes en
[`numeros/gate-rojo.md`](numeros/gate-rojo.md).

## En la bandeja de Windows

```bash
make tray            # lo arranca ahora (desde WSL)
make tray-autostart  # y que arranque solo al iniciar sesión de Windows
```

El menú es el mismo dibujo que `VistaCuenta` en `bin/qm-barra.swift`: glifo del
producto, cuenta y plan, medidores redondeados con la paleta de estado,
porcentaje alineado a la derecha y un pie con el reinicio y la edad del cache.
En WinForms no se puede pintar un item de menú sin subclasear, así que cada
perfil se dibuja a un `Bitmap` y el `Bitmap` va adentro de un `PictureBox`
hosteado en el menú. El efecto es el mismo; el camino, no.

**El ícono es un anillo, no un número.** La primera versión dibujaba el
porcentaje adentro del ícono, como los medidores de batería. Se renderizó a
16×16 —el tamaño real de la bandeja a 96 dpi— y se miró: **un dígito se lee, dos
son una mancha.** Así que el número se fue al tooltip y al menú, y el ícono hace
lo que la barra de macOS ya hacía en su lugar: un medidor. El arco dice cuánto
va, el color dice cuánto importa, y las dos cosas sobreviven a 16 píxeles. La
pista del anillo es gris translúcido porque la barra de tareas puede ser clara u
oscura y el ícono no se entera.

**Y calienta el endpoint, como la barra de macOS.** Esto no es un detalle de
adorno: fue el bug. La primera versión sólo leía el disco, y en la máquina donde
se escribió esto el perfil por defecto **no tiene `cachedUsageUtilization` en su
`.claude.json`** — ni viejo ni nuevo: no está. Mientras tanto el endpoint
contestaba `weekly_scoped (Fable)` al **100 %**, `critical`. Una bandeja que sólo
mira el disco mostraba, con toda honestidad, «todavía no dejó cuota para este
perfil» al lado de un ícono verde, en una cuenta que estaba frenada. Es
exactamente el silencio del que habla la primera sección de este README, con
otra causa.

Así que `qm --calentar` se dispara con la misma cadencia adaptativa que
`cadencia()` en Swift —300 s de base, 240 desde 50 %, 120 desde 75 %, 60 desde
90 %, y 60 si la proyección dice que faltan menos de 30 minutos para el techo— y
sólo para las cuentas que se mueven (≥ 40 %), porque refrescar una que va al 9 %
es gastar un pedido para confirmar que no pasó nada. Con `-SinCalentar` no se le
pide nada a la red y se vuelve al comportamiento de sólo-disco.

Hay una diferencia con macOS que es de Windows y no se puede evitar: el timer
corre en el hilo de la interfaz, así que el calentado **se dispara y se suelta**,
y el número que trae lo levanta el tick siguiente (30 s). Esperarlo ahí
congelaría el menú veinte segundos, que es peor que un número medio minuto
tarde.

Lo demás es igual a las otras dos: avisa al cruzar 80 % y 95 % y cuando la
proyección dice que tocás el techo antes del reinicio, y no repite —la clave del
aviso incluye el minuto de reinicio, así que una ventana avisa una vez y vuelve
a avisar recién en la siguiente—. La memoria de avisos vive en
`%LOCALAPPDATA%\quartermaster\avisados.json`.

Vale la misma regla que las otras dos: **sólo dibuja**. `bin/qm-tray.ps1` le
pide el JSON a `qm` por stdout y no sabe qué es una credencial ni un endpoint.
La regla de cuál barra manda no se reimplementa acá: llega resuelta en
`mostrar`, `frena`, `sesion` y `semanal`.

No necesita instalar nada: PowerShell y WinForms ya están en cualquier Windows.
`bin/qm-tray` es el lanzador del lado de WSL —traduce la ruta con `wslpath` y
lanza `powershell.exe`—; el proceso vive del lado de Windows, así que si cerrás
la terminal el tray sigue. Para sacarlo: «Salir» en su propio menú, o
`make tray-quitar`, que además borra el atajo del arranque automático.

**Lo que está verificado y lo que no**, para que esta sección no mienta:

- Verificado en Windows 11 con Windows PowerShell 5.1: arranca, dibuja el menú
  contra los perfiles reales de esta máquina, sobrevive los ticks, sale por
  `make tray-quitar`, y el atajo de arranque lanza un tray que anda.
- **El menú y el ícono se miraron, no se supusieron.** Los dos se renderizaron a
  PNG con los datos reales y se abrieron. Ahí se vio que los dígitos a 16×16 no
  servían.
- **Los avisos están probados en la lógica, no en pantalla.** Ningún perfil pasó
  de 80 % cuando se probó, así que se ejercitaron con una barra sintética al
  96 % y un `NotifyIcon` de mentira que anota los globos en vez de dibujarlos:
  dispara 80 y 95 con la severidad correcta, dispara el choque, **no repite** en
  la segunda pasada, y **vuelve a avisar** cuando cambia el minuto de reinicio.
  Lo que sigue sin verse es el globo de Windows en la pantalla.
- **Handles medidos, no supuestos.** `GetHicon()` entrega un handle que el GC no
  libera, así que se destruye a mano. Medido sobre el proceso vivo, en tres
  muestras a lo largo de 300 s: 639, 589, 615. Fluctúa sin subir.
- El `.ps1` está guardado **UTF-8 con BOM a propósito**: sin BOM, PowerShell 5.1
  lo lee como Windows-1252 y los acentos y las flechas salen rotos.
- **Dos colisiones de nombre, las dos del mismo tipo.** PowerShell no distingue
  mayúsculas, así que `$script:Mono` y el parámetro `$mono` eran la misma
  variable, y `$PALETA` empezó llamándose `$NIVEL` y la tapaba la local
  `$nivel`. Las dos aparecieron corriendo el código, no leyéndolo.

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
extension/        la extensión de GNOME Shell que se queda con el click
bin/              el lanzador que encuentra un Node, el indicador de GNOME, la
                  bandeja de Windows, la barra de macOS y el servidor del
                  tablero. Todos dibujan y nada más: le piden el JSON a qm y no
                  saben de credenciales ni de HTTP.
```

La regla es la de siempre: si un nombre de vendor o una ruta de sistema
operativo aparece fuera de `src/adapters/`, es un bug de diseño.

## Licencia

MIT.
