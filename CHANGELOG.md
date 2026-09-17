# Changelog

**quartermaster** tells you how much quota is left in every agent account on the
machine — every Claude Code profile, not just the default one, plus Codex and the
providers stored by opencode. The number is read from disk: no network, no
credential, no account.

Install with `brew install legiosai/tap/quartermaster` or
`npm install -g @legios/quartermaster`; the other channels are in the
[README](README.md). Every version below is a git tag and a GitHub release.

Each entry says what a user would notice. Refactors, tests and CI work are left
out unless they changed what you see.

---

## v0.1.16 — 2026-09-17

### Fixed

- **The GNOME top-bar item showed the real numbers only while the mouse was
  over it.** Half of every refresh left a stale drawing on the bar, and hovering
  was what made the true figure appear — so the quota looked like it changed on
  its own as you moved the mouse across the panel. Measured on one machine
  (GNOME Shell 48.7): the item read `15 | 15 | 37 | 0` while `estado.json` at
  that same moment said main 43, teams 21, codex 66, glm 0; seven frames into
  the hover it flipped to `43 | 21 | 66 | 0` and stayed. The old drawing was in
  no file on disk — it was the texture the shell had cached for that path. The
  item alternated its PNG between two names to dodge that cache, which does not
  dodge it: one refresh in two lands back on a path the cache already holds, and
  the shell only drops the old entry once its file monitor reports the change,
  which arrives after the extension has already painted. Each drawing now gets a
  name that is never reused, so every refresh is a path the shell has never
  seen. The panel behind the item had the same bug — the one you opened could be
  minutes old — and got the same fix.

## v0.1.15 — 2026-09-16

### Fixed

- **The macOS menu bar could stop refreshing for good, with the process alive
  and its watchdog "re-arming" every minute.** Measured on one machine: the
  watchdog logged `lo rearmo` once at 13:57 and then nothing for twenty hours,
  while the token had been live since 09:32 the next morning and the bar kept
  drawing a day-old `13%`. The cause was the watchdog itself: once tripped, it
  forced a new five-minute timer every sixty seconds, invalidating the one it
  had just armed, so the timer never fired. The forced re-arm now only replaces
  a timer whose date has already passed; a pending one is left alone.
- **The terminal said `13% reinicia en vencido` for a session window that had
  already reset.** A window whose reset time has passed carries the number of
  the *previous* window; the GNOME indicator and the Windows tray already said
  so, the terminal was the last screen still printing it as live. Now the bar
  and the figure of an expired window are dimmed, its severity flag is dropped,
  and the footer reads `reinició hace 1d9h`. In `qm --breve` the expired figure
  becomes `?` (`teams ~?/26%`): the real number after a reset is not on this
  machine, and a stale `13` looked like it was.

## v0.1.14 — 2026-09-15

### Fixed

- **The GNOME indicator could stop asking the endpoint and keep drawing as if
  nothing had happened.** Measured on one machine: seven and a half hours with no
  refresh, the process alive, the bar redrawing `~0/30%` while the server said
  `7/31%`. The cause was two timers tied at 300 s — every poll pushed the refresh
  deadline further out, just before it was due, so the refresh never fired. A
  deadline can no longer be moved further away than the one already set, and a
  watchdog that depends on neither loop notices a stale reading, logs
  `calentar.parado` once and re-arms. The macOS menu bar has the same shape and
  got the same two fixes; the Windows tray, which could not stall the same way,
  got its tick wrapped so one exception can no longer take the whole tray down.
- **Installed from npm, every `qm` run printed two Node `ExperimentalWarning`
  lines on stderr.** That is the channel `qm --calentar` uses to say why an
  account was not refreshed, so the real reason ended up buried between them in
  the indicator's log. 0.1.12 silenced them for the shell launcher, which is the
  `.deb` and the clone; npm runs a different entry point and was still affected.
  Measured: 416 bytes of stderr before, 246 after. A real deprecation warning
  still gets through.

### Added

- **On Windows, the first `qm` in a terminal now offers to put the tray icon in
  the notification area and start it at login** — the question macOS and GNOME
  already asked. Nothing was missing from the package: `qm-tray` shipped all
  along, and nobody was offering it. `qm-tray --instalar-arranque` does it by
  hand.

