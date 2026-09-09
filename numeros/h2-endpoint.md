# H2 · el endpoint, ejecutado por primera vez

`2026-09-09T14:49Z` · macOS 15.7.4 · datos crudos en
[`h2-endpoint.json`](h2-endpoint.json).

Hasta hoy este hito decía «escrito, **nunca ejecutado**». Se ejecutó. Anda: los
tres perfiles con credencial vigente contestaron, y `qm` los marcó
`endpoint · ahora` en vez de `cache · hace 1h35m`.

## Lo que se midió

Con el cache que Claude Code había dejado **95 minutos** antes, contra el número
que devolvió el endpoint en ese mismo instante:

| Perfil | Barra | Cache | Endpoint | Δ |
|---|---|---:|---:|---:|
| `.claude-personal` | **session** | 23 % | **34 %** | **+11** |
| | weekly_all | 64 % | 66 % | +2 |
| | weekly_scoped (Fable) | 75 % | 75 % | 0 |
| `.claude-teams` | **session** | 9 % | **19 %** | **+10** |
| | weekly_all | 42 % | 43 % | +1 |
| | weekly_scoped (Fable) | 41 % | 41 % | 0 |

## Lo que eso significa

**El cache se equivoca justo en la barra que se mira para decidir.** Las
semanales casi no se movieron en hora y media —0 a 2 puntos, que es ruido de
redondeo— pero la sesión se fue **10 y 11 puntos**. Tiene sentido y es
estructural: la ventana de 5 h se llena veinte veces más rápido que la de 7
días, así que la misma vejez de cache produce un error veinte veces más grande.

Y es la barra que contesta la pregunta urgente. «¿Llego al viernes?» tolera un
número de hace una hora; «¿puedo seguir trabajando ahora?» no.

Corolario: H5 —la cuota sin red ni credencial— **no queda obsoleto**, queda
acotado. Sigue siendo el piso correcto, el único que funciona con el token
vencido, y para las semanales es exacto. Pero para la sesión, un cache de más de
unos minutos informa de menos, siempre de menos, y en silencio.

## Otras dos cosas que se aprendieron corriéndolo

- **No vuelve a pedir el llavero.** El primer `--refrescar` autoriza; el
  segundo tardó **1,6 s** para los tres perfiles, sin un solo diálogo. Eso es lo
  que lo hace viable en un sondeo automático y no sólo a mano.
- **`.claude` sigue sin credencial**, y el endpoint lo dice con la misma frase
  que el disco: no hay estado nuevo que aprender.

## Lo que sigue sin verificarse

El error del endpoint. Ningún perfil devolvió 4xx ni 5xx en esta corrida, así
que las ramas de fallo —token vencido a mitad de camino, endpoint que
desaparece— siguen sin ejecutarse nunca. `SOUL.md` sigue teniendo razón en que
el endpoint puede irse sin aviso y en que las transcripciones son el piso.
