# `qm --desglose`: cuánto tarda, y si da lo mismo que el análisis a mano

Medido el 2026-10-26 en la máquina donde se escribió (Linux, Node 22.23.3), con
dos perfiles de Claude Code en uso y un Codex. Los números de abajo son
agregados; ninguna transcripción, ruta de proyecto ni id de sesión sale de la
máquina.

## Cuánto tarda

`node --experimental-strip-types src/cli/qm.ts --desglose --json`, tres
corridas seguidas con la ventana por defecto, y una con `--dias=365` para
obligarlo a leer todo:

| cuenta | archivos | bytes | 7 días (3 corridas) | todo |
|---|---|---|---|---|
| `.claude` | 89 de 349 | 0,87 de 1,87 GB | 0,79 – 0,83 s | 1,64 s |
| `.claude-teams` | 73 de 293 | 1,32 de 2,07 GB | 0,91 – 1,14 s | 1,63 s |
| `codex` | 23 de 40 | 0,34 de 0,84 GB | 0,51 – 0,55 s | 1,28 s |
| **el proceso entero** | | | **2,3 – 2,6 s** | **4,6 s** |

Para comparar, sobre la misma semana:

- `consumoDesde()` —el lector con `readline` que ya usaba `qm` para la línea de
  consumo local— tardó **3,0 s y 4,3 s** en las dos cuentas de Claude. Decodifica
  cada byte a string antes de mirarlo.
- El script de Python del análisis original tardó **2,3 s** para las dos.

La diferencia es dónde se filtra. De 171 000 líneas, 36 000 tienen `"usage"` y
suman 135 MB; el resto son 2 GB de contenido de conversaciones que no hace
falta decodificar. `adapters/lineas.ts` busca la marca sobre los bytes y sólo
convierte a string la línea que la tiene.

## Si da lo mismo que el análisis a mano

El informe es un port de tres scripts de Python escritos el mismo día. Se
corrieron los dos con el **mismo instante de corte** (`desde` del JSON), así
que la ventana es idéntica:

| | `.claude` qm | Python | `.claude-teams` qm | Python |
|---|---|---|---|---|
| requests | 7 909 | 7 916 | 7 174 | 7 199 |
| — del hilo principal | 3 905 | 3 905 | 4 344 | 4 344 |
| — de `fork` | 419 | 426 | 332 | 357 |
| lectura de cache, parte del costo | 67,6 % | 67,6 % | 71,8 % | 71,6 % |
| prompts de 400k o más | 35,0 % | 35,1 % | 47,6 % | 47,4 % |
| subagentes | 41,4 % | 41,5 % | 23,3 % | 23,5 % |
| reconstrucciones de cache | 138 · 10,6 % | 138 · 10,6 % | 120 · 10,6 % | 120 · 10,6 % |

El hilo principal y las reconstrucciones coinciden exacto. La única diferencia
son los requests de `fork`, y es a propósito: un fork arranca con una copia de
los requests de quien lo lanzó, y Python deduplicaba por archivo, así que los
contaba dos veces. `qm` deduplica por perfil —lo que `SOUL.md` pide desde el
principio— y lee los hilos principales primero, así que la copia se descarta y
el original queda en la sesión que lo hizo. Son 32 de 783 requests de `fork`.

Las partes se mueven unas décimas por eso: el total de la cuenta es un poco
más chico.

## Codex: una respuesta, un registro

El análisis a mano leía `token_count` con `last_token_usage`. Los rollouts
nuevos traen además un `token_usage_record` por `response_id`, y no dicen lo
mismo: en los 23 rollouts de la semana había **4425 respuestas distintas y 4395
`token_count`** (después de sacar 48 reemisiones con el acumulado repetido). Los
30 que faltan coinciden con las 28 compactaciones del período —un request de
compactación no emite `token_count`— y suman **8,8 M de tokens de entrada**.
`qm` usa los registros cuando el rollout los trae y cae al `token_count` cuando
no; en la ventana medida, la cuenta pasó de 2 733 a 2 755 requests.

## Lo que NO se midió

- **Con el cache de páginas frío.** Las corridas son seguidas, así que los
  archivos ya estaban en memoria; vaciar el cache pide `sudo`. En un disco
  lento la primera corrida de la semana puede tardar bastante más que esto.
- **macOS y Windows.** Las rutas salen de `path.join` y de `homedir()`, y la
  lectura es `fs.readSync`, pero no se corrió en ninguno de los dos.
- **Si los pesos describen la cuota.** No se pueden validar: ningún proveedor
  publica cómo pondera una suscripción. Son precios relativos de la API, y el
  informe lo dice en cada salida. Para Codex se usan los mismos pesos, que son
  todavía más aproximados: no es el mismo proveedor.
- **opencode y Antigravity.** No entran: guardan el consumo por mensaje o por
  conversación, sin el desglose de cache por request que este informe necesita.