---

## v0.1.13 — 2026-09-14

### Fixed

- **An account nobody uses could take over every screen.** A Codex account on the
  free plan, unused for weeks and stuck at 100 %, headed the summary on all six
  surfaces, coloured the icon, fired notifications and carried the `!` in the
  statusline. Worse, it owned the blocking decisions: `qm --esperar` slept
  14 d 23 h on it, so `qm --esperar && codex exec …` would not have run the right
  half for fifteen days, and `qm --umbral=80` exited 3. An account now needs both
  evidence of no use and nothing paid waiting on the other side before it sorts
  to the bottom — an exhausted account you *do* use is exactly what this tool
  exists to point at. Nothing is hidden: the row stays, in full, and says why it
  dropped.
- **On GNOME 43 (Debian 12) the shell extension did not load at all**, so the
  meter shrank into a 16 px square and the click fell through to the GTK menu
  that closes the moment you touch it — the two things the extension exists to
  prevent. It is written against the API GNOME introduced in 45; a second copy
  with the pre-45 wrapper now ships alongside it, and installing picks between
  them by `gnome-shell --version`.
- **The Linux launcher only looked for Node in nvm**, though both READMEs promise
  nvm, fnm and volta. It only showed from GNOME's autostart, which has no
  interactive shell PATH: the indicator started, found no Node, and went on
  showing the previous session's numbers without saying so.
- **`qm-indicator` was not on anybody's PATH**, though both READMEs document
  `qm-indicator --instalar-extension` and `--instalar-arranque` as commands. npm
  registered `qm`, `qm-web` and `qm-barra` (macOS) and not it; the `.deb` linked
  only `qm`. npm now registers it too, and the `.deb` links `qm`, `qm-web` and
  `qm-indicator`.
- **The z.ai / GLM rows said the percentage did not exist on this machine. It
  did.** `GET https://api.z.ai/api/monitor/usage/quota/limit` answers with both
  windows, percentage included. Those rows now get a real bar after you ask for
  it once (`--refrescar` or `--calentar`), cached like every other number, so the
  panels show it without ever touching the key themselves. This makes z.ai the
  second host quartermaster ever talks to; both are listed in
  [`SECURITY.md`](SECURITY.md).
- **The "free in" time for an opencode provider was up to 8 hours wrong**, always
  in the direction of believing you were free early: the reset time z.ai reports
  in a `429` is Beijing time and was being read as local. It only matched on a
  machine in UTC+8, which is where it was first measured.
- **A cached endpoint reading was stamped "just now" no matter how old it was.**
  It showed least on the Claude rows, where the `.claude.json` cache usually wins
  on date; the opencode rows have no other source, so a three-day-old number
  announced itself as fresh. The age now comes from when it was measured, with
  the same "old" mark at 6 h.
- **Windows tray, from several reports:** every tick in "Icons in the tray" closed
  the panel, so choosing icons meant reopening it once per account; the reopened
  submenu came back in the top-left corner of the screen, loose from the panel;
  the panel was not centred inside its menu (8 px of air on the left, 28 on the
  right); and the gap between cards sat only below each one, so the panel started
  flush against the top edge.

### Changed

- **The Windows tray draws each account in a rounded card**, like GNOME and
  macOS, and the four options at the bottom moved behind a `⋯` row. The cost is
  one extra click for "Refresh now", which is the exception — the panel refreshes
  itself every 30 s.

---

## v0.1.12 — 2026-09-14

### Fixed

- **On Linux there was no way to get the top-bar item unless you had cloned the
  repo.** It was started with `make indicador` and `make autostart`, and whoever
  installed from apt or npm has no Makefile. The first `qm` in a terminal now
  asks the same question macOS has asked since 0.1.7, and saying yes also
  installs the GNOME extension — the part that makes a click open the panel.
  **This can need a log-out:** GNOME does not load a freshly installed extension
  on Wayland, and when that happens the closing line says so. The question only
  appears when there is somewhere to show the item (graphical session,
  `python3-gi` with `AyatanaAppIndicator3`, and a host for it); `qm --diagnostico`
  says which piece is missing.
