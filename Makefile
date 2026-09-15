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
	@./bin/qm-barra --instalar-arranque

.PHONY: barra-quitar
barra-quitar:  ## saca la barra del arranque automático y la cierra
	@./bin/qm-barra --sacar-arranque

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
	@# Lo hace el indicador, por lo mismo que el arranque automático: quien
	@# instaló por npm o por apt no tiene Makefile, y `qm` se la ofrece en la
	@# primera corrida llamando a esta misma bandera. Sale 2 cuando quedó
	@# instalada pero GNOME la carga recién en la próxima sesión, que no es un
	@# error: es lo que hay que decirle a quien la instaló.
	@"$(CURDIR)/bin/qm-indicator" --instalar-extension || [ $$? = 2 ]

.PHONY: extension-quitar
extension-quitar:  ## saca el item propio y devuelve el de AppIndicator
	@"$(CURDIR)/bin/qm-indicator" --quitar-extension

.PHONY: autostart
autostart:  ## que el indicador arranque solo al iniciar sesión
	@# El .desktop lo escribe el indicador, no este Makefile: quien instaló por
	@# apt o por npm no tiene un Makefile, y `qm` se lo ofrece en la primera
	@# corrida llamando a esta misma bandera. Dos lugares que escriben el mismo
	@# archivo se despegan; éste es el que había.
	@"$(CURDIR)/bin/qm-indicator" --instalar-arranque

.PHONY: autostart-quitar
autostart-quitar:  ## saca el indicador del arranque automático
	@"$(CURDIR)/bin/qm-indicator" --quitar-arranque

.PHONY: version
version:  ## mueve la versión a los siete lugares (V=0.1.7 o V=patch)
	@node scripts/bumpear.mjs "$(V)"

.PHONY: release
release:  ## corta una versión: bumpea, corre los gates, comitea y etiqueta (V=patch)
	@./scripts/cortar-release.sh "$(V)"

.PHONY: deb
deb:  ## arma el .deb en dist/
	@./scripts/hacer-deb.sh

.PHONY: setup
setup:  ## arma el instalador de Windows y el zip portable en dist/ (necesita Windows)
	@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$(wslpath -w scripts/hacer-setup.ps1 2>/dev/null || echo scripts/hacer-setup.ps1)" | tr -d '\r'

.PHONY: manifests
manifests:  ## los manifests de winget y scoop (EXE=<sha256> ZIP=<sha256>)
	@node scripts/hacer-manifests.mjs --exe "$(EXE)" --zip "$(ZIP)"

.PHONY: extension-zip
extension-zip:  ## el zip de la extensión con la forma que pide extensions.gnome.org
	@./scripts/hacer-extension-zip.sh

.PHONY: gate-duraciones
gate-duraciones:  ## que las cuatro escaleras de duración den lo mismo
	@python3 scripts/gate-duraciones.py

.PHONY: gate-lazo
gate-lazo:  ## que el calentado no pueda dejar de ocurrir en silencio
	@python3 scripts/gate-lazo.py

.PHONY: gate-lazo-rojo
gate-lazo-rojo:  ## el rojo de gate-lazo: la bandera pegada que no anotaba nada
	@cp bin/qm-indicator .qm-indicator.gate
	@# El `is not None` de 0.1.13: con la bandera pegada y sin instante, el
	@# caso caía al else y rearmaba para siempre sin escribir una línea.
	@sed -i 's|pasado = desde is None or (GLib.get_monotonic_time() - desde)|pasado = desde is not None and (GLib.get_monotonic_time() - desde)|' bin/qm-indicator
	@if python3 scripts/gate-lazo.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-lazo NO falló con la bandera pegada que no anota nada"; exit 1; \
	fi
	@mv .qm-indicator.gate bin/qm-indicator
	@echo "✓ gate-lazo falla en rojo con el silencio de 0.1.13 de vuelta"

