# quartermaster

Cuánta cuota te queda, en todos tus perfiles de Claude Code.

> **Misión.** Que nadie se entere de que se quedó sin cuota chocándose contra el
> límite.

Ver [`SOUL.md`](SOUL.md) para la métrica, los non-goals y la apuesta falsable.

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

## El hallazgo

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
| **H2** poll de cuota en vivo | ⚠️ escrito, **nunca ejecutado** | endpoint y forma localizados (abajo); falta una corrida contra un token vigente |
| **H3** `--watch` y `--json` | ✅ mecanismo | `make qm`, `qm --json`, `qm --watch` |
| **H4** Linux y Windows verificados | 🟨 Linux ✅, Windows ⏳ | [`numeros/h4-linux.md`](numeros/h4-linux.md) — primera corrida real fuera de macOS |

**Advertencias, para que el README no mienta:**

- **El endpoint de cuota todavía no se llamó ni una vez.** El código de H2 está
  escrito y tiene tests, pero esos tests corren contra respuestas *construidas a
  partir de la documentación embebida en el binario de Claude Code*, no contra
  una respuesta real. Hasta que alguien corra `make qm` con un token vigente y
  comitee lo que volvió, H2 no está hecho. Todo número que hoy muestra la
  herramienta sale de transcripciones locales, que dicen *cuánto consumiste*
  pero no *cuál es tu límite* ni *cuándo se reinicia la ventana*.
- **Windows no está verificado.** El adaptador asume
  `<directorio>/.credentials.json` igual que Linux. Es posible que Claude Code
  use DPAPI o el Credential Manager. Hay que probarlo en una máquina Windows
  antes de afirmar nada.
- **macOS va a abrir un prompt del llavero por perfil** la primera vez. Es
  esperado y no hay forma de evitarlo sin firmar la app.

## La misma falla en Linux, y peor

`numeros/h4-linux.md` es la primera corrida fuera de macOS. Encontró 4 perfiles,
y con ellos una versión del problema más difícil de notar que la original: acá
el directorio por defecto **no** está vacío. Tiene 1,2 G de tokens y se ve
perfectamente sano.

> Un monitor que sólo lee `~/.claude` en esa máquina muestra un número
> creíble que deja afuera el **58,2 %** de los tokens y el **54 %** de los
> requests, todos del perfil de trabajo.

Un directorio vacío se nota. Un número que parece bien y está a la mitad, no.

## De dónde sale el endpoint de cuota

No está documentado. Se leyó del binario que Claude Code instala
(`node_modules/@anthropic-ai/claude-code/bin/claude.exe`), que contiene tanto el
call site:

```
fetchUtilization: GET /api/oauth/usage (attempt
fetchUtilization: 200 after
```

como, en su documentación de *statusline* embebida, la forma de los datos que
Claude Code publica a partir de esa respuesta:

```
"rate_limits": {   // Only present for subscribers after first API response.
  "five_hour": {   // Optional: 5-hour session limit (may be absent)
    "used_percentage": number,   // Percentage of limit used (0-100)
    "resets_at": number          // Unix epoch seconds when this window resets
  },
  "seven_day": { ... }           // Optional: 7-day weekly limit
}
```

Cerca del call site aparecen además `utilization`, `percent`, `is_enabled` y
`weekly_scoped`. Eso alcanza para escribir el parser, **no** para afirmar la
forma exacta de `/api/oauth/usage`: la documentación describe lo que Claude Code
*republica*, que puede no ser lo que *recibe*. Por eso el parser acepta varios
nombres para lo mismo y, si no reconoce ninguno, devuelve `ilegible` con las
claves que sí vinieron — nunca inventa un número. La primera corrida real
resuelve la ambigüedad y sobra la mitad de ese código.

Corolario operativo: **el endpoint puede desaparecer sin aviso**, y por eso las
transcripciones locales no son un fallback opcional (ver `SOUL.md`).

## Uso

```bash
npm install
make qm                    # cuota (si hay) + consumo local, todos los perfiles
make qm ARGS=--json        # lo mismo, para scripts y statuslines
make qm ARGS="--watch 60"  # se redibuja cada 60 s
make qm ARGS=--sin-red     # sin tocar la red: sólo transcripciones

make demo-h0               # ¿qué perfiles hay y cuáles autentican?
make demo-h1               # consumo de los últimos 7 días, por perfil
```

Requiere **Node ≥ 22.6** (lee TypeScript directamente, no hay paso de build).
Con una versión menor todo comando moría con un `bad option:
--experimental-strip-types` que no le dice nada a nadie; ahora
`scripts/nodo.cjs` lo intercepta y dice qué hacer.

## Diseño

```
src/core/         perfiles, tipos. No sabe de llaveros ni de HTTP.
src/adapters/     credenciales (llavero / archivo), transcripciones (JSONL), cuota (HTTP).
src/render/       barras y formato. Sin dependencias.
src/cli/          qm (el comando) y las demos de cada hito.
```

La regla es la de siempre: si un nombre de vendor o una ruta de sistema
operativo aparece fuera de `src/adapters/`, es un bug de diseño.

## Licencia

MIT.