- **The npm package did not ship the GNOME extension at all.** Installing that
  way left the item hosted by AppIndicator, where the left click falls into the
  GTK menu that does not hold its grab — seen from the user's side as "I touch
  the bar and I get no quota panel". Measured with `npm pack --dry-run`: zero
  files from `extension/`.
- **A `qm --calentar` that exited 1 left no line in the journal.** GLib does not
  raise on a non-zero exit status, so a refresh that failed passed in silence —
  which is exactly how 0.1.9's broken refresh went unnoticed on Linux while macOS
  saw it in its log. The indicator now reads the exit status, records each
  per-account reason once (no credential, expired token) and logs a
  `calentar.volvio` when it recovers, plus a start-up line saying which `qm` it
  found and with which theme.
- **Every `qm` run wrote two Node `ExperimentalWarning` lines on stderr** — the
  same channel it uses to explain things. Only that class is silenced; a real
  deprecation still comes through. (The npm entry point kept the problem until
  0.1.14.)
- **The Windows tray said "0.0 % left" where the other four surfaces said 0.3.**
  PowerShell picked the integer overload of `[math]::Max` and floored the
  balance, so a whole daily budget under 1 % disappeared.

### Changed

- **winget:** every release opened its own "New package" pull request, and six
  were queued behind the same volunteer moderator. Releases now push to the one
  that is open instead of adding another.

---

## v0.1.11 — 2026-09-14

### Fixed

- **The daily budget subtracted what you had spent from a figure that already had
  it discounted**, so every point counted twice. On screen: "you can spend
  14.3 %/day · spent 14.0 % since 09:27 · 0.3 % left", where the right answer was
  16.1 and 2.1. Spending exactly your budget declared you over it. The core now
  fixes the daily allowance at the reading the measurement starts from and ships
  the subtraction already done; all five surfaces read it instead of doing it
  themselves.

---

## v0.1.10 — 2026-09-14

### Fixed

- **0.1.9 kept asking the endpoint until it answered `429`:** 36 failed refreshes
  between 12:21 and 14:43, one every 124 seconds. The 60-second floor was per
  request, not per account, so two accounts were dragged along by a third that
  set the pace. An account read less than 5 minutes ago is not asked again unless
  a window reset in between, and a `429` now stops that account for as long as
  `Retry-After` says (between 10 minutes and 1 hour). `--refrescar` respects it
  too, and says until when.
- **The four drawing surfaces still carried the budget phrase 0.1.7 had already
  fixed in the CLI** — "today you have X % left", a number that went down on its
  own with the clock whether or not you spent anything.
- **A laptop that is off at night was treated as the exception.** The daily
  figure needed history back to midnight, which on a machine that boots at nine
  is missing every single day. It now reports what was actually measured with the
  start time next to it ("spent 13.0 % since 08:54") and says which of the two it
  is, rather than reporting nothing. A reading from three days ago no longer
  counts as the day's baseline.
- **On Windows, "today" ended at 21:00.** The tray runs `qm` inside WSL, and a
  fresh WSL starts in UTC. The machine's own IANA time zone is passed through
  now — it has to be the IANA name, because Node silently ignores the old POSIX
  form and stays in UTC.

### Changed

- **The Windows tray icon's meter is the session, not the weekly bar.** At 16 px
  the weekly one moves about two pixels a day and sits near half all week
  whatever you do. The icon has no text label next to it, so that meter is all
  you see at a glance — and what you want at a glance is whether you can keep
  going now. The weekly bar and the daily budget are still in the panel and the
  tooltip.

---

## v0.1.9 — 2026-09-14

### Fixed

- **The macOS menu bar was refreshing the wrong accounts, and then none at all.**
  It still used the rule GNOME had replaced the day before, so it ignored the
  account you were actually using if it was low, ignored one whose window had
  already reset, and polled a bar pinned at 100 % every minute. It also sent
  short account names where `--cuentas` compares full ones, so a filtered refresh
  asked no Claude account whatsoever: with 0.1.8 installed, `--cuentas=personal`
  exited 1 with "no account to ask". `--cuentas` now accepts both forms, for bars
  already installed.