.PHONY: gate-presupuesto
gate-presupuesto:  ## que las cinco frases de presupuesto digan los mismos números
	@python3 scripts/gate-presupuesto.py

.PHONY: gate-presupuesto-rojo
gate-presupuesto-rojo:  ## los tres rojos de gate-presupuesto: GNOME, el tablero y la redacción de la barra
	@cp bin/qm-indicator .qm-indicator.gate
	@# 1. el doble descuento de 0.1.11 de vuelta en GNOME: porDia en vez de porDiaHoy
	@python3 -c "import pathlib; p=pathlib.Path('bin/qm-indicator'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('por_dia_hoy = pre.get(\"porDiaHoy\", pre.get(\"porDia\")) or 0', 'por_dia_hoy = pre.get(\"porDia\") or 0'), encoding='utf-8')"
	@if python3 scripts/gate-presupuesto.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-presupuesto NO falló con el doble descuento de vuelta en GNOME"; exit 1; \
	fi
	@mv .qm-indicator.gate bin/qm-indicator
	@# 2. el tablero calculando la resta en vez de leerla
	@cp src/render/tablero.html .tablero.gate
	@sed -i 's|const porDiaHoy = pre.porDiaHoy ?? pre.porDia;|const porDiaHoy = pre.porDia;|' src/render/tablero.html
	@if python3 scripts/gate-presupuesto.py >/dev/null 2>&1; then \
	  mv .tablero.gate src/render/tablero.html; \
	  echo "✗ gate-presupuesto NO falló con el tablero volviendo a porDia"; exit 1; \
	fi
	@mv .tablero.gate src/render/tablero.html
	@# 3. una palabra distinta en la barra de macOS: la redacción también es la frase
	@cp bin/qm-barra.swift .qm-barra.gate
	@sed -i 's|desde las %@ · te queda %.1f|desde las %@ · te quedan %.1f|' bin/qm-barra.swift
	@if python3 scripts/gate-presupuesto.py >/dev/null 2>&1; then \
	  mv .qm-barra.gate bin/qm-barra.swift; \
	  echo "✗ gate-presupuesto NO falló con la barra de macOS diciendo «te quedan»"; exit 1; \
	fi
	@mv .qm-barra.gate bin/qm-barra.swift
	@echo "✓ gate-presupuesto falla en rojo con el doble descuento en GNOME, con el tablero calculando la resta y con una palabra cambiada en la barra de macOS"

.PHONY: gate-paquetes
gate-paquetes:  ## que la versión coincida en los siete lugares donde vive
	@./scripts/gate-paquetes.sh

.PHONY: gate-paquetes-rojo
gate-paquetes-rojo:  ## el rojo de gate-paquetes: el pie de una landing con la versión vieja
	@cp docs/es/index.html .es-index.gate
	@sed -i 's|releases">v[0-9][0-9.]*</a>|releases">v0.0.1</a>|' docs/es/index.html
	@if ./scripts/gate-paquetes.sh >/dev/null 2>&1; then \
	  mv .es-index.gate docs/es/index.html; \
	  echo "✗ gate-paquetes NO falló con el pie de la landing en una versión vieja. El gate no sirve."; exit 1; \
	else \
	  mv .es-index.gate docs/es/index.html; \
	  echo "✓ gate-paquetes falla en rojo con el pie de una landing en una versión vieja"; \
	fi

.PHONY: gate-calentado
gate-calentado:  ## que la cuenta frenada vuelva a preguntar apenas pasa su reinicio
	@python3 scripts/gate-calentado.py

