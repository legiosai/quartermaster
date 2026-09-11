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
	@grep -qi microsoft /proc/version 2>/dev/null && ln -sf "$(CURDIR)/bin/qm-tray" "$(HOME)/.local/bin/qm-tray" || true
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

.PHONY: tray
tray:  ## arranca el item en la bandeja de Windows (ARGS="-Iconos general,main")
	@setsid nohup "$(CURDIR)/bin/qm-tray" $(ARGS) >/dev/null 2>&1 < /dev/null & \
	 sleep 3; echo "tray arrancado · se sale desde su propio menú"

.PHONY: tray-autostart
tray-autostart:  ## que la bandeja arranque sola al iniciar sesión de Windows
	@GUION="$$(wslpath -w '$(CURDIR)/bin/qm-tray.ps1')"; \
	 powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
	  "\$$s = (New-Object -ComObject WScript.Shell); \
	   \$$l = \$$s.CreateShortcut((Join-Path \$$s.SpecialFolders('Startup') 'quartermaster.lnk')); \
	   \$$l.TargetPath = 'powershell.exe'; \
	   \$$l.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"'+'$$GUION'+'\" -QmLinux $(CURDIR)/bin/qm'; \
	   \$$l.WindowStyle = 7; \
	   \$$l.Description = 'quartermaster · cuota en la bandeja'; \
	   \$$l.Save(); \
	   'escrito: ' + \$$l.FullName" | tr -d '\r'

.PHONY: tray-quitar
tray-quitar:  ## saca la bandeja del arranque automático y la cierra
	@powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
	  "\$$s = (New-Object -ComObject WScript.Shell); \
	   Remove-Item (Join-Path \$$s.SpecialFolders('Startup') 'quartermaster.lnk') -ErrorAction SilentlyContinue; \
	   Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | \
	     Where-Object { \$$_.ProcessId -ne \$$PID -and \$$_.CommandLine -like '*qm-tray.ps1*' } | \
	     ForEach-Object { Stop-Process -Id \$$_.ProcessId -Force }" 2>/dev/null | tr -d '\r'
	@echo "bandeja sacada"

.PHONY: indicador
indicador:  ## arranca el item de la barra de GNOME (necesita appindicatorsupport)
	@setsid nohup "$(CURDIR)/bin/qm-indicator" >/dev/null 2>&1 < /dev/null & \
	 sleep 2; echo "indicador arrancado"

.PHONY: extension
extension:  ## el item propio en la barra de GNOME: un click abre el panel
	@mkdir -p $(HOME)/.local/share/gnome-shell/extensions
	@rm -rf $(HOME)/.local/share/gnome-shell/extensions/quartermaster@legios
	@cp -rf "$(CURDIR)/extension/quartermaster@legios" $(HOME)/.local/share/gnome-shell/extensions/
	@# GNOME Shell no carga una extensión recién instalada en Wayland, así que
	@# `gnome-extensions enable` falla con «doesn't exist». Anotarla en la lista
	@# de habilitadas hace que quede puesta al volver a entrar.
	@gsettings get org.gnome.shell enabled-extensions | grep -q 'quartermaster@legios' || gsettings set org.gnome.shell enabled-extensions "$$(gsettings get org.gnome.shell enabled-extensions | sed "s/^@as .\[.\]$$/['quartermaster@legios']/; s/]$$/, 'quartermaster@legios']/")"
	@gnome-extensions enable quartermaster@legios 2>/dev/null && echo "extensión habilitada ahora" || echo "instalada y anotada. GNOME no carga extensiones nuevas en Wayland: cerrá sesión y volvé a entrar una vez."

.PHONY: extension-quitar
extension-quitar:  ## saca el item propio y devuelve el de AppIndicator
	@gnome-extensions disable quartermaster@legios 2>/dev/null || true
	@rm -rf $(HOME)/.local/share/gnome-shell/extensions/quartermaster@legios
	@rm -f $(HOME)/.cache/quartermaster/extension-viva
	@echo "extensión quitada"

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

.PHONY: deb
deb:  ## arma el .deb en dist/
	@./scripts/hacer-deb.sh

.PHONY: gate-duraciones
gate-duraciones:  ## que las cuatro escaleras de duración den lo mismo
	@python3 scripts/gate-duraciones.py

.PHONY: gate-dibujo
gate-dibujo:  ## el gate de las superficies de GNOME: compila, parsea y dibuja
	@./scripts/gate-dibujo.sh

.PHONY: construir
construir:  ## compila src/ a dist/ — sólo hace falta para el tarball de npm
	@npm run --silent construir

.PHONY: gate-npm
gate-npm:  ## que el tarball de npm se INSTALE y CORRA, no sólo que exista
	@./scripts/el-paquete-de-npm-corre.sh

.PHONY: gate-npm-rojo
gate-npm-rojo:  ## el rojo de gate-npm: el paquete como estaba, con src/ y sin dist/
	@cp package.json .package.json.gate
	@python3 -c "import json,collections;from pathlib import Path;p=Path('package.json');d=json.loads(p.read_text(),object_pairs_hook=collections.OrderedDict);d['files']=['bin/','src/','LICENSE','README.md'];p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+chr(10))"
	@if ./scripts/el-paquete-de-npm-corre.sh >/dev/null 2>&1; then \
	  mv .package.json.gate package.json; \
	  echo "✗ gate-npm NO falló con un paquete sin dist/. El gate no sirve."; exit 1; \
	else \
	  mv .package.json.gate package.json; \
	  echo "✓ gate-npm falla en rojo con el paquete sin dist/ (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)"; \
	fi

.PHONY: gate-bandeja
gate-bandeja:  ## el gate de la bandeja de Windows: parsea, dibuja y mide (necesita Windows)
	@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$(wslpath -w scripts/gate-bandeja.ps1 2>/dev/null || echo scripts/gate-bandeja.ps1)" | tr -d '\r'

.PHONY: test
test:  ## los tests
	@npm run --silent test

.PHONY: typecheck
typecheck:  ## tsc --noEmit
	@npm run --silent typecheck

.PHONY: help
help:
	@grep -hE '^[a-z0-9-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'
