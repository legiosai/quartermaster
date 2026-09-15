# Security

quartermaster reads credentials and calls two undocumented endpoints. Both of
those deserve a straight answer before you install it, so here it is.

*(En español, más abajo: [Seguridad](#seguridad).)*

## What it reads

| What | Where | Why |
|---|---|---|
| The cached quota | `cachedUsageUtilization` in each profile's `.claude.json` | This is the number. It needs no network and no credential, so it works on a profile whose token expired. |
| The account | `oauthAccount` in the same file | The email and plan shown on each row. |
| Credential **state** | macOS keychain (`Claude Code-credentials…`), or `<profile>/.credentials.json` | Only whether it exists, and when it expires. |
| The credential itself | same place | **Only** with `--refrescar` or `--calentar`, and only to send it to the endpoint below. |
| Local transcripts | `<profile>/projects/**/*.jsonl` | Token counts of `assistant` records. This is the floor: a number even with every token expired. |
| Codex | `~/.codex` rollouts, and its app-server | The Codex row. |
| opencode | its SQLite database | The rows for providers stored there. |
| A z.ai key | `auth.json` in opencode's data directory | **Only** with `--refrescar` or `--calentar`, and only to send it to the z.ai quota endpoint below. Nothing else in that file is read. |

## What leaves your machine

**Two requests, one per vendor, and only when you ask for them:**

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <the token Claude Code already has>

GET https://api.z.ai/api/monitor/usage/quota/limit
Authorization: Bearer <the key opencode already stored>
```

Each goes to the same host that tool already talks to, with the credential it
already stored, and asks that host about your own account. Both happen with
`--refrescar`, with `--calentar` (what the panels run), and never otherwise —
the default path reads the disk. The z.ai one is skipped entirely unless
opencode's database shows you have actually used a z.ai provider.

**There is a floor on how often.** 60 seconds, minimum, for anything that
leaves the machine. An adaptive cadence once dropped to 20 s per account, which
is ~360 requests an hour against an endpoint Claude Code itself calls about once
per session. See `SOUL.md`.

**Nothing else leaves.** No account, no cloud, no telemetry, no analytics, no
crash reporting, no update check. The browser dashboard (`qm-web`) binds to
`127.0.0.1` only.

## What it never does

- **It never refreshes a token.** Refreshing means racing Claude Code's own
  write and risking the invalidation of your refresh token — a broken login in
  exchange for a monitoring convenience. When a credential is expired, the
  answer is a sentence telling you which profile is stale and what command
  fixes it. This is a locked non-goal in `SOUL.md`.
- **It never writes to a credential file or to the keychain.** There is a test
  for this (`test/credenciales.test.ts`).
- **It never prints or logs a token.** `estadoCredencial()` returns state, never
  the secret; there is a test for that too. `qm --json --redactado` additionally
  strips emails and home paths, which is what the committed evidence in
  `numeros/` uses.
- **It has no dependencies at runtime.** `package.json` has zero `dependencies`
  — only `typescript` and `@types/node` to build. Nothing to audit but this
  repository.

## About the endpoints

`/api/oauth/usage` is **not documented**. It was found in the binary Claude Code
installs, which contains the call site:

```
fetchUtilization: GET /api/oauth/usage (attempt
```

The response *shape* is not guessed: `cachedUsageUtilization` in `.claude.json`
stores that same response, and the fixtures in `test/fixtures/` come from there.

`/api/monitor/usage/quota/limit` is not documented either. Its shape is pinned
by a fixture in `test/zai.test.ts`, copied from a real response, so a change on
the vendor's side fails a test instead of drawing a wrong bar.

Because both are undocumented, they can disappear without notice — which is why
the transcript adapter is a locked non-goal and not an optional fallback: there
is always a number, even with every token expired and both endpoints gone. For
opencode rows that floor is the token count read from its database, plus the
reset time z.ai leaves inside the `429` it already sent you.

## Reporting a vulnerability

Open a [security advisory](https://github.com/legiosai/quartermaster/security/advisories/new),
or email valentintorassacolombero@gmail.com. Please don't open a public issue
for anything that touches credential handling.

We will confirm receipt within a week. This is a small project run by two
people; there is no bounty, and no SLA beyond trying to be quick and honest.

## Scope

Only the latest release gets fixes. There are no backports.

---

# Seguridad

Lo mismo, en castellano y en corto.

**Qué lee:** la cuota que Claude Code ya dejó en el `.claude.json` de cada
perfil, la cuenta de ese mismo archivo, el **estado** de la credencial (si está
y cuándo vence), las transcripciones locales, los rollouts de Codex y la base de
opencode. Las credenciales en sí —la de Claude y la clave de z.ai que opencode
guarda en su `auth.json`—, sólo con `--refrescar` o `--calentar`.

**Qué sale de la máquina:** dos `GET`, uno por vendor y sólo cuando lo pedís —a
`api.anthropic.com/api/oauth/usage` y a `api.z.ai/api/monitor/usage/quota/limit`,
cada uno al mismo host con el que esa herramienta ya habla y con la credencial
que ya tenés—. Piso de 60 s para cualquier cosa que salga. Nada más: sin cuenta,
sin nube, sin telemetría. El tablero escucha únicamente en `127.0.0.1`.

**Qué no hace nunca:** refrescar un token (non-goal cerrado en `SOUL.md`),
escribir en el llavero o en el archivo de credenciales, imprimir un token, ni
traer una sola dependencia de runtime. Las tres primeras tienen test.

**Ninguno de los dos endpoints está documentado**: el de Anthropic salió del
binario que Claude Code instala; el de z.ai está fijado por una fixture con una
respuesta real en `test/zai.test.ts`. Por eso el adaptador de transcripciones es
el piso y no un fallback opcional.

**Para reportar algo:** un
[security advisory](https://github.com/legiosai/quartermaster/security/advisories/new)
o un mail a valentintorassacolombero@gmail.com. Un issue público no, si toca
credenciales.