.PHONY: gate-calentado-rojo
gate-calentado-rojo:  ## los dos rojos de gate-calentado: el filtro y la regla
	@cp bin/qm-indicator .qm-indicator.gate
	@# 1. reintroducir el corte `< 100` en calentar()
	@python3 -c "import pathlib; p=pathlib.Path('bin/qm-indicator'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('if self._vale_preguntar(t)]', 'if 40 <= self._tope(t) < 100]'), encoding='utf-8')"
	@if python3 scripts/gate-calentado.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-calentado NO falló con el corte < 100 de vuelta en calentar()"; exit 1; \
	fi
	@cp -f .qm-indicator.gate bin/qm-indicator
	@# 2. que la regla misma deje de mirar el reinicio
	@python3 -c "import pathlib; p=pathlib.Path('bin/qm-indicator'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('if self._ya_reinicio(t):\n            return True', 'if False:\n            return True'), encoding='utf-8')"
	@if python3 scripts/gate-calentado.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-calentado NO falló con la regla ignorando el reinicio"; exit 1; \
	fi
	@cp -f .qm-indicator.gate bin/qm-indicator
	@# 3. que deje de mirar si la cuenta se está usando
	@python3 -c "import pathlib; p=pathlib.Path('bin/qm-indicator'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('if self._activa_hace_poco(t):\n            return True', 'if False:\n            return True'), encoding='utf-8')"
	@if python3 scripts/gate-calentado.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-calentado NO falló con la regla ciega a la actividad"; exit 1; \
	fi
	@cp -f .qm-indicator.gate bin/qm-indicator
	@# 4. que calentar() se muera cuando ya hay uno en vuelo
	@python3 -c "import pathlib,re; p=pathlib.Path('bin/qm-indicator'); s=p.read_text(encoding='utf-8'); i=s.index('if self.calentando:'); j=s.index('args = [self.qm', i); p.write_text(s[:i]+'if self.calentando:\n            return False\n        '+s[j:], encoding='utf-8')"
	@if python3 scripts/gate-calentado.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-calentado NO falló con el lazo que se mata solo"; exit 1; \
	fi
	@cp -f .qm-indicator.gate bin/qm-indicator
	@# 5. que deje de escuchar la suspensión
	@python3 -c "import pathlib; p=pathlib.Path('bin/qm-indicator'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('self.vigilar_suspension()', 'pass  # sin suspension'), encoding='utf-8')"
	@if python3 scripts/gate-calentado.py >/dev/null 2>&1; then \
	  mv .qm-indicator.gate bin/qm-indicator; \
	  echo "✗ gate-calentado NO falló sin la escucha de suspensión"; exit 1; \
	fi
	@mv .qm-indicator.gate bin/qm-indicator
	@cp bin/qm-barra.swift .qm-barra.gate
	@# 6. que la barra de macOS vuelva a filtrar por nivel a secas
	@python3 -c "import pathlib; p=pathlib.Path('bin/qm-barra.swift'); s=p.read_text(encoding='utf-8'); p.write_text(s.replace('self.ultimas.filter { valePreguntar(\$$0) }', 'self.ultimas.filter { max(\$$0.sesion ?? 0, \$$0.semanal ?? 0) >= 40 }'), encoding='utf-8')"
	@if python3 scripts/gate-calentado.py >/dev/null 2>&1; then \
	  mv .qm-barra.gate bin/qm-barra.swift; \
	  echo "✗ gate-calentado NO falló con la barra filtrando por nivel a secas"; exit 1; \
	fi
	@mv .qm-barra.gate bin/qm-barra.swift
	@echo "✓ gate-calentado falla en rojo con el corte < 100, la regla ciega al reinicio, la ciega a la actividad, el lazo que se mata solo, sin escuchar la suspensión y con la barra de macOS filtrando por nivel"

.PHONY: gate-dibujo
gate-dibujo:  ## el gate de las superficies de GNOME: compila, parsea y dibuja
	@./scripts/gate-dibujo.sh

