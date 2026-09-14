# `qm --json` — the contract

This output is not ours any more. Four surfaces in this repo read it, plus the
Claude Code statusline, the waybar module, and whoever writes their own. So it
has a version number, and rules about what can change.

*(Este documento está en inglés porque es la referencia para quien escribe un
consumidor. El razonamiento de cada campo está en el código, en castellano.)*

## The version

```json
{ "esquema": 1, "version": "0.1.6", ... }
```

- **`esquema`** is the contract. It goes up when a field **changes meaning or
  disappears**. Adding a field does not move it.
- **`version`** is the package version. It is there so a bug report says which
  build produced the output; it is not the contract.

If you consume this, check `esquema` and refuse loudly on a number you do not
know. A renderer that silently draws garbage is the failure this whole project
exists to avoid.

## The shape

```jsonc
{
  "esquema": 1,
  "version": "0.1.6",
  "generado": "2026-09-13T02:45:11.367Z",  // ISO 8601, UTC
  "plataforma": "linux",                   // process.platform
  "ventanaDias": 7,                        // the local-usage window, --dias
  "perfiles": [ … ]                        // one per ACCOUNT, not per machine
}
```

Each entry of `perfiles`:

```jsonc
{
  "producto": "claude",          // "claude" | "codex" | "opencode"
  "perfil": ".claude-teams",     // the config directory's name
  "directorio": "~/.claude-teams",
  "cuenta": "quien@ejemplo.com", // null if unknown. --redactado masks it
  "plan": "claude_max",
  "credencial": "vigente (6h02m)",   // a SENTENCE, for humans. Never a token.
  "cuota": { … },
  "proyeccion": { … } | null,
  "presupuesto": { … },
  "local": { … }                 // tokens and requests read from transcripts
}
```

### `presupuesto`

```jsonc
{
  "estado": "ok",
  "barra": "weekly_all",
  "porDia": 11.6,          // puntos por día, de AHORA al reinicio, para llegar justo
  "porDiaHoy": 11.9,       // el presupuesto de hoy: el porDia que había al arrancar la medición
  "gastadoHoy": 4.2,       // lo que subió la barra desde medianoche, o null
  "restanteHoy": 7.7,      // porDiaHoy - lo gastado, piso 0; null si gastadoHoy es null
  "restanteMedido": 7.7,   // lo mismo cubra el día o no; null si no hay medición
  "quedaHoy": 5.8,         // el reparto a ritmo parejo de las horas que faltan HOY
  "gastadoMedido": 4.2,    // lo que subió desde medidoDesde, cubra el día o no
  "medidoDesde": "2026-09-13T03:00:00.000Z",  // desde cuándo vale, o null
  "cubreElDia": true,      // si medidoDesde es la medianoche
  "restante": 80, "horasHoy": 12, "horasRestantes": 167
}
```

**`porDia` es de ahora en adelante; `porDiaHoy` es el de hoy.** `porDia` se
calcula con el porcentaje actual, que ya tiene adentro todo lo gastado hoy.
Restarle lo gastado contaba cada punto dos veces: medido el 2026-09-14, una
cuenta que a las 09:27 iba 9 % con 135,5 h al reinicio mostraba «podés gastar
14.3 %/día · gastaste 14.0 % · te queda 0.3 %», cuando el presupuesto de ese día
era 91 / 5,65 = 16,1 y quedaban 2,1. Gastar exactamente el presupuesto te
declaraba pasado. `porDiaHoy` es el `porDia` que había en la lectura con la que
arranca la medición (o en la primera después de un reinicio de la ventana), y
`restanteHoy` / `restanteMedido` le restan a ÉSE lo gastado desde entonces.
Sin medición, `porDiaHoy` es igual a `porDia`. Los que dibujan leen la resta
hecha: no la calculan.

