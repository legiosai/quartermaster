# Contributing

Thanks for looking. This is a small project with opinions; reading them first
will save you time.

*(Se puede contribuir en castellano. Ver abajo.)*

## Before you write code

**Read [`SOUL.md`](SOUL.md).** It is short, and it has the locked non-goals: no
token refreshing, no cloud, no telemetry, a 60-second floor on anything that
leaves the machine, and the transcript adapter as a floor rather than a
fallback. A pull request that crosses one of those is not a small argument — it
changes what the tool is.

**Open an issue before a big change.** Not for a bug fix or a typo; for anything
that adds a surface, a dependency, or a source of numbers.

## How the repo works

Three things are unusual and they are on purpose:

1. **Everything is measured.** `numeros/` has one file per milestone with real
   output, real timings, and an explicit list of what could NOT be measured and
   why. If you claim something is faster, safer, or broken, the standard is a
   number from a machine, not an argument.

2. **Every renderer only draws.** The CLI resolves the rules —which bar wins,
   what the projection says— and emits them in `qm --json` (`mostrar`, `frena`,
   `sesion`, `semanal`). The GNOME indicator, the macOS menu bar, the Windows
   tray and the browser dashboard read fields. **A renderer that needs to
   reimplement a rule is a bug in the CLI**, not a thing to copy. This rule
   exists because `peor()` was once copied into Python, JavaScript and Swift,
   and three copies means three answers the day someone edits one.

3. **Gates are proven red.** A test that has never failed proves nothing about
   the thing it guards. `make gate-npm-rojo` breaks the package on purpose and
   checks that `make gate-npm` goes red. If you add a gate, show it failing.

Also: if a vendor name or an OS-specific path shows up outside `src/adapters/`,
that is a design bug.

## Running it

```sh
git clone https://github.com/legiosai/quartermaster && cd quartermaster
npm install
npm test            # 100+ tests, no network
npm run typecheck
make instalar       # puts `qm` in ~/.local/bin
```

You need **Node >= 22.6**: `qm` reads the TypeScript with no build step, and
type stripping starts there. `src/adapters/opencode.ts` uses `node:sqlite`,
which also starts there.

Useful gates, all runnable locally:

| command | what it proves | needs |
|---|---|---|
| `make gate-npm` | the npm tarball **installs and runs**, not just that it exists | — |
| `make gate-npm-rojo` | …and that the gate above actually goes red | — |
| `make gate-dibujo` | the GNOME surfaces compile, parse and draw pixels | Linux + GTK |
| `make gate-duraciones` | the four duration ladders agree across languages | — |
| `make gate-bandeja` | the Windows tray draws 340 px in both themes | Windows |
| `make gate-windows` | `qm.cmd` runs and the npm package **starts** on Windows | Windows |

## Language

The code, the comments and the commit messages are in **Spanish**. That is not
an accident and it is not changing: the people who write this think in Spanish,
and the comments carry most of the reasoning.

The parts that face outward are in **English**: this file, `SECURITY.md`,
`SOUL.md`, the GNOME extension description, and the README. Both are fine in an
issue or a pull request — write in whichever you think better.

## Commit messages

Look at `git log`. They are lowercase, in Spanish, and they say what changed and
**why**, not what the diff already shows:

```
la bandeja: un ícono general, un panel por cuenta, y el aviso de que te liberaste
de las 1500 líneas de la bandeja, el CI miraba una función
el defecto del shim viejo no era «Windows sin Git», era Windows
```

No prefixes, no ticket numbers, no `feat:`.

## Code style

There is no linter, and that is deliberate — but there is a shape:

- Names in Spanish, matching the domain (`cuota`, `perfil`, `ventana`, `frena`).
- Comments explain **why**, and cite the measurement when there is one.
- No runtime dependencies. Ever. `package.json` has zero, and a pull request
  that adds one needs to justify it against reading the disk ourselves.
- `tsc --noEmit` must pass with the strict settings already in `tsconfig.json`.

## What gets a fast yes

- A number: a measurement that contradicts something the repo claims.
- A new account source (another agent CLI) behind `src/adapters/`.
- A renderer for a platform we do not cover, that only draws.
- A gate for something currently unmeasured — especially the Windows tray
  against a real account, which `numeros/h10-distribucion.md` lists as open.

---

# Contribuir

En corto y en castellano.

**Leé [`SOUL.md`](SOUL.md) primero**: tiene los non-goals cerrados (no se
refresca un token, no hay nube ni telemetría, piso de 60 s para lo que sale de
la máquina, y las transcripciones son el piso y no un fallback). Un PR que cruce
uno de esos no es una discusión chica.

**Las tres reglas del repo**: todo se mide y se comitea en `numeros/`; los
renderers SÓLO dibujan —si uno necesita reimplementar una regla, el bug está en
el CLI—; y los gates se prueban en rojo.

**Los commits** son en minúscula, en castellano, y dicen por qué. Mirá el log.

**El código está en castellano y va a seguir así.** Lo que mira hacia afuera
—este archivo, `SECURITY.md`, `SOUL.md`, el README y la descripción de la
extensión— está en inglés. Escribí en el que te salga.

`npm install && npm test` no necesita red. Node >= 22.6.
