<#
El gate de Windows como PLATAFORMA, no como dibujo.

scripts/gate-bandeja.ps1 comprueba que la bandeja dibuje. Esto comprueba lo de
más abajo: que del lado de Windows exista un `qm` que arranque. Son dos cosas
distintas y la segunda estuvo rota todo este tiempo sin que nada la mirara.

Las tres cosas que se comprueban, y el defecto real que previene cada una:

  1. `bin\qm.cmd` corre desde el repo. Hasta que existió, la única forma de
     usar qm en Windows era escribir `node src\cli\qm.ts` a mano: está anotado
     al final de numeros/h4-windows.md como lo que faltaba para que Windows
     fuera una plataforma de primera y no un experimento.

  2. `npm install -g` deja un comando que ARRANCA. Este es el defecto gordo:
     npm arma los shims a partir del shebang, `bin/qm` es un `#!/bin/sh`, y el
     .cmd que generaba invocaba `sh` — que no está en el PATH de una máquina
     con Git for Windows instalado de la forma normal. O sea: instalaba bien y
     no corría, que es exactamente la forma del defecto que H9 encontró en el
     tarball. Por eso el gate INSTALA y EJECUTA, igual que
     scripts/el-paquete-de-npm-corre.sh en Linux: que el tarball tenga los
     archivos no prueba nada.

  3. El código de salida sobrevive el viaje. `qm --umbral` sale 3 y hay gente
     encadenando con eso; un lanzador que devuelve siempre 0 rompe eso en
     silencio, que es la peor forma de romperlo.

Y una cuarta cosa que no es un chequeo sino una MEDICIÓN: qué hace el shim
viejo —el de `bin/qm`— en esta misma máquina. El cambio se hizo razonando sobre
cómo npm arma los shims, y razonar no es medir. No falla el gate: deja el
número en el log, que es lo que faltaba.

Corre en Windows y en ningún otro lado: es sobre cmd.exe y sobre los shims que
npm genera para Windows. En otra plataforma se saltea diciéndolo.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  Write-Host 'gate de Windows: se saltea, esto no es Windows'
  exit 0
}

$raiz = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
$fallas = @()
function Fallar([string]$que) { $script:fallas += $que }

