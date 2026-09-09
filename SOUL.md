# SOUL.md — quartermaster

**Mission:** nobody should discover their quota is gone by hitting the wall.

**Metric:** the fraction of a machine's real Claude Code profiles that the tool
can report a live number for. Every existing tool scores 1 of N — they read the
default credential and nothing else. On the machine this was written on, that is
1 of 3, and the 1 is an empty directory.

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
- **The transcript adapter is never optional.** The polled endpoint is
  undocumented and can disappear without notice. Local transcripts are the
  floor: there is always a number, even with every token expired.
- **CLI first.** A tray icon is a rendering decision, not a product. It comes
  after the numbers are right, and only macOS can show live text in a menu bar
  anyway.

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
- **Silence is the bug.** The failure that motivated this tool was a monitor
  that polled every 120 seconds for hours, logged `credential expired — gating
  poll`, and displayed nothing at all. Any state that produces no number must
  produce a sentence instead.
- **Deduplicate by `requestId`.** Resumed and forked sessions replay the same
  assistant records into new transcript files. Counting them twice inflates
  every number downstream, and it is not visible until someone checks by hand.
