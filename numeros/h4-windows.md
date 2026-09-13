# H4 · Windows, medido

Lo que estaba comiteado hasta acá era `numeros/h4-linux.md`. Windows llevaba
meses en 🟨 con una nota honesta —«no está verificado»— y sin un solo número que
dijera qué pasa cuando `qm` corre ahí. Esto es ese número.

**Máquina:** Windows 11 Home Single Language, build 26200 ·
Windows PowerShell 5.1.26100.9444 · Node v24.15.0 nativo (no el de WSL).

**Salida cruda comiteada:** [`h4-windows.json`](h4-windows.json), con
`--redactado` (sin mails ni rutas de casa).

---

## Lo que sí anda

`qm` **corre en Node nativo de Windows y contesta**. No es un port: es el mismo
`src/cli/qm.ts` ejecutado con `node.exe` en vez de con el Node de WSL.

```
> node src/cli/qm.ts
qm · win32 · consumo de 7d

  .claude            sin cuenta
                     credencial: ilegible · Windows sin verificar: ...
                     cuota: Claude Code todavía no dejó cuota en .claude.json ...
  codex              ***@gmail.com       · plus
                     credencial: la pone codex · 0 reset(s) sin usar
                     cache · hace 84d22h — viejo
                   ▸ session       ░░░░░░░░░░░░░░░   2% reinicio vencido
                     weekly_all    ░░░░░░░░░░░░░░░   0% reinicio vencido

  lo primero que te frena: codex · session 2%
```

Concretamente, lo verificado:

- **`plataforma: win32`** — no está corriendo por WSL disfrazado.
- **El descubrimiento de perfiles anda en rutas de Windows.** Encontró
  `C:\Users\<user>\.claude` y `C:\Users\<user>\.codex` y los reportó con sus
  rutas nativas, con backslash.
- **La cuota de Codex se leyó del disco, sin red y sin credencial**, que es el
  camino que SOUL.md llama «el número que no necesita permiso». Salió `ok`, con
  su edad (84 d — el cache de esta máquina es viejo porque Codex se usa desde
  WSL) y sus dos ventanas.
- **`--breve` funciona** (`codex ~2%`), o sea que la statusline de Claude Code
  anda igual en Windows nativo.
- **Salida y código de salida correctos**: exit 0, JSON parseable.

## Lo que sigue sin poder afirmarse, y por qué

**La pregunta de DPAPI sigue abierta, y no por falta de ganas: en esta máquina
Claude Code nunca corrió nativo en Windows.** Se comprobó, no se supuso:

- no hay `claude` en el PATH de Windows;
- no hay `%USERPROFILE%\.claude.json`;
- `%USERPROFILE%\.claude\` existe pero sólo tiene `settings.local.json` y
  `worktrees\` — ningún `.credentials.json`;
- `cmdkey /list` devuelve 7 credenciales y **ninguna** menciona Claude ni
  Anthropic.

O sea: no hay un login nativo que inspeccionar. `src/adapters/credenciales.ts`
sigue diciendo lo correcto —«Windows sin verificar: no hay `.credentials.json` y
puede que use DPAPI»— y sigue sin poder confirmarse ni desmentirse acá. Cerrar
esa mitad necesita una máquina con Claude Code instalado y logueado del lado de
Windows; no es trabajo de código.

Lo que este número sí hace es partir H4 en dos y cerrar la mitad que se podía
cerrar: **el CLI anda nativo y lee cuota sin credencial.** Lo que falta está
acotado a una pregunta, con la evidencia de por qué no se pudo contestar.

## Cerrada: la credencial de Windows NO usa DPAPI

*(2026-09-13. Esta sección contesta la pregunta que la de arriba dejó abierta.)*

Arriba dice que cerrar esa mitad «necesita una máquina con Claude Code
instalado y logueado del lado de Windows; no es trabajo de código». Eso era
verdad para *observar* el comportamiento. Pero hay otra forma de contestarla, y
es la misma con la que salió el endpoint en H2: **mirar el binario**.

`@anthropic-ai/claude-code` deja en `node_modules` el ejecutable de la
plataforma. En esta máquina son **206 MB sin strippear**, y el bundle contiene
código de las tres plataformas — la llamada de macOS al llavero está ahí:

```js
c("security", ["find-generic-password", "-a", _Q(), "-w", "-s", e], …)
```

Con eso, tres hallazgos.

**1. El almacén de credenciales no tiene ramas por plataforma.**

```js
function f(){ let e = Hy(); return { storeDir: e, storePath: D(e, ".credentials.json") } }
```

`f()` devuelve siempre `<directorio>/.credentials.json`, y `probeCredentials()`
hace `lstat` de ese mismo archivo (y rechaza symlinks: abre con `O_NOFOLLOW` y
devuelve `ELOOP` si lo es).

**2. Ese camino CORRE en Windows, y lo prueba su manejo de errores.**

```js
function I(e, r){
  if (e === "ENOENT" || e === "EISDIR" || e === "ENOTDIR") return "absent";
  if ((e === "EACCES" || e === "EPERM") && r !== "win32") return "absent";
  return "read-failed"
}
```

Es el clasificador de errores **de leer ese archivo**, y tiene un caso `win32`
explícito: en Windows un `EACCES` no se interpreta como «no está». Nadie
escribe manejo de errores específico de una plataforma para un código que en
esa plataforma no se ejecuta.

**3. Las APIs de credenciales de Windows no aparecen.** Contadas sobre los
206 MB:

| | ocurrencias |
|---|---|
| `DPAPI` | **0** |
| `CredRead` / `CredWrite` | **0** |
| `wincred` | **0** |
| `CryptProtectData` | **0** |
| `safeStorage` | **0** |
| `Credential Manager` | 1 — y es una línea de changelog sobre **git** |

**Conclusión: en Windows la credencial va al mismo `.credentials.json` que en
Linux.** No hay DPAPI ni Credential Manager.

### Qué cambia en el código, y qué lo desmentiría

`src/adapters/credenciales.ts` tenía un caso especial que, en Windows y sin
archivo, devolvía «Windows sin verificar: puede que use DPAPI». Esa cautela era
correcta mientras no se supiera. Ahora es al revés: sostenerla sería inventar
una duda que ya no existe, y dejar al usuario más común —el que simplemente no
inició sesión— sin el diagnóstico correcto. Windows pasa a tratarse como los
demás.

**Lo que falsifica esto**, y es fácil de comprobar: una máquina con Claude Code
nativo logueado en Windows donde **no** exista
`%USERPROFILE%\.claude\.credentials.json`. Si aparece una así, este hallazgo
está mal y el caso especial vuelve.

Dos límites que conviene decir, porque el método no es observación directa:

- el binario leído es el de **linux-x64**. Los paquetes por plataforma podrían
  diferir — aunque el hallazgo 2 es justamente evidencia de que no en esto;
- esto describe **la versión instalada hoy** en esta máquina. Es código de otro,
  y puede cambiar sin aviso. Por eso `qm` sigue leyendo el estado de la
  credencial en vez de asumirlo, y por eso las transcripciones siguen siendo el
  piso.

## Dos cosas menores que aparecieron midiendo

- **`powershell.exe ... > archivo` escribe UTF-16.** Redirigir la salida de `qm`
  con el `>` de PowerShell 5.1 produce un archivo que `json.load` rechaza en
  `position 0: invalid start byte`. No es un bug de `qm` —la bandeja ya fuerza
  `StandardOutputEncoding = UTF8` al levantar el proceso— pero es la primera
  piedra con la que se tropieza cualquiera que quiera guardar el JSON a mano.
  Con `Out-File -Encoding utf8` o leyendo en `utf-16` se resuelve.
- **La consola de Windows no muestra los `·` sin ayuda.** Salen como `┬À` salvo
  que se ponga `[Console]::OutputEncoding = [Text.Encoding]::UTF8` primero. Es
  la misma familia de problema que el BOM de `bin/qm-tray.ps1`.

## Cómo repetirlo

```powershell
cd <el repo>
[Console]::OutputEncoding = [Text.Encoding]::UTF8
node src/cli/qm.ts                    # necesita Node >= 22.6
node src/cli/qm.ts --json --redactado # lo que está comiteado acá
```

`bin/qm` es un `/bin/sh` y no sirve del lado de Windows: hay que invocar
`src/cli/qm.ts` con `node.exe` directamente. Es la otra cosa que falta para que
Windows nativo sea una plataforma de primera y no un experimento: un `qm.cmd`
que haga lo que hace `bin/qm` —buscar un Node que sirva y pasarle el TypeScript.
