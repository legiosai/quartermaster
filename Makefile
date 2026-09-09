# Cada hito entrega tres cosas: una demo que se corre y se ve, un gate de CI
# probado en rojo, y un número comiteado. Las demos viven acá.

.PHONY: demo-h0
demo-h0:  ## H0 · perfiles: cuáles existen y cuáles AUTENTICAN
	@npm run --silent demo-h0

.PHONY: demo-h1
demo-h1:  ## H1 · consumo real leído de transcripciones locales, sin credenciales
	@npm run --silent demo-h1

.PHONY: qm
qm:  ## el comando: cuota + consumo de todos los perfiles
	@npm run --silent qm -- $(ARGS)

.PHONY: numero-h5
numero-h5:  ## H5 · comitea la cuota leída del cache, sin mails ni rutas de casa
	@npm run --silent qm -- --json --redactado > numeros/h5-cuota.json
	@echo "numeros/h5-cuota.json escrito"

.PHONY: instalar
instalar:  ## enlaza bin/qm en ~/.local/bin
	@mkdir -p $(HOME)/.local/bin
	@ln -sf "$(CURDIR)/bin/qm" "$(HOME)/.local/bin/qm"
	@echo "qm -> $(HOME)/.local/bin/qm"
	@command -v qm >/dev/null || echo "ojo: ~/.local/bin no está en tu PATH"

.PHONY: test
test:  ## los tests
	@npm run --silent test

.PHONY: typecheck
typecheck:  ## tsc --noEmit
	@npm run --silent typecheck

.PHONY: help
help:
	@grep -hE '^[a-z0-9-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'
