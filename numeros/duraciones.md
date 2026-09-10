# Las duraciones no coinciden, y son dos convenciones, no un bug

**2026-09-10 · sin resolver: lo tienen que decidir Sol y Valentín.**

El repo tiene cuatro implementaciones de la misma escalera de duración. La regla
escrita en los comentarios es que todas den lo mismo. No lo dan, y no es que a
una le falte una rama: **son dos convenciones distintas, con tres renderizadores
de un lado y el CLI del otro.**

Medido corriendo las cuatro con los mismos segundos, no leyendo el código:

| segundos | CLI (`src/render/barras.ts`) | Swift, PowerShell, `dur()` | `dur_larga()` (panel de GNOME) |
|---|---|---|---|
| −1 | `vencido` | `ya` | `vencido` |
| 3600 | `1h00m` | `1h` | `1h00m` |
| 3660 | `1h01m` | `1h1m` | `1h01m` |
| 11280 | `3h08m` | `3h8m` | `3h08m` |
| 86400 | `1d` | `1d0h` | `1d` |
| 604800 | `7d` | `7d0h` | `7d` |

Tres puntos de desacuerdo: qué se dice de un instante que ya pasó, si los
minutos se rellenan con cero, y si un día justo se escribe `1d` o `1d0h`.

## Cómo llegamos acá

Las dos partes hicieron lo mismo y eligieron anclas distintas, y las dos tenían
razón en el método:

- **Sol** puso el panel de Windows al lado del de GNOME, vio que uno decía
  `127d19h` y el otro `3067h28m`, y alineó Python con Swift y PowerShell.
- **La otra mitad** alineó el panel con el CLI, porque `barras.ts` dice de sí
  mismo «todo lo que se imprime pasa por acá» y porque el panel y la terminal
  contando distinto el mismo reinicio es exactamente lo que no se puede
  distinguir de una mentira.

Nadie comparó **una GUI contra el CLI**. Por eso sobrevivió.

## Lo que hay que decidir

Cuál de las dos convenciones es la del proyecto. Después, una sola función por
lenguaje y un gate que compare las cuatro salidas contra una tabla fija — que es
lo único que evita que esto vuelva.

Mientras tanto, `dur()` en `bin/qm-indicator` **quedó sin usar**: el panel pasó a
`dur_larga()` en el commit del panel de GNOME. Se deja en su lugar a propósito,
para no borrar de un lado una decisión que se toma entre dos.
