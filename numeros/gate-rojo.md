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

Lo que **no** cubre ningún gate todavía: que la respuesta real de
`/api/oauth/usage` tenga la forma que el parser espera. Eso no se puede probar
sin una corrida contra un token vigente (README, H2).
