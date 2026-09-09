# H5 · la cuota, sin red y sin credencial

Fecha: 2026-09-09. Número comiteado: [`h5-cuota.json`](h5-cuota.json), generado
con `make numero-h5`.

## El hallazgo

Claude Code guarda en el `.claude.json` de cada perfil la última respuesta de
utilización que recibió:

```json
"cachedUsageUtilization": {
  "fetchedAtMs": 1788916089239,
  "accountUuid": "…",
  "utilization": { "five_hour": {…}, "seven_day": {…}, "limits": [ … ], "spend": {…} }
}
```

O sea que el número de cuota **es un dato de disco**. Tres consecuencias, y la
segunda es la que importa:

1. No cuesta una llamada de red. `qm` por defecto ya no toca la red.
2. **No necesita credencial.** Funciona en un perfil con el token vencido —
   exactamente el estado en el que la herramienta que motivó este repo se
   quedaba muda para siempre.
3. No puede discrepar con lo que el usuario ve adentro de Claude Code, porque
   es lo mismo que Claude Code está mirando.

El precio: es un cache, se refresca sólo cuando ese perfil corre. Por eso
`medidoEn` viaja pegado al número y `qm` imprime la edad («cache · hace 30m»),
y a partir de las 6 h lo marca como viejo. Un número viejo presentado como
actual es la misma mentira que el silencio.

## El segundo silencio, adentro de un mismo perfil

Hasta acá el problema era entre perfiles. El cache mostró que también lo hay
**dentro** de uno. La respuesta trae `limits[]`, y ahí aparece una barra que no
tiene entrada propia entre las claves con nombre:

| Barra | % | Severidad | ¿activa? | Alcance |
|---|---:|---|---|---|
| `session` (= `five_hour`) | 8 | normal | no | — |
| `weekly_all` (= `seven_day`) | 59 | normal | no | — |
| **`weekly_scoped`** | **75** | **warning** | **sí** | modelo Fable |

`seven_day_opus`, `seven_day_sonnet` y otras diez claves con nombre venían
literalmente `null`. Un monitor que lea `five_hour` y `seven_day` —que son las
dos que documenta la statusline, y las dos que usa todo el mundo— informa
**8 % y 59 %**, se ve cómodo, y esconde la única barra con aviso.

Medido en las dos cuentas de esta máquina:

| Perfil | session | weekly_all | weekly_scoped | Lo que informaría un lector de `five_hour` |
|---|---:|---:|---:|---|
| `.claude` (Max) | 8 % | 59 % | **75 % warning** | 8 % |
| `.claude-teams` (equipo) | 22 % | 40 % | 38 % | 22 % |

En la cuenta Max el error es de **67 puntos**.

## Qué queda del endpoint

Frescura, y nada más. `qm --refrescar` sigue pidiendo `/api/oauth/usage` para el
perfil cuyo cache quedó viejo, y sigue **sin ejecutarse nunca** (README, H2).
Pero ya no es el único camino al número, que era la parte frágil: el endpoint no
está documentado y puede desaparecer sin aviso.

La forma de la respuesta, en cambio, **ya no se adivina**: el cache guarda esa
misma respuesta, y de ahí salieron las fixtures de `test/fixtures/`. Confirmó
que la documentación embebida en el binario describía lo que Claude Code
*republica* (`used_percentage`, epoch en segundos) y no lo que *recibe*
(`utilization`, ISO con offset) — que era justo lo que el README sospechaba.
