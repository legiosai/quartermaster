# paquetes

Las vías por las que alguien puede instalar quartermaster sin clonar el repo, y
qué hay que hacer para publicar cada una.

Esto no es documentación de instalación —eso está en el README— sino la del
otro lado del mostrador: lo que hay que correr y dónde hay que mandarlo cuando
sale una versión.

| Canal | Qué instala | Dónde | Lo dispara el tag | Secreto que necesita |
|---|---|---|---|---|
| npm | el tarball con `dist/` | registry de npm | sí, con provenance | `NPM_TOKEN` |
| Homebrew | la fórmula | `legiosai/homebrew-tap` | sí | `TOKEN_PAQUETES` |
| apt | el repo firmado | `docs/apt/` (GitHub Pages) | sí | `GPG_PRIVADA` |
| release de GitHub | `.deb`, `setup.exe`, los dos zips | la release | sí | — |
| scoop | el zip portable | `legiosai/scoop-bucket` | sí | `TOKEN_PAQUETES` |
| winget | el instalador | PR a `microsoft/winget-pkgs` | sí, manda el PR | `TOKEN_PAQUETES` |
| AUR | el `PKGBUILD` | `aur.archlinux.org` | sí | `AUR_SSH` |
| extensions.gnome.org | el zip de la extensión | el sitio | **no: no tiene API** | — |
| Nix | `flake.nix` | nada: se instala del repo | — | — |
| waybar | `paquetes/waybar/` | se copia a mano | — | — |

**Cada canal se saltea solo si le falta su secreto**, y el resumen al final de
la release dice cuáles quedaron afuera. Una release no se cae porque el AUR
todavía no esté configurado — pero tampoco se hace la que publicó todo.

## Los secretos, y qué tiene que tener cada uno

```sh
gh secret set NPM_TOKEN       # un automation token de npm
gh secret set TOKEN_PAQUETES  # un PAT clásico con repo + public_repo
gh secret set GPG_PRIVADA     # gpg --export-secret-keys --armor <ID>, SIN FRASE
gh secret set GPG_CLAVE_ID    # opcional: el ID de la clave, si no es el default
gh secret set AUR_SSH         # la clave privada SSH de la cuenta del AUR
```

Dos detalles que hacen fallar la release si se pasan por alto:

- **`GPG_PRIVADA` tiene que estar exportada sin frase.** `hacer-apt.sh` firma
  con `gpg --batch` y no le pasa ninguna, y en CI no hay nadie para contestar el
  prompt. El workflow lo comprueba y falla temprano con ese mensaje.
- **`TOKEN_PAQUETES` necesita `public_repo`** además de `repo`: es el que usa
  `wingetcreate` para forkear `microsoft/winget-pkgs`.

Una nota sobre winget, que es el único que le manda algo a un repo ajeno: el PR
lo arma `wingetcreate`, que es la herramienta que Microsoft publica justo para
eso, y el workflow valida los manifests ANTES de mandarlo. Del otro lado igual
lo mira una persona. Por eso el disparador es un tag y no un push: no se puede
mandar un PR sin querer.

---

## Windows: el instalador

```powershell
powershell -File scripts\hacer-setup.ps1
```

