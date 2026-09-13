<div align="center">

<img src="docs/img/logo-256.png" alt="" width="96" height="96">

# quartermaster

**How much quota you have left — in every agent account on the machine.**
Every Claude Code profile, not just the default one, plus Codex and the
providers stored by opencode.

[Landing](https://quartermaster.legios.com.ar/) ·
[Install](#install) ·
[Releases](https://github.com/legiosai/quartermaster/releases) ·
[Security](SECURITY.md) ·
[En castellano](LEEME.md) ·
MIT

<sub>An instrument by</sub><br>
<a href="https://github.com/legiosai"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/legios.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/legios-claro.svg">
  <img alt="Legios" src="docs/legios-claro.svg" width="132" height="43">
</picture></a>

<img src="docs/img/barra.png" alt="The GNOME top bar with one meter per account" width="480">

</div>

> **Mission.** Nobody should find out their quota is gone by hitting the wall.

## The problem

Claude Code supports several profiles through `CLAUDE_CONFIG_DIR`, and each one
has its own account and its own credential. A work seat and a personal
subscription on the same laptop is ordinary.

Every monitor out there reads **one** credential: the default directory's. On
the machine this was written on, that means reading `~/.claude` — which is
empty — while the two real accounts live in `~/.claude-personal` and
`~/.claude-teams`. The observed result was a monitor polling every 120 seconds
for hours, logging `credential expired — gating poll`, and displaying nothing.

quartermaster finds every account, and reads the number from disk.

## Install

```sh
brew install legiosai/tap/quartermaster        # macOS and Linux
npm install -g @legios/quartermaster           # anywhere
```

**Windows:** the installer from the [latest
release](https://github.com/legiosai/quartermaster/releases/latest). Per-user
and no UAC: it puts `qm` on your `PATH`, the tray in the Start menu, and — if
you leave the box ticked — the tray in startup.

**Debian and Ubuntu:** the `.deb` from the same release, or the signed apt repo
([two lines](LEEME.md#instalar)).

**Arch:** a `PKGBUILD` in [`paquetes/aur/`](paquetes/aur/PKGBUILD).
**Nix:** `nix run github:legiosai/quartermaster`.

Needs **Node >= 22.6**: `qm` reads its own TypeScript with no build step, and
type stripping starts there. The launcher looks for a usable Node on the `PATH`
and in nvm, fnm and volta; if it cannot find one it says so and explains how to
get one, rather than dying with a syntax error.

## Use

```sh
qm                  # quota and usage for every account
qm --breve          # one line — this is what goes in a statusline
qm --json           # the same, for scripts and panels
qm --refrescar      # also ask the endpoint (needs a live token)
qm --watch 60       # redraw every N seconds
qm --umbral=80      # exit 3 if any bar is over N%
qm --esperar        # block until quota drops:  qm --esperar && codex ...
```

In Claude Code's `settings.json`:

```json
{ "statusLine": { "type": "command", "command": "qm --breve" } }
```

```
personal 23/75%! · teams 9/42% · codex 49/59%
```

**Two numbers per account, on purpose.** The first is the session; the second is
the bar that stops you first. They answer different questions — "can I keep
going right now?" and "do I make it to the end of the week?" — and either one
alone is half an answer.

## Where you can see it

| | |
|---|---|
| **Terminal** | `qm`, and `qm --breve` for a statusline — it skips transcripts, so it takes milliseconds |
| **GNOME** | an item in the top bar, panel on the first click. Ships its own Shell extension, because the AppIndicator one eats the left click |
| **macOS** | the menu bar, with live text next to the icon |
| **Windows** | the notification area, with the percentage drawn inside the icon like a battery meter |
| **Browser** | `qm-web` — a local dashboard on `127.0.0.1` only. Works everywhere |
| **waybar** | [`paquetes/waybar/`](paquetes/waybar/) — for Hyprland, Sway and river |

All of them only draw. The CLI resolves which bar wins and emits the resolved
answer in `qm --json` (`mostrar`, `frena`, `sesion`, `semanal`); no renderer
reimplements a rule. That is a design rule with a scar behind it: the same
function once lived in Python, JavaScript and Swift at the same time.

## What it reads, and what leaves the machine

The number needs **no network and no credential**. Claude Code stores the last
quota response it got in each profile's `.claude.json`, so quartermaster reads
it from disk — which means it still works on a profile whose token expired,
the exact state the motivating monitor died in.

The only thing that ever leaves is one request, and only when you ask for it
(`--refrescar`, or `--calentar`, which is what the panels run):

```
GET https://api.anthropic.com/api/oauth/usage
```

Same host Claude Code already talks to, same credential it already stored, with
a 60-second floor. No account, no cloud, no telemetry, and zero runtime
dependencies. **It never refreshes a token** — a locked non-goal, with a test.

The full table, and the straight paragraph about that endpoint being
undocumented, are in [`SECURITY.md`](SECURITY.md).

## Design

```
src/core/         profiles, types. Knows nothing about keychains or HTTP.
src/adapters/     credentials (keychain / file), transcripts (JSONL), quota
                  from the cache (.claude.json) and from the endpoint (HTTP),
                  Codex (JSON-RPC) and opencode (SQLite).
src/cli/          qm, and one demo per milestone.
src/render/       bars and formatting for the terminal, and the dashboard.
bin/              the launchers — qm (POSIX), qm.cmd + buscar-node.cmd
                  (Windows), qm.mjs (npm's entry, which has to work on both) —
                  and the four surfaces. They draw and nothing else.
extension/        the GNOME Shell extension that keeps the click.
paquetes/         how it reaches a machine that never clones the repo.
numeros/          one file per milestone: measured output, and an explicit
                  list of what could NOT be measured and why.
```

If a vendor name or an OS-specific path shows up outside `src/adapters/`, that
is a design bug.

## The rest of it

- **[`SOUL.md`](SOUL.md)** — the mission, the metric, and the locked non-goals.
  Short, and the only file you need before proposing a change.
- **[`BITACORA.md`](BITACORA.md)** — the engineering log, in Spanish: how each
  decision was reached, mistakes included. Three architectures for the GNOME
  panel before one held; an assumption about the macOS menu bar that turned out
  to be false; a CI gate that watched one function out of 1500 lines; an npm
  package that installed and then refused to run.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — the three unusual rules:
  everything is measured, renderers only draw, gates are proven red.
- **[`numeros/`](numeros/)** — the measurements themselves, one per milestone.

The code and its comments are in Spanish; what faces outward is in English.
That is deliberate, and `CONTRIBUTING.md` says why.

## License

MIT. The deliberate exception: the core of Legios — cartographer, healer,
pipeline — is proprietary, and what gets published is what stands on its own.
This stands on its own.

---

<div align="center">

<a href="https://github.com/legiosai"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/legios.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/legios-claro.svg">
  <img alt="Legios" src="docs/legios-claro.svg" width="150" height="49">
</picture></a>

<sub>Built by Valentín Torassa and Sol Soletti.</sub>

</div>
