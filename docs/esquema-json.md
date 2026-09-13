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
