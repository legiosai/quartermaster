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
| **H1** consumo local real | ✅ mecanismo | `make demo-h1` — falta `numeros/h1.json` de una corrida limpia |
| **H2** poll de cuota en vivo | ⏳ no empezado | el endpoint es **no documentado**; hay que verificar forma de respuesta con un token vigente |
| **H3** `--watch` y `--json` | ⏳ no empezado | |
| **H4** Linux y Windows verificados | ⏳ no empezado | el adaptador de archivo está escrito, **sin probar** fuera de macOS |

**Advertencias, para que el README no mienta:**

- **El endpoint de cuota todavía no se llamó ni una vez.** H2 está sin empezar.
  Hoy todos los números salen de transcripciones locales, que dicen *cuánto
  consumiste* pero no *cuál es tu límite* ni *cuándo se reinicia la ventana*.
- **Windows no está verificado.** El adaptador asume
  `<directorio>/.credentials.json` igual que Linux. Es posible que Claude Code
  use DPAPI o el Credential Manager. Hay que probarlo en una máquina Windows
  antes de afirmar nada.
- **macOS va a abrir un prompt del llavero por perfil** la primera vez. Es
  esperado y no hay forma de evitarlo sin firmar la app.

## Uso

```bash
npm install
make demo-h0      # ¿qué perfiles hay y cuáles autentican?
make demo-h1      # cuánto se consumió en los últimos 7 días, por perfil
```

Requiere Node ≥ 22 (usa type stripping nativo, no hay paso de build).

## Diseño

```
src/core/         perfiles, tipos. No sabe de llaveros ni de HTTP.
src/adapters/     credenciales (llavero / archivo) y transcripciones (JSONL).
src/render/       barras y formato. Sin dependencias.
src/cli/          las demos y el comando.
```

La regla es la de siempre: si un nombre de vendor o una ruta de sistema
operativo aparece fuera de `src/adapters/`, es un bug de diseño.

## Licencia

MIT.