---

## v0.1.8 — 2026-09-14

### Fixed

- **The macOS menu bar's log threw away the only lines worth reading.** Refresh
  exit codes went to `/dev/null`, a failed read showed only in the menu, a
  notification `osascript` never displayed left no trace, and no line had a
  timestamp. Lines are timestamped now, the file is trimmed past 1 MB, failures
  and recoveries are both recorded, and `qm --calentar` says on stderr why each
  account was not refreshed.

---

## v0.1.7 — 2026-09-14

### Fixed

- **Coming back from suspend left old numbers on screen, marked "expired".**
  Measured after 4.1 hours asleep: the drawing loop alive and the quota 5.2 hours
  stale, all three sessions marked expired with their reset 1.7 hours in the
  past. Three separate causes — a refresh already in flight killed the timer
  source for the rest of the process's life, a stuck flag had nothing to release
  it, and GLib's timers run on the monotonic clock, which does not advance while
  the machine sleeps, so four hours asleep are zero seconds to the timer. The
  indicator now listens for logind's `PrepareForSleep` and asks on resume.
- **The bar was following the account you were not using.** Refresh picked
  accounts by level, which is right for an idle account and exactly backwards for
  the one you are spending: with two sessions open, a teams account at 2 % was
  asked once in 55 minutes while everything went to a Codex account at 85 %.
  Accounts used in the last ten minutes are now asked as well, wherever they sit.
  (The field that carries "last used" was being nulled by `--breve`, which is the
  mode the bar runs — fixed in the same release.)
- **"today you have X % left" promised a subtraction it never did.** It was the
  even split of the hours remaining in the day, so with the quota untouched it
  went from 10.5 % at 01:00 to 0.5 % at 23:00 — telling you at eleven at night
  that you had 0.5 % left of a daily budget you had not spent. It now subtracts
  what actually went up since midnight, counting only upward jumps so a window
  resetting mid-day cannot produce a negative, and reports nothing (with a phrase
  saying why) when the history does not reach the start of the day.

### Added

- **The first `qm` in a terminal on macOS asks, once, whether to put the meter in
  the menu bar and start it at login.** No install path could do it on its own:
  brew runs the install in a sandbox that cannot write to `~/Library`, and the
  npm postinstall stopped registering anything in 0.1.6. It never asks under
  `--json`, `--breve`, `--watch` or `--umbral`, without a terminal, or in CI.
  Without the question, `brew services start quartermaster`.

---

## v0.1.6 — 2026-09-13

### Fixed

- **The GNOME panel closed the instant you touched it, and nothing said why.**
  The shell extension was failing to load with a type error, and without the
  extension the panel falls back to the GTK menu — the one that cannot hold its
  grab and closes as soon as you touch it. A load error at start-up looked, from
  the user's side, exactly like a panel that closes on its own.
- **The account that was blocked was the only one never asked.** Refresh skipped
  anything at 100 %, a rule that is correct about *how often* to ask and had
  leaked into *who* to ask — so the one account waiting to be freed was excluded
  from every refresh, and "you're free again" is the most useful thing this
  program says. Measured: the cache said 96 % and 100 %, both critical, with the
  reset two hours past; a single refresh returned 2 % and 0 %, both normal. Nine
  hours telling someone they were blocked while they were free.
- **A reading from a window that has already closed is now marked expired**
  rather than shown as an old measurement of the same thing. A closed window's
  `critical` no longer paints the tray red for something that is over. No
  invented 0 %: after a reset the real number is unknown until it is read.
- **On Windows, the npm package installed and then refused to run.** npm builds
  its `.cmd` shim from the shebang, and `#!/bin/sh` produced one that invokes
  `/bin/sh`, a POSIX absolute path: exit 1 with "The system cannot find the path
  specified". It was first measured on a Windows 10 VM with no Git, but the
  condition is not a missing `sh` — GitHub's `windows-latest` runner, which has
  `sh.exe` on PATH, failed the same way. `npm run construir` had also never
  worked on Windows, which matters because the npm tarball, the installer and CI
  all hang off that build.
