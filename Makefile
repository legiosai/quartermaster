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
	@ln -sf "$(CURDIR)/bin/qm-web" "$(HOME)/.local/bin/qm-web"
	@[ "$$(uname -s)" = "Darwin" ] && ln -sf "$(CURDIR)/bin/qm-barra" "$(HOME)/.local/bin/qm-barra" || true
	@echo "qm -> $(HOME)/.local/bin/qm"
	@echo "qm-web -> $(HOME)/.local/bin/qm-web"
	@command -v qm >/dev/null || echo "ojo: ~/.local/bin no está en tu PATH"

.PHONY: web
web:  ## el tablero en el navegador (macOS, Windows, y Linux sin GNOME)
	@./bin/qm-web $(ARGS)

.PHONY: barra
barra:  ## el item en la barra de menú de macOS (compila si hace falta)
	@./bin/qm-barra

.PHONY: barra-autostart
barra-autostart:  ## que la barra arranque sola al iniciar sesión, vía launchd
	@mkdir -p $(HOME)/Library/LaunchAgents
	@printf '%s\n' \
	  '<?xml version="1.0" encoding="UTF-8"?>' \
	  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
	  '<plist version="1.0"><dict>' \
	  '  <key>Label</key><string>com.legios.quartermaster.barra</string>' \
	  '  <key>ProgramArguments</key><array><string>$(CURDIR)/bin/qm-barra</string></array>' \
	  '  <key>RunAtLoad</key><true/>' \
	  '  <key>KeepAlive</key><false/>' \
	  '</dict></plist>' \
	  > $(HOME)/Library/LaunchAgents/com.legios.quartermaster.barra.plist
	@launchctl unload $(HOME)/Library/LaunchAgents/com.legios.quartermaster.barra.plist 2>/dev/null || true
	@launchctl load  $(HOME)/Library/LaunchAgents/com.legios.quartermaster.barra.plist
	@echo "barra cargada en launchd · arranca sola al iniciar sesión"
	@echo "para sacarla: make barra-quitar"

.PHONY: barra-quitar
barra-quitar:  ## saca la barra del arranque automático y la cierra
	@launchctl unload $(HOME)/Library/LaunchAgents/com.legios.quartermaster.barra.plist 2>/dev/null || true
	@rm -f $(HOME)/Library/LaunchAgents/com.legios.quartermaster.barra.plist
	@pkill -f "quartermaster/qm-barra" 2>/dev/null || true
	@echo "barra sacada"

.PHONY: indicador
indicador:  ## arranca el item de la barra de GNOME (necesita appindicatorsupport)
	@setsid nohup "$(CURDIR)/bin/qm-indicator" >/dev/null 2>&1 < /dev/null & \
	 sleep 2; echo "indicador arrancado"

.PHONY: autostart
autostart:  ## que el indicador arranque solo al iniciar sesión
	@mkdir -p $(HOME)/.config/autostart
	@printf '%s\n' \
	  '[Desktop Entry]' \
	  'Type=Application' \
	  'Name=quartermaster' \
	  'Comment=Cuota de Claude Code en la barra de arriba' \
	  'Exec=$(CURDIR)/bin/qm-indicator' \
	  'Icon=utilities-system-monitor-symbolic' \
	  'Terminal=false' \
	  'X-GNOME-Autostart-enabled=true' \
	  > $(HOME)/.config/autostart/quartermaster.desktop
	@echo "$(HOME)/.config/autostart/quartermaster.desktop escrito"

.PHONY: test
test:  ## los tests
	@npm run --silent test

.PHONY: typecheck
typecheck:  ## tsc --noEmit
	@npm run --silent typecheck

.PHONY: help
help:
	@grep -hE '^[a-z0-9-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'