# ── 1 · qm.cmd desde el repo ────────────────────────────────────────────
$qmcmd = Join-Path $raiz 'bin\qm.cmd'
if (-not (Test-Path -LiteralPath $qmcmd)) {
  Fallar 'no está bin\qm.cmd: Windows vuelve a quedarse sin lanzador'
} else {
  $salida = & cmd.exe /c "`"$qmcmd`" --breve" 2>&1 | Out-String
  $codigo = $LASTEXITCODE
  # 3 es «cruzaste el umbral», no un error; y en una máquina sin ninguna cuenta
  # la salida puede ser una frase en vez de una tira de porcentajes. Lo que NO
  # puede pasar es que no imprima nada o que reviente.
  if ($codigo -ne 0 -and $codigo -ne 3) {
    Fallar "bin\qm.cmd --breve salió $codigo`n$($salida.Trim())"
  } elseif (-not $salida.Trim()) {
    Fallar 'bin\qm.cmd --breve no imprimió nada: silencio es el bug'
  } else {
    Write-Host "  ✓ bin\qm.cmd --breve: $($salida.Trim())"
  }

  # Una opción inventada tiene que salir 2 y explicar, no salir 0 en silencio.
  & cmd.exe /c "`"$qmcmd`" --no-existe-esta-opcion" > $null 2>&1
  if ($LASTEXITCODE -ne 2) {
    Fallar "una opción desconocida tiene que salir 2 y salió $LASTEXITCODE : el código no está viajando"
  } else {
    Write-Host '  ✓ el código de salida viaja (2 con una opción desconocida)'
  }
}

# ── 2 · el paquete de npm, instalado y corriendo ────────────────────────
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("qm-win-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  Push-Location $raiz
  & npm run --silent construir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm run construir salió $LASTEXITCODE" }
  $tarball = (& npm pack --silent --pack-destination $tmp | Select-Object -Last 1).Trim()
  if ($LASTEXITCODE -ne 0) { throw "npm pack salió $LASTEXITCODE" }
  Pop-Location

  $prefijo = Join-Path $tmp 'pref'
  & npm i -g --silent --prefix $prefijo (Join-Path $tmp $tarball) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm i -g salió $LASTEXITCODE" }

  # En Windows npm deja los shims en la raíz del prefix, no en bin\.
  $shim = Join-Path $prefijo 'qm.cmd'
  if (-not (Test-Path -LiteralPath $shim)) {
    Fallar "npm no dejó un qm.cmd en $prefijo — el comando no existe después de instalar"
  } else {
    $salida = & cmd.exe /c "`"$shim`" --breve" 2>&1 | Out-String
    $codigo = $LASTEXITCODE
    if ($codigo -ne 0 -and $codigo -ne 3) {
      Fallar "el qm instalado por npm salió $codigo`n$($salida.Trim())"
    } elseif (-not $salida.Trim()) {
      Fallar 'el qm instalado por npm no imprimió nada'
    } else {
      Write-Host "  ✓ qm --breve desde el paquete de npm: $($salida.Trim())"
    }
  }
} catch {
  Fallar "el paquete de npm no se pudo probar: $($_.Exception.Message)"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ── 3 · qué hacía el shim viejo, MEDIDO y no supuesto ───────────────────
# El cambio de `bin/qm` a `bin/qm.mjs` como entrada de npm salió de un
# razonamiento: npm arma el shim desde el shebang, el shebang es `#!/bin/sh` y
# `sh` no tiene por qué estar en el PATH de Windows. Razonar no es medir, y
# este repo tiene una carpeta entera (numeros/) sobre esa diferencia.
#
# Ya está medido —en una VM de Windows 10 22H2 sin Git, ver
# numeros/h10-distribucion.md—: npm genera un qm.cmd que hace
#
#   IF EXIST "%dp0%\/bin/sh.exe" ( SET "_prog=%dp0%\/bin/sh.exe" )
#   ELSE ( SET "_prog=/bin/sh" )
#
# y al invocarlo sale 1 con «El sistema no puede encontrar la ruta
# especificada», sin una sola palabra sobre qué falta.
#
# Esto lo vuelve a medir en cada máquina donde corra. La primera respuesta que
# dio fue mejor que la hipótesis: en el runner de windows-latest, que SÍ tiene
# `C:\Program Files\Git\bin\sh.exe` en el PATH, el shim viejo falla igual. El
# .cmd que genera npm no busca `sh` en el PATH: invoca `/bin/sh`, una ruta
# POSIX absoluta, salvo que exista `%dp0%\/bin/sh.exe`, que no existe nunca. O
# sea que el defecto no era «Windows sin Git», era Windows.
#
# Aun así NO falla el gate: sigue siendo una medición del entorno y no una
# propiedad de este repo, y un rojo por cómo está armado el PATH de una máquina
# no diría nada útil. Lo que hace es dejar el número en el log.
#
# $ErrorActionPreference vuelve a Continue acá adentro a propósito: con 'Stop',
# la primera línea que el shim viejo escribe en stderr es un error terminante y
# la medición se convierte en «no se pudo medir» — que fue exactamente lo que
# pasó la primera vez que esto corrió.
$erroresAntes = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$tmp2 = Join-Path ([System.IO.Path]::GetTempPath()) ("qm-viejo-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp2 -Force | Out-Null
$paqueteJson = Join-Path $raiz 'package.json'
$respaldo = Get-Content $paqueteJson -Raw -Encoding UTF8
try {
  $sh = Get-Command 'sh' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  Write-Host ("  · sh en el PATH de esta máquina: " + $(if ($sh) { $sh.Source } else { 'no hay' }))

  # UTF8Encoding $false y no `Set-Content -Encoding UTF8`: en PowerShell 5.1 ese
  # -Encoding UTF8 escribe CON BOM, así que el gate le agregaba un BOM al
  # package.json del repo cada vez que corría. Medido: 1891 bytes con BOM
  # después de una corrida, contra 1888 antes.
  $sinBom = New-Object System.Text.UTF8Encoding $false
  $j = $respaldo | ConvertFrom-Json
  $j.bin.qm = 'bin/qm'
  [IO.File]::WriteAllText($paqueteJson, ($j | ConvertTo-Json -Depth 10), $sinBom)

  Push-Location $raiz
  $tarballViejo = (& npm pack --silent --pack-destination $tmp2 | Select-Object -Last 1).Trim()
  Pop-Location
  $prefijoViejo = Join-Path $tmp2 'pref'
  & npm i -g --silent --prefix $prefijoViejo (Join-Path $tmp2 $tarballViejo) 2>&1 | Out-Null

  $shimViejo = Join-Path $prefijoViejo 'qm.cmd'
  if (-not (Test-Path -LiteralPath $shimViejo)) {
    Write-Host '  · con bin/qm (sh), npm no dejó ni un qm.cmd'
  } else {
    $salidaVieja = & cmd.exe /c "`"$shimViejo`" --breve" 2>&1 | Out-String
    $codigoViejo = $LASTEXITCODE
    if ($codigoViejo -eq 0 -or $codigoViejo -eq 3) {
      Write-Host "  · con bin/qm (sh) el shim TAMBIÉN arranca en esta máquina (salió $codigoViejo)"
    } else {
      Write-Host "  · con bin/qm (sh) el shim NO arranca: salió $codigoViejo — $(($salidaVieja.Trim() -split "`n")[0])"
    }
  }
} catch {
  Write-Host "  · no se pudo medir el shim viejo: $($_.Exception.Message)"
} finally {
  # El package.json se restaura pase lo que pase: dejarlo apuntando al bin
  # viejo sería romper el paquete sin que nadie se entere hasta publicar. Byte
  # por byte, sin BOM: ver el comentario de arriba.
  [IO.File]::WriteAllText($paqueteJson, $respaldo, (New-Object System.Text.UTF8Encoding $false))
  Remove-Item $tmp2 -Recurse -Force -ErrorAction SilentlyContinue
  $ErrorActionPreference = $erroresAntes
}

if ($fallas.Count) {
  foreach ($f in $fallas) { [Console]::Error.WriteLine("GATE ROJO: $f") }
  exit 1
}
Write-Host 'gate de Windows: verde — qm.cmd corre desde el repo, el paquete de npm instala y arranca, y el código de salida viaja'
exit 0