- **`qm --version` answered "unknown option" with exit code 2**, which is the
  first thing anyone types. Help and version exit 0; only an option that does not
  exist exits 2.
- **On Windows, a missing credential is no longer hedged.** The message used to
  say Windows was unverified and might be using DPAPI, which sent people off to
  log in again for no reason. Reading Claude Code's own binary settled it: the
  credential store has no per-platform branch, and DPAPI, CredRead, wincred and
  `safeStorage` appear zero times in 206 MB. The most common Windows case —
  someone who simply has not logged in — now gets the right diagnostic.

### Added

- **`qm --diagnostico`**: one command whose output you can paste straight into a
  public issue — home paths become `~`, and no e-mail, token or account id is
  ever printed. It runs the five commands nobody should have to know and **states
  the conclusion** instead of leaving you the data, including the case that
  looked like "the fix didn't work": GNOME is still running the old extension
  module and the only step left is to log out. Anything it cannot find out, it
  says so; it works with none of those commands installed.
- **The GNOME indicator writes what it does to stderr**, which systemd's journal
  picks up (`journalctl --user -b | grep qm-indicator`). `vivio_ms` is the one
  that answers "the panel closes on its own": a panel that lived 40 ms was not
  closed by you. `QM_SILENCIO=1` turns it off.
- **`qm --json` declares its contract:** `esquema: 1` and the package version.
  That JSON is read by four surfaces, the statusline, the waybar module and
  anyone writing their own, and without a number the only way a consumer learns
  something changed is that their screen breaks.
  [`docs/esquema-json.md`](docs/esquema-json.md) documents it field by field.
- **Windows without WSL:** `qm.cmd`, a per-user installer with no UAC (`qm` on
  your PATH, the tray in the Start menu), and generated manifests for winget,
  scoop and the AUR, plus a Nix flake and a waybar module.
- [`SECURITY.md`](SECURITY.md), with the table of what is read and what leaves
  the machine, and the undocumented endpoint stated plainly rather than waiting
  to be asked.
- The GNOME Shell extension was submitted to extensions.gnome.org.

### Changed

- **The npm postinstall no longer installs a macOS LaunchAgent.** A package that
  reads OAuth credentials should not register login agents nobody asked for, and
  the path was not reliable anyway — `npm ci --ignore-scripts` is normal.
  **Upgrading does not remove an agent 0.1.5 wrote:** delete
  `~/Library/LaunchAgents/com.legios.quartermaster.barra.plist` if you do not
  want it. The explicit replacement is `qm-barra --instalar-arranque`, and from
  0.1.7 the first run asks.
- **The README is now English and short.** The 1711-line version — the
  engineering log, with the three panel architectures and the assumption about
  the macOS menu bar that turned out to be false — moved to
  [`BITACORA.md`](BITACORA.md) untouched. [`LEEME.md`](LEEME.md) is the Spanish
  README. The landing page is now in English too, with the Spanish one under
  `/es/`.
- **One tag publishes everywhere.** The release workflow builds every artifact
  and pushes to each channel that has its secret configured, skipping the others
  by name and saying so, so a catalogue can no longer sit on an old version
  because somebody forgot a step.

---

## v0.1.5 — 2026-09-11

There is no `v0.1.4` tag. 0.1.4 reached npm from a tree that was missing six
commits — it went out without the daily budget or the new tray. 0.1.5 is the
version that carries them.

### Fixed

- **`npm install -g @legios/quartermaster` installed and then failed on every
  run.** Node refuses to type-strip files under `node_modules`, which is exactly
  where a global install puts the package, so `qm` died with an internal Node
  error each time it was invoked. The tarball now carries a compiled `dist/`; a
  clone, `make instalar`, the `.deb` and brew still have no build step.
- **The GNOME panel closed as soon as you touched it to scroll.** In a GTK menu,
  releasing the button over an item activates it, and activating closes the menu.
  Underneath that was a harder wall: a GTK menu on XWayland cannot hold its grab
  against real desktop activity — measured lifetimes of 70 ms to 4 s with
  somebody using the machine. The panel moved inside the GNOME extension, where
  it is a compositor actor and scrolls and closes like any other shell menu. The
  GTK menu stays as the fallback for people without the extension.
