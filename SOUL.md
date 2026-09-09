# SOUL.md — quartermaster

**Mission:** nobody should discover their quota is gone by hitting the wall.

**Metric:** the fraction of a machine's real **agent accounts** that the tool can
report a live number for. Every existing tool scores 1 of N — they read the
default credential and nothing else. On the machine this was written on, that is
1 of 4, and the 1 is an empty directory.

The metric used to say "Claude Code profiles". It was widened when Codex became
a row: a person with a work seat, a personal subscription and a Codex account
asks one question, not two, and a metric that counts only one vendor's profiles
stops measuring what the tool does.

---

**Non-goals (locked):**

- **quartermaster never refreshes a token.** It reads credentials, it does not
  write them. Refreshing means racing Claude Code's own write and risking the
  invalidation of the user's refresh token — trading a monitoring convenience
  for a broken login. When a credential is expired the answer is a sentence
  telling the user which profile is stale and what command fixes it.
- **No account, no cloud, no telemetry.** Everything is read from disk and from
  the user's own credential. Nothing leaves the machine except the quota poll
  itself, to the same host Claude Code already talks to.

  And that poll has a floor. An adaptive cadence once dropped to 20 s per
  account while a bar sat high — about 360 requests an hour, sustained, against
  an undocumented endpoint that Claude Code itself calls roughly once per
  session. Polling hard enough to get rate-limited for reading your own quota
  would be a self-inflicted version of the silence this tool exists to fix.
  60 s is the floor for anything that leaves the machine; reading the disk is
  free and has none.
- **The transcript adapter is never optional.** The polled endpoint is
  undocumented and can disappear without notice. Local transcripts are the
  floor: there is always a number, even with every token expired.

  This was stated as absolute and then violated for a year of wall-clock: when
  Codex was added it had no floor at all — if its app-server failed, the row
  went blank. It has one now (`consumoCodex`, off the same rollouts). A locked
  non-goal that a new adapter is allowed to skip is not locked.
- **CLI first.** A panel indicator is a rendering decision, not a product. It
  comes after the numbers are right — and now they are, so there are three of
  them: `bin/qm-indicator` (GNOME), `bin/qm-barra` (the macOS menu bar) and
  `bin/qm-web` (the browser). All three shell out to `qm --json` and draw;
  none of them knows what a credential is.

  Three renderers turned out to be how this rule gets broken rather than how it
  gets kept: `peor()` and `paraMostrar()` — the rule that stops a 75 % warning
  bar hiding behind a calm 8 % — ended up copied into Python, JavaScript and
  Swift. A rule in three languages means a different answer per screen the day
  someone edits one. `qm --json` now emits the resolved answer (`mostrar`,
  `frena`, `sesion`, `semanal`) and the drawers read fields. **A renderer that
  needs to reimplement a rule is a signal the CLI is not emitting enough.**

  This line used to end with "and only macOS can show live text in a menu bar
  anyway." That was wrong, and it was wrong in the direction that costs users:
  GNOME shows live text through StatusNotifierItem, and the indicator was ~150
  lines. An assumption about what a platform can't do is exactly the kind of
  claim this file should not carry without having tried it.

---

**Principles:**

- **A profile is the unit, not a machine.** Claude Code has supported
  `CLAUDE_CONFIG_DIR` for a long time and people use it — a work seat and a
  personal subscription on one laptop is ordinary. A monitor that models one
  account per machine is wrong about the world, and it is wrong silently.
- **Credential location is derivable, not guessable.** On macOS the keychain
  service for a profile is `Claude Code-credentials` for the default directory,
  and `Claude Code-credentials-<sha256(abs path)[:8]>` for every other. This was
  verified against live keychain items, and it is the whole reason multi-profile
  is cheap rather than heuristic.
- **Prefer the number that needs no permission.** The quota is on disk:
  Claude Code stores the last utilization response it got in each profile's
  `.claude.json`. Reading it needs no network and no credential, so it works on
  a profile whose token expired — the exact state the motivating monitor died
  in. A path that needs a live token is a path that can go silent, so it is the
  refresher, never the only way to a number.
- **Read every bar the server sends, not the two with famous names.** On the
  account this was measured on, `five_hour` said 8 % and `seven_day` said 59 %
  while the bar actually about to stop the account was a `weekly_scoped` one at
  75 % with severity `warning` — reachable only through `limits[]`. Showing the
  well-known keys is not a simplification, it is a 67-point error that looks
  calm.
- **Silence is the bug.** The failure that motivated this tool was a monitor
  that polled every 120 seconds for hours, logged `credential expired — gating
  poll`, and displayed nothing at all. Any state that produces no number must
  produce a sentence instead.
- **Deduplicate by `requestId`.** Resumed and forked sessions replay the same
  assistant records into new transcript files. Counting them twice inflates
  every number downstream, and it is not visible until someone checks by hand.
