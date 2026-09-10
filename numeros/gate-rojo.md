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

## Tercera tanda (H7, proyección y avisos)

41 tests.

| Sabotaje | Qué simula | Tests que cayeron |
|---|---|---|
| el historial no deduplica por `medidoEn` | qm corre cada minuto sobre un cache que cambia cada hora: la serie se llena de puntos idénticos y el ritmo sale **plano justo cuando más subís** | 1 |
| `SUBIDA_MINIMA_PUNTOS = 0` | proyectar sobre un movimiento del tamaño del redondeo, o sea inventar un techo a partir de ruido | 1 |

Un tercer defecto no lo encontró ningún test sino la prueba a mano contra un
perfil de juguete: la clave de «ya avisé» incluía `resets_at` **crudo**, y el
servidor manda microsegundos que cambian entre lecturas (se vieron `.117894` y
`.118092` en una misma respuesta). Cada jitter estrenaba clave y volvía a
notificar lo mismo. Ahora la clave va redondeada al minuto, que es estable
entre lecturas y cambia igual cuando la ventana se reinicia de verdad.

## Lo que ningún gate cubre

Que la respuesta **en vivo** de `/api/oauth/usage` tenga la forma de las
fixtures. Las fixtures salen de `cachedUsageUtilization`, que es esa respuesta
guardada por Claude Code — muy buena evidencia, pero no una corrida propia
contra el endpoint (README, H2).

## Tercera tanda: el gate de dibujo (GNOME)

`npm test` cubre el núcleo en TypeScript. Fuera de eso quedaban **1.400 líneas
de Python** que dibujan el panel y el item de GNOME, y una extensión de GNOME
Shell en JavaScript, y no las revisaba nadie. No es hipotético: el 2026-09-10,
sacando código muerto de `bin/qm-indicator`, un `index()` demasiado ancho se
llevó puesto el bloque entero del panel —unas 700 líneas— y el archivo siguió
compilando, así que `npm test` siguió en verde. Se descubrió a mano.

`scripts/gate-dibujo.sh` mira tres cosas, en orden de qué tan barato es
equivocarse: que el indicador compile, que la extensión parsee, y que **dibuje**
—con `test/fixtures/panel.json` de entrada, el panel y el item tienen que salir
con las medidas de siempre y con píxeles adentro—. Lo tercero es lo que no se
puede reemplazar por un import: un error de Cairo no rompe la importación.

### El gate se estrenó mintiendo

La primera versión pasaba en verde en esta máquina y fallaba en CI. La causa
vale más que el gate: `--desde` devolvía una frase cuando no podía leer el
archivo, en vez de levantar. Acá el archivo se leía, así que no se notaba; pero
además —y esto es lo que hizo el diagnóstico difícil— el propio `--desde` se
había perdido en un `git checkout` de las pruebas de sabotaje, y sin él el
programa caía de vuelta en los datos reales de la máquina. O sea: el gate estaba
midiendo la cuota de esta computadora y llamándola fixture. En CI no hay cuota,
la frase de error se dibujó como un panel de 54 px, y recién ahí se vio.

Dos correcciones: `--desde` levanta si no puede leer, y las pruebas de sabotaje
restauran desde una copia y no con `git checkout`, que se lleva puesto el
trabajo sin comitear. Y una verificación que ahora es parte del método: se
dibujó el fixture entero (5 perfiles, 1039 px) y una copia recortada a 2
perfiles (433 px). Si el alto no cambia, el archivo no se está leyendo.

### Los sabotajes

Corridos el 2026-09-10, restaurando desde copia después de cada uno. Verde antes
y después de todos.

| Sabotaje | Qué simula | Qué dijo el gate |
|---|---|---|
| `if True` sin dos puntos en `bin/qm-indicator` | exactamente el accidente de arriba | `no compila` |
| `function rota( {` en `extension.js` | un error en la extensión, que GNOME sólo mostraría al iniciar sesión | `no parsea` |
| `ancho_total = 20` en el item | perder la proporción ancha: GNOME deja de dibujarlo a lo ancho y lo encaja en un cuadrado de 16 px, con los medidores ilegibles | `el item quedó de 20x22` |
| `ANCHO_PANEL = 300` | una medida cambiada sin querer | `el panel salió de 300 px de ancho` |
| `cabecera, vistas = None, []` | el caso peor: medidas perfectas y nada dibujado | `el panel salió de 24 px de alto` |

| `ALTO_BARRA = 205` | una tarjeta sola más alta que la pantalla | `la tarjeta VistaCuenta mide 733 px y no entra` |

Los seis salieron con código 1.

El último apareció después, y por las malas. El panel de GNOME es un `Gtk.Menu`,
y un menú rueda **item por item**: con un solo item más alto que la pantalla no
hay nada que rodar y el menú directamente no abre — sin un error, sin un log,
sin nada. El panel venía midiendo 740 px contra 728 de área útil, o sea entraba
raspando; las mejoras del día lo llevaron a 946 y dejó de abrir. Partirlo en una
tarjeta por cuenta lo arregla, pero sólo mientras ninguna tarjeta sola se pase, y
eso es lo que ahora mira `scripts/gate-tarjetas.py`.

El chequeo de píxeles no es decorativo: un PNG del tamaño correcto y enteramente
transparente pasa cualquier verificación de medidas y no dibujó nada. Por eso se
cuentan los píxeles con alfa distinto de cero, y para el panel se exige que sean
más de la mitad.

## Cuarta tanda: los flujos, con datos adversos

El gate cubría que dibujara. No cubría *qué* dibuja cuando los datos son feos.
Se armaron diez entradas adversas —cero cuentas, una, doce, todo al 100 %, una
cuota sin ventanas, sin instantes de reinicio, porcentajes en −5 y 250, una
proyección con el techo en el pasado, una historia de puntos idénticos, y
nombres largos— y se dibujaron las dos superficies con cada una.

Ninguna hizo crashear nada. Una mostró un bug de verdad: **con nombres largos el
texto se dibuja fuera de la tarjeta y se sale del panel**. Cairo no recorta por
su cuenta, así que un perfil llamado `.claude-nombre-larguisimo-…` pisaba el
borde y seguía de largo. Ahora todo lo que lleva dato del usuario se corta con
puntos suspensivos, y el número nunca cede: cede el nombre.

Quedó en el gate como una medición y no como una mirada: se dibuja el fixture de
nombres largos y se recorren los píxeles de la franja de afuera de la tarjeta,
que tienen que ser exactamente el color del fondo.

| Sabotaje | Qué dijo el gate |
|---|---|
| sacarle la elipsis al nombre de la cuenta | `hay algo dibujado en x=350, fuera de la tarjeta` |

Un detalle que costó: la primera versión del chequeo daba rojo con el código
sano. No era un desborde — eran las cuatro filas de la **esquina redondeada del
propio panel**, que pasa por esa franja. El chequeo saltea 18 px arriba y abajo.