- **The apt instructions on the documentation page pointed at a file that does
  not exist**, and had since the page was published. Copying the block left an
  empty keyring and `apt update` failed with `NO_PUBKEY`, which says nothing
  about the download being the problem. The repository itself was fine.

### Added

- **"How much can I spend today", which is not "when do I crash".** A line that
  divides what is left of the long window by the days until it resets:
  `you can spend X %/day · Y % left today`. It deliberately does not split a
  5-hour window, which resets four times a day, and says why instead of printing
  a number when it is less than an hour from the reset. In `qm`, the dashboard,
  the GNOME panel, the Windows tray and the macOS menu bar.
- **`qm` runs natively on Windows**, measured with Windows' own Node rather than
  WSL's: it finds `C:\Users\<user>\.claude` and `.codex` with their backslash
  paths and reads Codex's quota from disk, no network and no credential.
  `--breve` works too, so the statusline does.
- **Windows tray, largely rebuilt:** one general icon plus one per account, each
  opening its own panel; dark mode; the "you're free again" notification;
  notifications for every bar rather than only the one that stops you first; a
  warning when Windows hides your icons, because a hidden icon and one that never
  started look identical; a per-account tick list to choose which icons appear,
  editable from the panel itself; and a guard so an interface exception reports
  itself instead of killing the tray.
- **A documentation page**, with every flag, the `qm --json` contract field by
  field, and when the rate line is deliberately not drawn. The site moved from
  `legiosai.github.io/quartermaster` to `quartermaster.legios.com.ar`; the old
  URLs redirect.

---

## v0.1.3 — 2026-09-10

### Fixed

- **Codex showed a `plus` plan on a machine with no subscription.** It looked for
  the newest session file *that had bars*, and found one from May — reporting a
  plan that had been cancelled and a percentage 127 days old as if it were
  current, with bars drawn for an account that pays per use. The authoritative
  signal (`auth_mode`) is now read first, and an API-key account says so instead.
- **The opencode rows appeared on no screen at all.** They were skipped under
  `--breve`, and every surface asks for `--breve`: the macOS bar, the Windows
  tray, the GNOME panel and the statusline. The row only existed if you ran `qm`
  by hand in a terminal. A z.ai key used the day before — 56 325 tokens in seven
  days — was invisible, which is the bug this project exists to fix, with a
  different vendor. The cost that justified the exclusion was one slow query;
  fixed, all of opencode takes about 25 ms.
- **The GNOME panel said "cache from 3067h28m ago" where Windows said
  "127d19h".** The Python duration ladder had no days branch. All four
  implementations were then aligned on the CLI's convention, with a gate that
  runs the four against one frozen table — three of them had agreed with each
  other, so every comparison between screens had looked reassuringly fine.
- **Long account names drew outside their card and off the panel.** Anything
  carrying user data is truncated now, and the name gives way before the number.
- **Two instances left two items in the bar**, opened two panels on one click and
  overwrote each other's PNG — trivially provoked by autostart plus a manual
  start.
- **If GNOME crashed without shutting the extension down cleanly, the indicator
  hid its own item forever** — no icon anywhere, which is the worst possible
  ending. The extension now refreshes a heartbeat and the indicator only believes
  it if it is recent; measured, the icon comes back on its own in 45 seconds.
- **Switching the desktop to a light theme left the number in the bar white on a
  light background** until you restarted the indicator.

### Added

- **A signed apt repository**, so on Debian and Ubuntu `apt upgrade` brings new
  versions by itself and apt verifies the signature before installing.
- **The GNOME indicator updates itself.** `apt upgrade` replaces the files and
  leaves, but the running process keeps the old code in memory — and nobody
  restarts the indicator, because the indicator is precisely the thing you leave
  running and forget. It now watches its own source and relaunches, compiling the
  new version *before* jumping and keeping the working one if it is broken.