.PHONY: gate-dibujo-rojo
gate-dibujo-rojo:  ## los dos rojos de la cabecera: sin frenaPrimero, y encabezada por una dormida
	@cp test/fixtures/panel.json .panel.gate
	@python3 -c "import json;d=json.load(open('test/fixtures/panel.json'));d.pop('frenaPrimero',None);json.dump(d,open('test/fixtures/panel.json','w'),indent=4)"
	@if python3 scripts/gate-tarjetas.py >/dev/null 2>&1; then \
	  mv .panel.gate test/fixtures/panel.json; \
	  echo "✗ el gate NO falló con un fixture sin frenaPrimero: el panel se dibujaría sin cabecera y nadie se enteraría."; exit 1; \
	else \
	  mv .panel.gate test/fixtures/panel.json; \
	  echo "✓ el gate falla en rojo cuando el panel se queda sin cabecera"; \
	fi
	@cp test/fixtures/panel-dormida.json .dormida.gate
	@python3 -c "import json;d=json.load(open('test/fixtures/panel-dormida.json'));c=[p for p in d['perfiles'] if p['perfil']=='codex'][0];d['frenaPrimero']={'perfil':'codex','producto':'codex','ventana':c['cuota']['frena'],'dormida':True};json.dump(d,open('test/fixtures/panel-dormida.json','w'),indent=4)"
	@if python3 scripts/gate-tarjetas.py >/dev/null 2>&1; then \
	  mv .dormida.gate test/fixtures/panel-dormida.json; \
	  echo "✗ el gate NO falló con una cuenta dormida encabezando. Es el bug que el cambio vino a arreglar."; exit 1; \
	else \
	  mv .dormida.gate test/fixtures/panel-dormida.json; \
	  echo "✓ el gate falla en rojo cuando encabeza una cuenta dormida"; \
	fi

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

.PHONY: gate-winget-rojo
gate-winget-rojo:  ## el rojo del envío a winget: sin token, con token muerto, sin versión
	@fallo=0; \
	if V=0.1.6 DIR=. GITHUB_TOKEN= node scripts/mandar-pr-winget.mjs --en-seco >/dev/null 2>&1; then \
	  echo "✗ mandar-pr-winget NO falló sin token"; fallo=1; fi; \
	if GITHUB_TOKEN=x DIR=. node scripts/mandar-pr-winget.mjs --en-seco >/dev/null 2>&1; then \
	  echo "✗ mandar-pr-winget NO falló sin V"; fallo=1; fi; \
	if V=0.1.6 DIR=. GITHUB_TOKEN=ghp_0000000000000000000000000000000000000000 \
	   node scripts/mandar-pr-winget.mjs --en-seco >/dev/null 2>&1; then \
	  echo "✗ mandar-pr-winget NO falló con un token muerto"; fallo=1; fi; \
	if [ $$fallo -ne 0 ]; then \
	  echo "  El envío a winget puede volver a decir que mandó un PR sin haberlo mandado."; exit 1; fi; \
	echo "✓ mandar-pr-winget falla en rojo sin token, sin versión y con un token muerto"

.PHONY: gate-bandeja
gate-bandeja:  ## el gate de la bandeja de Windows: parsea, dibuja y mide (necesita Windows)
	@salida=$$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$(wslpath -w scripts/gate-bandeja.ps1 2>/dev/null || echo scripts/gate-bandeja.ps1)" 2>&1); \
	 codigo=$$?; printf '%s\n' "$$salida" | tr -d '\r'; exit $$codigo

.PHONY: gate-windows
gate-windows:  ## que qm.cmd corra y que el paquete de npm ARRANQUE en Windows
	@salida=$$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$$(wslpath -w scripts/gate-windows.ps1 2>/dev/null || echo scripts/gate-windows.ps1)" 2>&1); \
	 codigo=$$?; printf '%s\n' "$$salida" | tr -d '\r'; exit $$codigo

.PHONY: test
test:  ## los tests
	@npm run --silent test

.PHONY: typecheck
typecheck:  ## tsc --noEmit
	@npm run --silent typecheck

.PHONY: help
help:
	@grep -hE '^[a-z0-9-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'
