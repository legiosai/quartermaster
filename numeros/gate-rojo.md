# El gate, probado en rojo

La regla del repo (ver `Makefile`) es que un hito entrega tres cosas: una demo
que se corre, **un gate de CI probado en rojo**, y un número comiteado. Un gate
que nunca se vio fallar no es evidencia de nada.

Corrido el 2026-09-09 con `npm test`, sabotando el código a propósito y
restaurándolo después. 16 tests en verde antes y después.

| Sabotaje | Qué simula | Tests que cayeron |
|---|---|---|
| `if (porcentaje === null) porcentaje = 0` | el parser **inventa un número** cuando no entiende la respuesta — el pecado capital de esta herramienta | 2 |
| `const ms = v * 1000` (sin distinguir magnitud) | confundir epoch en segundos con epoch en milisegundos: la ventana «se reinicia» en 1970 | 3 |
| `const visible = texto.length` | volver a medir el relleno en bytes en vez de columnas, y desalinear la tabla en cuanto una celda lleve color | 4 |

El tercero es el bug que este commit arregla: `relleno()` contaba los bytes de
las secuencias ANSI. Se vio primero en la salida real de `make demo-h0`, no en
un test — la celda «sin cuenta» va en tenue y quedaba 8 columnas corrida.

## Segunda tanda (H5)

Con las fixtures reales en `test/fixtures/`, 23 tests. Mismos tres pasos.

| Sabotaje | Qué simula | Tests que cayeron |
|---|---|---|
| ignorar `limits[]` y leer sólo las barras con nombre | el bug de H5: informar 8 % con la cuenta al 75 % | 5 |
| `peor()` devuelve siempre la barra activa | tapar la barra más alta detrás de la que el servidor marcó activa | 1 |

**El segundo sabotaje pasó en verde la primera vez.** En las fixtures la barra
activa resulta ser también la más alta, así que la rama que las desempata nunca
se ejecutaba. Se agregaron dos tests con el caso construido a mano —activa al
20 %, otra al 90 %— y recién ahí el gate se puso en rojo. Es el motivo por el
que este ejercicio se hace: no probó el código, probó los tests.

## Lo que ningún gate cubre

Que la respuesta **en vivo** de `/api/oauth/usage` tenga la forma de las
fixtures. Las fixtures salen de `cachedUsageUtilization`, que es esa respuesta
guardada por Claude Code — muy buena evidencia, pero no una corrida propia
contra el endpoint (README, H2).