- **The Windows tray draws the full panel** — header ring with what stops you
  first, and the rate curve next to the bar that stops you — with one tray icon
  per account.
- The landing page, the logo, and screenshots taken from a redacted fixture, so
  there is no e-mail or home path in a public image.

---

## v0.1.2 — 2026-09-10

### Fixed

- **The GNOME panel stopped opening on any screen it did not fit in** — which is
  any 768 px laptop with three accounts. A GTK menu scrolls item by item, and the
  whole panel was a single item: with nothing to scroll, the menu simply does not
  open. The panel had been right at the edge of the usable height and further
  work pushed it to 946 px. It is one item per card now.
- **After the first click, the menu never opened again.** Removing a widget from
  a GTK container destroys it, so keeping the separator and the "Refresh" entry
  to reuse them left two dead objects behind. Verified with six clicks: the first
  opened, and then nothing.

### Added

- Three ways to install without cloning the repository: Homebrew
  (`legiosai/homebrew-tap`), npm, and a `.deb` attached to the release. None of
  them compiles anything — all you need is a Node 22.6 or newer.

---

## v0.1.1 — 2026-09-10

### Fixed

- **On a machine with no accounts yet, `qm --json` printed a Spanish sentence
  instead of JSON**, so any statusline or script parsing it broke on the very
  first run — which is the first thing anyone who installs this sees. `--json` is
  a contract: it returns the envelope with `perfiles: []`. It also no longer
  exits 1, because having no accounts is an answer, not a failure.

---

## v0.1.0 — 2026-09-10

First public release. The starting point was a monitor that polled every
120 seconds for hours, logged `credential expired — gating poll`, and displayed
nothing at all, because it read one credential — the default directory's — on a
machine where the two real accounts lived somewhere else.

### Added

- **Every account, not one.** Every Claude Code profile (`CLAUDE_CONFIG_DIR` and
  all), plus Codex and the providers stored by opencode — GLM, MiniMax, Kimi and
  Grok, read from its session database.
- **The number needs no network and no credential.** Claude Code stores the last
  quota response it received in each profile's `.claude.json`, so quartermaster
  reads it from disk — which means it still works on a profile whose token
  expired, the exact state the motivating monitor died in. The endpoint is a
  refresh (`--refrescar`), never the only path to a number.
- **Every bar the server sends, not the two with famous names.** On the account
  this was measured against, `five_hour` said 8 % and `seven_day` said 59 % while
  the bar actually about to stop the account was a `weekly_scoped` one at 75 %
  with severity `warning`, reachable only through `limits[]`. Reading the
  well-known keys is not a simplification, it is a 67-point error that looks
  calm.
- **A projection, and notifications.** The quota is a snapshot, so the readings
  are kept and a rate is fitted to them: points per hour, when you hit 100 %, and
  whether that lands before the window resets — with explicit guards and a stated
  reason when it refuses to draw a line. Notifications at 80 % and 95 %, when the
  projection starts saying you will crash, and when a window resets after you had
  been against the ceiling, which is the only one that lets you do something
  different right now.
- **Five places to see it:** `qm` in the terminal (`qm --breve` for a statusline,
  ~85 ms because it skips transcripts), the GNOME top bar with its own Shell
  extension, the macOS menu bar, the Windows notification area, and a local
  dashboard on `127.0.0.1`.
- **`--umbral=N`** (exit 3 over the threshold), **`--esperar`** to block until
  the quota drops so you can chain a command behind it, `--watch`, `--redactado`,
  and `--solo=` / `--ocultar=` plus a config file to choose which accounts show.
- **The rules live in one place.** `qm --json` emits the resolved answer —
  `mostrar`, `frena`, `sesion`, `semanal` — and the renderers read fields. The
  rule that stops a 75 % warning bar hiding behind a calm 8 % had ended up copied
  into Python, JavaScript and Swift, which means three answers the day somebody
  edits one.
- **A 60-second floor on anything that leaves the machine.** An adaptive cadence
  had dropped to 20 s per account, roughly 360 requests an hour against an
  undocumented endpoint, for reading your own quota. Reading the disk stays free
  and has no floor.
