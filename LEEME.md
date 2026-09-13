<div align="center">

<img src="docs/img/logo-256.png" alt="" width="96" height="96">

# quartermaster

**Cuánta cuota te queda, en todas tus cuentas de agentes.**
Cada perfil de Claude Code —no sólo el de por defecto— más Codex y los
proveedores que guarda opencode.

[Landing](https://quartermaster.legios.com.ar/) ·
[Instalar](#instalar) ·
[Releases](https://github.com/legiosai/quartermaster/releases) ·
[Seguridad](SECURITY.md#seguridad) ·
[In English](README.md) ·
MIT

<sub>Un instrumento de</sub><br>
<a href="https://github.com/legiosai"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/legios.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/legios-claro.svg">
  <img alt="Legios" src="docs/legios-claro.svg" width="132" height="43">
</picture></a>

<img src="docs/img/barra.png" alt="La barra de arriba de GNOME con un medidor por cuenta" width="480">

</div>

> **Misión.** Que nadie se entere de que se quedó sin cuota chocándose contra el
> límite.

## El problema

Claude Code soporta varios perfiles vía `CLAUDE_CONFIG_DIR`, y cada perfil tiene
su cuenta y su credencial. Un asiento de trabajo y una suscripción personal en
la misma laptop es lo normal.

Los monitores que existen leen **una** credencial: la del directorio por
defecto. En la máquina donde se escribió esto, eso significa leer `~/.claude`,
que está vacío, mientras las dos cuentas reales viven en `~/.claude-personal` y
`~/.claude-teams`. Lo que se observó fue un monitor polleando cada 120 segundos
durante horas, escribiendo `credential expired — gating poll` en su log, y
mostrando nada.

quartermaster encuentra todas las cuentas, y el número lo saca del disco.

## Instalar

```sh
brew install legiosai/tap/quartermaster        # macOS y Linux
npm install -g @legios/quartermaster           # cualquier lado
```

**Windows:** el instalador de la [última
release](https://github.com/legiosai/quartermaster/releases/latest). Por usuario
y sin UAC: deja `qm` en el `PATH`, la bandeja en el menú Inicio y, si dejás
marcada la tarea, la bandeja arrancando sola.

**Debian y Ubuntu:** el `.deb` de esa misma release, o el repo de apt firmado:

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://quartermaster.legios.com.ar/apt/legios.gpg \
  | sudo tee /etc/apt/keyrings/legios.asc >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/legios.asc] \
  https://quartermaster.legios.com.ar/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/legios.list >/dev/null
sudo apt update && sudo apt install quartermaster
```

**Arch:** hay un `PKGBUILD` en [`paquetes/aur/`](paquetes/aur/PKGBUILD).
**Nix:** `nix run github:legiosai/quartermaster`.

O desde el repo, sin instalar nada global:

```sh
git clone https://github.com/legiosai/quartermaster && cd quartermaster
npm install && make instalar    # deja `qm` en ~/.local/bin
```

Necesita **Node >= 22.6**: `qm` lee el TypeScript sin paso de build, y eso
recién existe desde ahí. El lanzador lo busca en el `PATH`, en nvm, en fnm y en
volta; si no encuentra uno que sirva, lo dice y explica cómo conseguirlo en vez
de morir con un error de sintaxis.

## Uso

```sh
qm                  # cuota y consumo de cada cuenta
qm --breve          # un renglón — es lo que va en una statusline
qm --json           # lo mismo, para scripts y paneles
qm --refrescar      # además le pregunta al endpoint (necesita token vigente)
qm --watch 60       # se redibuja cada N segundos
qm --umbral=80      # sale 3 si alguna barra pasa el N %
qm --esperar        # no vuelve hasta que baje:  qm --esperar && codex ...
```

En el `settings.json` de Claude Code:

```json
{ "statusLine": { "type": "command", "command": "qm --breve" } }
```

```
personal 23/75%! · teams 9/42% · codex 49/59%
```

**Dos números por cuenta a propósito**: el primero es la sesión y el segundo la
barra que te frena antes. Contestan preguntas distintas —«¿puedo seguir ahora?»
y «¿llego al final de la semana?»— y una sola de las dos es media respuesta.

## Dónde se ve

| | |
|---|---|
| **Terminal** | `qm`, y `qm --breve` para la statusline: no lee transcripciones, así que tarda milisegundos |
| **GNOME** | un item en la barra de arriba, con el panel al primer click. Trae su propia extensión, porque la de AppIndicator se queda con el click izquierdo |
| **macOS** | la barra de menú, con texto vivo al lado del ícono |
| **Windows** | el área de notificación, con el porcentaje dibujado adentro del ícono como un medidor de batería |
| **Navegador** | `qm-web` — un tablero local, sólo en `127.0.0.1`. Anda en cualquier lado |
| **waybar** | [`paquetes/waybar/`](paquetes/waybar/) — para Hyprland, Sway y river |

Todos SÓLO dibujan: el CLI resuelve qué barra manda y emite la respuesta
resuelta en `qm --json`. Ningún renderer reimplementa una regla — y eso tiene
una cicatriz atrás, porque la misma función llegó a estar en Python, JavaScript
y Swift al mismo tiempo.

## Qué lee y qué sale de la máquina

El número **no necesita red ni credencial**: Claude Code deja la última
respuesta de cuota en el `.claude.json` de cada perfil, así que se lee del
disco. Por eso anda aunque el token esté vencido, que es el estado exacto en el
que murió el monitor que motivó todo esto.

Lo único que sale es un pedido, y sólo cuando lo pedís (`--refrescar`, o
`--calentar`, que es lo que corren los paneles):

```
GET https://api.anthropic.com/api/oauth/usage
```

El mismo host con el que Claude Code ya habla, con la credencial que ya tenés, y
con piso de 60 s. Sin cuenta, sin nube, sin telemetría, y con cero dependencias
de runtime. **Nunca refresca un token** — non-goal cerrado, y con test.

La tabla completa está en [`SECURITY.md`](SECURITY.md#seguridad).

## Los gestores de paquetes

Un tag publica en todos. `git push origin v0.1.7` dispara el workflow de
release, que arma cada artefacto y lo empuja a cada canal que tenga su secreto
configurado — y deja dicho en el log cuáles se salteó y por qué.

| | Instalar | Qué lleva | Lo publica |
|---|---|---|---|
| **npm** | `npm install -g @legios/quartermaster` | el tarball con `dist/`, **con provenance** | el tag, solo |
| **Homebrew** | `brew install legiosai/tap/quartermaster` | la fórmula, del tarball del tag | el tag, solo |
| **apt** | `sudo apt install quartermaster` | un repo **firmado**, así que `apt upgrade` trae la nueva sola | el tag, solo |
| **`.deb`** | `sudo apt install ./quartermaster_*.deb` | el mismo paquete, suelto | colgado de la release |
| **Instalador de Windows** | `quartermaster-<v>-setup.exe` | por usuario, sin UAC: `qm` en el `PATH` y la bandeja en el menú Inicio | colgado de la release |
| **scoop** | `scoop install quartermaster` | el zip portable, sin instalador | el tag, solo |
| **winget** | `winget install Legios.Quartermaster` | el instalador, declarando Node como dependencia | el tag manda el PR |
| **AUR** | `yay -S quartermaster` | el `PKGBUILD`, con un `nodejs>=22.6` de verdad | el tag, solo |
| **Nix** | `nix run github:legiosai/quartermaster` | el flake, con su Node adentro del cierre | no hay nada que publicar |
| **GNOME Extensions** | desde la app de Extensiones | la extensión del Shell | **a mano** — no tiene API de subida |
| **waybar** | copiar `paquetes/waybar/` | un módulo para Hyprland, Sway y river | se copia a mano |

La única excepción es extensions.gnome.org, que no tiene API para subir. La
release te lo recuerda, con el link al artefacto.

Cortar una versión es un comando:

```sh
./scripts/cortar-release.sh patch     # mueve la versión en los siete lugares,
                                      # corre los gates, comitea y etiqueta
git push origin main && git push origin v0.1.7
```

Lo que hay que tener configurado en cada canal está en
[`paquetes/README.md`](paquetes/README.md).

## Lo demás

- **[`SOUL.md`](SOUL.md)** — la misión, la métrica y los non-goals cerrados.
- **[`BITACORA.md`](BITACORA.md)** — la bitácora entera, que es el README que
  este repo tuvo hasta 0.1.6: cómo se llegó a cada decisión, con los errores
  adentro. Tres arquitecturas para el panel de GNOME antes de que una aguantara,
  una suposición sobre la barra de macOS que resultó falsa, un gate que miraba
  una función de 1500 líneas, y un paquete de npm que instalaba y no arrancaba.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — las tres reglas raras: todo se
  mide, los renderers sólo dibujan, los gates se prueban en rojo.
- **[`docs/esquema-json.md`](docs/esquema-json.md)** — el contrato de
  `qm --json`, si vas a escribir un consumidor.
- **[`numeros/`](numeros/)** — las mediciones, una por hito.

El código y sus comentarios están en castellano; lo que mira hacia afuera, en
inglés. Es a propósito, y `CONTRIBUTING.md` dice por qué.

## Licencia

MIT. Es la excepción a propósito: el núcleo de Legios —cartographer, healer,
pipeline— es propietario, y se publica lo que sirve suelto. Esto sirve suelto.

---

<div align="center">

<a href="https://github.com/legiosai"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/legios.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/legios-claro.svg">
  <img alt="Legios" src="docs/legios-claro.svg" width="150" height="49">
</picture></a>

<sub>Construido por Valentín Torassa y Sol Soletti.</sub>

</div>
