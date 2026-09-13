<!-- English or Spanish, whichever you prefer. -->

## Qué cambia, y por qué

<!-- El porqué, que es lo que el diff no muestra. -->

## Cómo se comprobó

<!--
El estándar del repo es un número de una máquina, no un argumento. Si medís
algo, va a `numeros/`. Si no se pudo medir, decilo — eso también va escrito.
-->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] los gates que toca este cambio (`make gate-npm`, `gate-dibujo`, `gate-bandeja`, `gate-windows`)
- [ ] si agrega un gate: **probado en rojo**

## SOUL.md

- [ ] No cruza ningún non-goal cerrado (refrescar tokens, nube, telemetría, el
      piso de 60 s, las transcripciones como piso).
- [ ] Si agrega o toca un renderer: **sólo dibuja**, no reimplementa reglas que
      ya resuelve `qm --json`.
