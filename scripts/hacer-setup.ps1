<#
El instalador de Windows, armado desde el árbol de trabajo.

Es el equivalente de scripts/hacer-deb.sh del otro lado, con una diferencia que
importa: el .deb NO compila nada —qm lee el TypeScript directo— y esto SÍ. El
instalador deja el paquete en Archivos de programa o en AppData, y ninguna de
las dos es node_modules, así que el type stripping andaría... pero el .iss
copia `dist\` a propósito igual: es lo que ya arma `npm run construir`, es lo
que viaja en el tarball de npm, y tener una sola forma del paquete es más
barato que tener dos. Si algún día hace falta el fuente, se cambia acá y en el
.iss, no en el lanzador: bin\qm.cmd ya prefiere dist\ y cae a src\ solo.

Necesita Inno Setup 6. En un runner de GitHub:  choco install innosetup -y
#>

[CmdletBinding()]
param(
  # Dónde dejar el .exe. Por defecto dist\, igual que el .deb.
  [string]$Destino = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$raiz = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
Push-Location $raiz
try {
  $version = (Get-Content (Join-Path $raiz 'package.json') -Raw | ConvertFrom-Json).version
  if (-not $version) { throw 'no pude sacar la versión de package.json' }

  # El mismo build que el tarball de npm. Sin esto el .iss copiaría un dist\
  # viejo —o ninguno— y el instalador saldría con un qm que no corre.
  Write-Host "· compilando dist/ …"
  & npm run --silent construir
  if ($LASTEXITCODE -ne 0) { throw "npm run construir salió $LASTEXITCODE" }
  if (-not (Test-Path (Join-Path $raiz 'dist\cli\qm.js'))) {
    throw 'construir no dejó dist\cli\qm.js: el instalador no tendría qué instalar'
  }

  $iscc = Get-Command 'iscc.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($iscc) {
    $isccRuta = $iscc.Source
  } else {
    # La tercera ruta es la del install POR USUARIO (`/CURRENTUSER`), que es el
    # que se puede hacer sin administrador — y el único que se pudo hacer en la
    # VM donde se probó esto. Sin ella, `choco install innosetup` anda y una
    # instalación a mano sin UAC no.
    $candidatos = @(
      "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
      "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
      "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )
    $isccRuta = $candidatos | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $isccRuta) {
    throw "no encuentro ISCC.exe (Inno Setup 6). Instalalo con:  choco install innosetup -y"
  }

  $iss = Join-Path $raiz 'scripts\quartermaster.iss'
  # Ojo: no se puede usar $args, que es automática y en un script con
  # [CmdletBinding()] ni siquiera está.
  $argumentos = @("/DVersion=$version", $iss)
  if ($Destino) { $argumentos = @("/O$Destino") + $argumentos }

  Write-Host "· compilando el instalador con $isccRuta"
  & $isccRuta @argumentos
  if ($LASTEXITCODE -ne 0) { throw "ISCC salió $LASTEXITCODE" }

  $salida = if ($Destino) { $Destino } else { Join-Path $raiz 'dist' }
  $exe = Join-Path $salida "quartermaster-$version-setup.exe"
  if (-not (Test-Path -LiteralPath $exe)) { throw "ISCC dijo que sí pero no está $exe" }

  $kb = [math]::Round((Get-Item $exe).Length / 1KB, 1)
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash

  # ── y el zip portable, que es lo que instala scoop ────────────────────
  # scoop no quiere instaladores: descomprime, arma shims y desinstala
  # borrando el directorio. Un .exe que escribe en el registro y toca el PATH
  # pelea con eso. Son los mismos archivos, sin instalador alrededor.
  $zip = Join-Path $salida "quartermaster-$version-win.zip"
  $armado = Join-Path ([System.IO.Path]::GetTempPath()) ("qm-zip-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path (Join-Path $armado 'bin') -Force | Out-Null
  foreach ($f in @('qm.cmd', 'qm-web.cmd', 'buscar-node.cmd', 'qm-web', 'qm-tray.ps1',
                   'qm-tray.cmd', 'qm-tray-quitar.cmd', 'quartermaster.ico')) {
    Copy-Item (Join-Path $raiz "bin\$f") (Join-Path $armado "bin\$f")
  }
  # Los DIRECTORIOS de dist\ y no dist\ entero: dist\ es también donde caen los
  # artefactos (el .deb, este .exe, este mismo .zip) y meter el instalador
  # adentro del zip sería empaquetar el paquete. Se copian los directorios, que
  # son lo que compila tsc, sin enumerar cuáles: el día que src\ gane uno
  # nuevo, viaja solo.
  New-Item -ItemType Directory -Path (Join-Path $armado 'dist') -Force | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $raiz 'dist') -Directory | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $armado 'dist') -Recurse
  }
  Copy-Item (Join-Path $raiz 'LICENSE') $armado
  Copy-Item (Join-Path $raiz 'README.md') $armado
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $armado '*') -DestinationPath $zip
  Remove-Item $armado -Recurse -Force -ErrorAction SilentlyContinue
  $shaZip = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
  $kbZip = [math]::Round((Get-Item $zip).Length / 1KB, 1)

  Write-Host ""
  Write-Host "✓ $exe  ($kb kB)"
  # Los SHA256 no son decorado: son lo que hay que pegar en el manifest de
  # winget y en el de scoop, y sacarlos acá evita calcularlos a mano dos veces.
  Write-Host "  sha256: $sha"
  Write-Host "✓ $zip  ($kbZip kB)"
  Write-Host "  sha256: $shaZip"
  Write-Host ""
  Write-Host "los manifests:  node scripts/hacer-manifests.mjs --exe $sha --zip $shaZip"
} finally {
  Pop-Location
}