Necesita Inno Setup 6 (`choco install innosetup -y`) y deja en `dist\`:

- `quartermaster-<v>-setup.exe` — el instalador, con sus dos SHA256 impresos;
- `quartermaster-<v>-win.zip` — el mismo contenido sin instalador, para scoop.

El instalador es **por usuario y sin UAC**: deja todo en
`%LOCALAPPDATA%\Programs\quartermaster`, agrega `bin\` al PATH del usuario, crea
los accesos directos y —si se deja marcada la tarea— pone la bandeja en el
arranque. Se desinstala desde «Aplicaciones instaladas», y el desinstalador
cierra la bandeja antes de borrar nada.

Lo que **no** hace: traer Node. Si no hay un Node ≥ 22.6, lo dice al final de la
instalación, preguntándole a `bin\buscar-node.cmd` —el mismo archivo que usa el
CLI— en vez de reimplementar la búsqueda adentro del instalador.

El CI lo compila en cada push (job `bandeja`) y sube el `.exe` como artifact: un
`.iss` roto no se descubre el día de la release.

## winget

```powershell
# 1. armar los artefactos y anotar los dos hashes que imprime
powershell -File scripts\hacer-setup.ps1
# 2. generar los manifests con esos hashes
node scripts/hacer-manifests.mjs --exe <sha256 del exe> --zip <sha256 del zip>
```

Quedan en `dist/paquetes/winget/manifests/l/Legios/Quartermaster/<v>/`. Para
publicar:

1. subir el `.exe` y el `.zip` a la release de GitHub de esa versión (las URLs
   de los manifests apuntan ahí);
2. validar: `winget validate --manifest <ese directorio>`;
3. probar de verdad: `winget install --manifest <ese directorio>`;
4. PR a [`microsoft/winget-pkgs`](https://github.com/microsoft/winget-pkgs) con
   ese directorio tal cual. O `wingetcreate submit`, que hace el fork y el PR.

El manifest declara `OpenJS.NodeJS.LTS` como dependencia: eso es lo que hace que
`winget install Legios.Quartermaster` en una máquina sin Node resuelva las dos
cosas en vez de dejar un comando que no arranca.

**Con una advertencia medida**: el instalador de quartermaster es por usuario y
no pide UAC, pero **el MSI de Node sí**. En una VM sin elevar, ese paso sale
`1602` (el usuario canceló el UAC). O sea que `winget install` en una máquina
sin Node va a mostrar un prompt de administrador que no es nuestro.

## scoop

El mismo generador deja `dist/paquetes/scoop/quartermaster.json`. Va a un bucket
—`legiosai/scoop-bucket`, que todavía no existe— y se instala así:

```powershell
scoop bucket add legios https://github.com/legiosai/scoop-bucket
scoop install quartermaster
```

Trae `checkver`/`autoupdate` apuntando a las releases, así que las versiones
siguientes las puede levantar el bot de scoop sin tocar el JSON a mano.

## extensions.gnome.org

```sh
make extension-zip     # deja dist/quartermaster@legios.shell-extension.zip
```

El script valida lo que el sitio rechaza y no se ve mirando el directorio:
`metadata.json` y `extension.js` en la RAÍZ del zip (no adentro de una carpeta
con el uuid), el `stylesheet.css` adentro, que el uuid coincida con el
directorio y que el `metadata.json` **no** traiga `"version"` — ese número lo
pone el sitio, lo nuestro va en `version-name`.

Subir a <https://extensions.gnome.org/upload/> con cuenta propia. Después la
revisa una persona, y lo que mira es:

- que `disable()` deshaga todo lo que hizo `enable()`. Acá: se saca el timeout
  del latido, se cancela el `Gio.FileMonitor` y se destruye el item;
- que no haya código que se ejecute al importar el módulo;
- que quede claro qué hace la extensión y de qué depende. Por eso la
  descripción del `metadata.json` está **en inglés** y dice con todas las letras
  que los números los dibuja el CLI y que sin él no hay nada que mostrar: el
  revisor no tiene por qué adivinarlo, y es la mitad de las devoluciones.

La descripción es lo único del proyecto que está en inglés por decisión y no
por descuido: es la vidriera de un catálogo global.

## AUR

`paquetes/aur/` tiene el `PKGBUILD` y el `.SRCINFO`, los dos en 0.1.6 y
comprobados por `make gate-paquetes` — el AUR rechaza el push si no coinciden, y
el mensaje no dice en qué campo. Falta el `sha256sums`, que se completa con
`updpkgsums` cuando el tag existe y el tarball se puede bajar.

El nombre `quartermaster` está libre en el AUR (comprobado contra la RPC). Para
publicar hace falta una cuenta con clave SSH:

```sh
git clone ssh://aur@aur.archlinux.org/quartermaster.git aur-quartermaster
cp paquetes/aur/PKGBUILD paquetes/aur/.SRCINFO aur-quartermaster/
cd aur-quartermaster && updpkgsums && makepkg --printsrcinfo > .SRCINFO
git add -A && git commit -m "0.1.6" && git push
```

## Nix

`flake.nix` en la raíz. No hay nada que publicar: se instala apuntando al repo.

```sh
nix run github:legiosai/quartermaster
```

## waybar

`paquetes/waybar/` tiene el módulo (`qm-waybar`), el pedazo de config y el CSS.
Se copia a mano; no hay catálogo. Es la superficie que faltaba para Hyprland,
Sway y river, que es justo donde el indicador de GNOME no sirve.

```sh
sudo install -m755 paquetes/waybar/qm-waybar /usr/local/bin/qm-waybar
```

Como todos los renderers, sólo dibuja: le pide `qm --json --breve` y lee
`mostrar` y `frena` ya resueltos. Si algún día hay que reimplementar una regla
acá adentro, el bug está en el CLI (ver `SOUL.md`).