**`quedaHoy` no es «lo que te queda de hoy».** Es el reparto a ritmo parejo de
las horas que faltan del día, y no le resta lo gastado. Con la cuota quieta baja
sola con el reloj: medido el 2026-09-13, de 10,5 a 0,5 a lo largo de un día en
el que no se gastó nada. La frase decía «hoy te queda X %», que promete una
resta que no ocurre — se lee como budget y se calcula como reloj.

Lo que sí contesta esa pregunta es **`restanteHoy`**, que sale de `gastadoHoy`:
la suma de los saltos HACIA ARRIBA de la barra desde la medianoche. Sólo los de
subida, porque una ventana se puede reiniciar en medio del día —una semanal real
fue de 84 % a 6 %— y restar la última menos la primera daría −78 puntos.

`gastadoHoy` es **`null`** cuando el historial no cubre el arranque del día (más
de media hora entre la medianoche y la primera lectura, sin una de ayer que diga
con cuánto se llegó). `null` es «no se pudo medir», no «no gastaste nada»: con
la primera lectura a las 03:10 no se sabe qué pasó antes, y suponer que no pasó
nada es inventar.

**`gastadoMedido`** es lo mismo sin exigir que el día esté cubierto, y
**`medidoDesde`** dice desde qué instante vale: la medianoche cuando
`cubreElDia` es `true`, y la primera lectura de hoy cuando no. Existe porque la
máquina apagada de noche es el caso normal, no la excepción: en una portátil que
se prende a las nueve, `gastadoHoy` es `null` TODOS los días, y los medidores
diarios de las tres bandejas —que se llenan con `gastadoMedido / porDia`— no
dibujarían nunca. Decir «gastaste 12 % desde las 09:14» no es inventar: es
exactamente lo que se midió, con su alcance escrito al lado. Lo que no se puede
hacer es llamarlo «hoy», y por eso son dos campos y no uno.

Es `null` sólo cuando no hay dos lecturas del día: ahí no hay ninguna subida que
mirar, y la frase cae al reparto por hora, dicho como lo que es: «de acá a
medianoche te toca X %».

**La medianoche es la del proceso que corre `qm`.** Si lo lanza la bandeja de
Windows contra un `qm` de adentro de WSL, esa WSL puede estar en UTC aunque
Windows no: la bandeja pasa `TZ` con el nombre IANA de la zona de la máquina
justamente para que «hoy» sea el día del reloj que el usuario tiene delante.

### `ultimoUso`

A sibling of `local`, **not** a field inside it — and the difference matters.

`local` is `null` under `--breve`, correctly: those are consumption counts that
were not measured, and reporting `0` would say "you used nothing" when the truth
is "I did not measure". `ultimoUso` is a different kind of fact — *when*, not
*how much* — and it is measured differently: one `stat` per transcript, nothing
parsed. So it exists in **both** modes.

That placement is the whole point. Its consumer is the GNOME item's polling
loop, and that loop runs `--breve`. Inside `local` the field was written and
never reached the one caller that needed it.

```jsonc
"ultimoUso": "2026-09-13T19:15:42.186Z"   // or null
```

It is the newest timestamp across the profile's transcripts — when this
account was last actually used. It is `null` where it cannot be measured (Codex
and the opencode providers do not expose it per account); `null` means *not
known*, never *not used*.

It exists because **level does not predict movement**. A bar at 2% tells you how
much is left; it does not tell you whether the number is about to change. The
account you are using right now is the one whose number is moving, whatever the
level. The GNOME item uses this to decide which accounts to re-read from the
endpoint.

> Measured 2026-09-13 with two sessions open: a team account sitting at 2% got
> **one** endpoint read in 55 minutes, because the warm-up filtered by level
> (`40 <= tope < 100`) and everything below 40% was treated as quiet.

### `cuota`

When it worked:

```jsonc
{
  "estado": "ok",
  "origen": "cache" | "endpoint",
  "medidoEn": "2026-09-12T21:20:51.199Z",
  "edadSegundos": 7558,
  "ventanas":  [ … ],   // EVERY bar the server sent
  "mostrar":   [ … ],   // the ones worth showing
  "frena":     { … } | null,   // the one that stops you FIRST
  "sesion":    { … } | null,
  "semanal":   { … } | null,
  "historia":  [ … ]    // recent samples of the bar that stops you
}
```

When it did not:

```jsonc
{ "estado": "sin-cache" | "vencida" | "sin-credencial" | "ilegible" | "sin-suscripcion",
  "frase": "Claude Code todavía no dejó cuota en .claude.json …" }
```

**There is always either a number or a sentence.** Never silence — that is the
one rule in `SOUL.md` that touches every field here.

### `mostrar`, `frena`, `sesion`, `semanal` — read these

These are **the resolved answer**, and they are the reason this contract exists.

`ventanas` is raw: every bar the server sent, including ones with no famous key
that live inside `limits[]`. Deciding which one matters is a rule — a warning
bar at 75% must not hide behind a calm 8% — and that rule lives **once**, in
`src/core/tipos.ts`.

It did not always. `peor()` and `paraMostrar()` were once copied into Python,
JavaScript and Swift at the same time, which means three answers the day someone
edits one. So: **if your renderer needs to reimplement a rule, that is a bug in
the CLI, not something to copy.** Open an issue and the field will be emitted.

Each window:

```jsonc
{
  "clave": "weekly_scoped",      // the server's key
  "alcance": "Fable",            // scope, when the bar has one
  "grupo": "session" | "weekly" | null,
  "porcentaje": 75,
  "severidad": "normal" | "warning" | "critical",
  "activa": true,                // the server marked it as the binding one
  "reinicia": "2026-09-13T04:00:00.088Z",
  "nombre": "weekly_scoped (Fable)",   // ready to draw
  "preocupa": true,              // the resolved "should this worry you"
  "vencida": false               // `reinicia` is already in the past
}
```

### `vencida` — the number is from a window that already closed

`porcentaje` is always the last number actually read. `vencida` says that
reading predates `reinicia`, so it describes a window that has since rolled
over — the counter restarted and nobody has read it since.

This is not the same as "old". An old reading is a worse measurement of **the
same** window; a `vencida` one belongs to **a different** window. What the new
number is, we do not know: quota may have been spent since the reset. So
quartermaster does not invent a `0` — it keeps the last number and marks it.

A renderer must not present a `vencida` window as current. `preocupa` is always
`false` while `vencida` is `true`: holding a closed window's `critical` paints
the tray red and fires the "you are blocked" warning for something that ended.

> Measured 2026-09-13: a cached `weekly_all` at 96% and `weekly_scoped` at 100%,
> both `critical`, with a `resets_at` two hours earlier. One endpoint call
> returned 2% and 0%, both `normal`.

## Exit codes

| code | means |
|---|---|
| 0 | it answered |
| 2 | an option that does not exist |
| 3 | `--umbral=N` and some bar is above N% |

`qm --umbral` is meant for chaining, so code 3 is part of the contract too.

## What stays stable within `esquema: 1`

- Every field above keeps its meaning.
- New fields may appear. **Ignore what you do not know.**
- `frase` is prose for humans: read it, show it, do not parse it.
- `--redactado` removes emails and home paths, and nothing else changes shape.

## What is deliberately not here

- Tokens, and anything derived from a token. `SECURITY.md` explains.
- Per-project or per-conversation breakdowns. `local.porModelo` is as fine
  as it gets.

## If you write a consumer

`paquetes/waybar/qm-waybar` is ~100 lines and does exactly this: runs
`qm --json --breve`, reads `frena` and `sesion`, emits what its panel wants. It
is the shortest worked example, and it is in the repo.

Use `--breve` for anything that redraws on a timer: it skips transcripts, so it
costs milliseconds instead of a second.
