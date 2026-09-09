# H4 · Linux verificado

Fecha: 2026-09-09. Máquina: Debian 13, kernel 6.12, Node 22.22.3.
Corrido con `make demo-h0`, `make demo-h1` y `make qm ARGS=--sin-red`.

Hasta acá el adaptador de archivo estaba **escrito y sin probar** fuera de
macOS. Esta es la primera corrida real en Linux.

## Lo que se verificó

| Afirmación | Resultado |
|---|---|
| El descubrimiento encuentra los hermanos `~/.claude-*` | ✅ 4 perfiles: `.claude`, `.claude-bedrock`, `.claude-personal`, `.claude-teams` |
| La credencial vive en `<directorio>/.credentials.json` | ✅ leída en los 3 perfiles que la tienen |
| El blob está bajo la clave `claudeAiOauth` | ✅ el fallback al objeto plano no hizo falta |
| `expiresAt` es epoch en milisegundos | ✅ dio vencimientos a ~7 h, no fechas de 1970 |
| Un perfil sin credencial no rompe el recorrido | ✅ `.claude-bedrock` reporta «sin credencial» y sigue |
| Una credencial vencida se distingue de una ausente | ✅ `.claude-personal` reporta VENCIDA con el comando que la arregla |
| Las transcripciones se leen igual que en macOS | ✅ 128 archivos `.jsonl`, 9340 requests deduplicados |

`servicioLlavero()` **no** se ejercitó acá: en Linux no hay llavero. Su test
sigue siendo el vector fijo de `test/perfiles.test.ts`.

## El número

Consumo de 7 días, deduplicado por `requestId` (`numeros/h1.json`):

| Perfil | Tokens 7 d | Requests | Parte del total |
|---|---:|---:|---:|
| `.claude` (Max) | 1 189 131 488 | 4 297 | 41,8 % |
| `.claude-teams` (team_tier_1) | 1 655 814 707 | 5 043 | 58,2 % |
| `.claude-bedrock` | 0 | 0 | 0 % |
| `.claude-personal` (vencida) | 0 | 0 | 0 % |
| **Total** | **2 844 946 195** | **9 340** | |

Tiempo: **946 ms** para recorrer 128 transcripciones.

## La métrica de SOUL.md, medida en una segunda máquina

La métrica es qué fracción de los perfiles reales de una máquina puede
reportarse. Un monitor que lee sólo el directorio por defecto acá **puntúa 1 de
4**, y esta vez el fallo no es que el directorio por defecto esté vacío —acá
tiene 1,2 G de tokens y parece perfectamente sano—. El fallo es más silencioso:

> Un monitor que sólo lee `~/.claude` en esta máquina muestra un número que
> parece correcto y que deja afuera el **58,2 %** de los tokens y el **54 %**
> de los requests, todos del perfil de trabajo.

Ese es el caso peor de todos: no se ve como una falla.

## Lo que sigue sin verificarse

- **Windows.** El adaptador asume el mismo `.credentials.json`. Sigue sin probarse.
- **El endpoint de cuota.** Ver README, H2: implementado, nunca ejecutado.
