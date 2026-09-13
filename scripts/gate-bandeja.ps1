<#
El gate de la bandeja de Windows, que era la superficie que nadie miraba.

De las ~1500 líneas de bin/qm-tray.ps1, el CI comprobaba UNA función: la
escalera de duración, que scripts/gate-duraciones.py extrae y corre suelta.
Todo lo demás —el panel, los íconos, el modelo de qué va en cada uno— pasaba en
verde con un error de sintaxis adentro. Es exactamente lo que le pasó a
bin/qm-indicator antes de que existiera scripts/gate-dibujo.sh: se borró medio
archivo y el CI no se enteró, porque el CI ni lo abría.

Cinco cosas, en orden de qué tan barato es equivocarse:

  1. que PARSEE — un error de sintaxis no llega a ejecutarse nunca;
  2. que DIBUJE. Con una entrada fija el panel tiene que salir con las medidas
     de siempre y con píxeles adentro. Un error de dibujo —una llamada a GDI+
     con un argumento de menos, una medida que no coincide con lo que pinta— no
     rompe el parseo;
  3. que NADA SE SALGA DE LA TARJETA. GDI+ no recorta cuando se dibuja en un
     punto, así que un nombre de perfil largo se dibujaba por encima del borde
     y un nombre de ventana largo se metía debajo del porcentaje. Se comprueba
     con el fixture de nombres largos, mirando los píxeles de la franja de
     afuera en vez de mirar la imagen a ojo;
  4. que cada ícono tenga SU panel: el general con todas las cuentas y el de
     una cuenta con esa sola. Es la diferencia entre cuatro íconos que sirven
     y cuatro íconos que abren la misma pantalla;
  5. que sepa DÓNDE está qm. La bandeja corre el qm nativo de Windows o el de
     adentro de WSL, y esa elección decide si hay números o no hay nada. Se
     comprueba sacando las funciones por AST y corriéndolas contra un bin de
     mentira, porque cargar el archivo entero levanta una bandeja de verdad.

Corre en Windows porque System.Drawing y WinForms son de Windows. En el runner
de Ubuntu se saltea diciéndolo — nunca se da por bueno en silencio.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$raiz = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
$guion = Join-Path $raiz 'bin\qm-tray.ps1'
$fixture = Join-Path $raiz 'test\fixtures\panel.json'
$largos = Join-Path $raiz 'test\fixtures\panel-largos.json'
$salida = Join-Path ([System.IO.Path]::GetTempPath()) ("qm-gate-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $salida -Force | Out-Null

$fallas = @()
function Fallar([string]$que) { $script:fallas += $que }

# ── 1 · que parsee ──────────────────────────────────────────────────────
$errores = $null
[System.Management.Automation.Language.Parser]::ParseFile($guion, [ref]$null, [ref]$errores) | Out-Null
if ($errores -and $errores.Count) {
  foreach ($e in $errores | Select-Object -First 5) {
    Fallar "bin/qm-tray.ps1 no parsea (línea $($e.Extent.StartLineNumber)): $($e.Message)"
  }
  foreach ($f in $fallas) { Write-Error "GATE ROJO: $f" -ErrorAction Continue }
  exit 1
}

function Capturar([string]$desde, [string]$panel, [string]$tema, [string]$png) {
  $ps = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $guion,
          '-Desde', $desde, '-Captura', $png, "-$tema")
  if ($panel) { $ps += @('-Panel', $panel) }
  $p = Start-Process powershell.exe -ArgumentList $ps -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput "$png.txt" -RedirectStandardError "$png.err"
  if ($p.ExitCode -ne 0) {
    $msg = (Get-Content "$png.err" -Raw -ErrorAction SilentlyContinue)
    Fallar "la captura de '$panel' ($tema) salió $($p.ExitCode): $($msg -split "`n" | Select-Object -First 1)"
    return $null
  }
  if (-not (Test-Path $png)) { Fallar "la captura de '$panel' no escribió el PNG"; return $null }
  return [System.Drawing.Bitmap]::FromFile($png)
}

Add-Type -AssemblyName System.Drawing

# ── 2 · que dibuje ──────────────────────────────────────────────────────
# El ancho es el del diseño y no una casualidad: si cambia, lo cambió alguien.
$ANCHO = 340

$bmp = Capturar $fixture '' 'Oscuro' (Join-Path $salida 'general.png')
if ($bmp) {
  if ($bmp.Width -ne $ANCHO) { Fallar "el panel general salió de $($bmp.Width) px de ancho y tiene que ser $ANCHO" }
  if ($bmp.Height -lt 300 -or $bmp.Height -gt 2400) {
    Fallar "el panel general salió de $($bmp.Height) px de alto, fuera de lo razonable"
  }
  # Un PNG del tamaño correcto y enteramente del color de fondo pasa cualquier
  # chequeo de medidas y no dibujó nada.
  $fondo = $bmp.GetPixel(2, 2)
  $distintos = 0
  for ($y = 0; $y -lt $bmp.Height; $y += 3) {
    for ($x = 0; $x -lt $bmp.Width; $x += 3) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -ne $fondo.R -or $c.G -ne $fondo.G -or $c.B -ne $fondo.B) { $distintos++ }
    }
  }
  if ($distintos -lt 500) { Fallar "el panel general está casi vacío: $distintos muestras con algo" }
  $altoGeneral = $bmp.Height
  $bmp.Dispose()
} else { $altoGeneral = 0 }

# ── 3 · que nada se salga de la tarjeta ─────────────────────────────────
# La franja de afuera tiene que ser del color del fondo. Los separadores entre
# tarjetas SÍ cruzan de lado a lado, así que una fila entera de un solo color
# distinto del fondo es un separador y no un desborde.
$bmp = Capturar $largos '' 'Oscuro' (Join-Path $salida 'largos.png')
if ($bmp) {
  $fondo = $bmp.GetPixel(2, 2)
  $FRANJA = 11   # el margen del diseño es 15; se deja aire por el antialias
  $sucias = @()
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    $izq = $bmp.GetPixel(1, $y)
    # Una fila de separador: el píxel del borde y el del centro son iguales.
    $centro = $bmp.GetPixel([int]($bmp.Width / 2), $y)
    if ($izq.R -eq $centro.R -and $izq.G -eq $centro.G -and $izq.B -eq $centro.B -and
        ($izq.R -ne $fondo.R -or $izq.G -ne $fondo.G -or $izq.B -ne $fondo.B)) { continue }
    foreach ($x in @(0..($FRANJA - 1)) + @(($bmp.Width - $FRANJA)..($bmp.Width - 1))) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -ne $fondo.R -or $c.G -ne $fondo.G -or $c.B -ne $fondo.B) { $sucias += "$x,$y" }
    }
  }
  if ($sucias.Count) {
    Fallar ("con nombres largos hay $($sucias.Count) píxeles dibujados fuera del margen " +
            "(el primero en " + $sucias[0] + "): algo se está saliendo de la tarjeta")
  }
  $bmp.Dispose()
}

# ── 3b · el pie del panel, una vez por vuelta y no una por menú ─────────
# Esto es una comprobación de TEXTO y no de dibujo, porque el bug que previene
# no se ve en un PNG: ArmarMenu llegó a dibujar el pie él mismo, o sea una vez
# por menú, y cada llamada liberaba el bitmap que el menú anterior acababa de
# recibir. Con cuatro íconos quedaban tres PictureBox apuntando a una imagen
# muerta: el renglón salía en blanco y, al repintarse, GDI+ tiraba «Parameter is
# not valid» — medido, 3 imágenes muertas por vuelta contra 0 con el arreglo.
# El dueño del pie es Refrescar; ArmarMenu sólo lo usa.
$cuerpoArmar = (Get-Content $guion -Raw -Encoding UTF8)
$i = $cuerpoArmar.IndexOf('function ArmarMenu(')
$j = $cuerpoArmar.IndexOf("`nfunction ", $i + 10)
if ($i -ge 0 -and $j -gt $i -and $cuerpoArmar.Substring($i, $j - $i) -match 'DibujarPieLectura') {
  Fallar ('ArmarMenu dibuja el pie: tiene que recibirlo hecho. Dibujarlo por menú ' +
          'libera el que recibió el menú anterior y lo deja en blanco.')
}

# ── 4 · un panel por ícono ──────────────────────────────────────────────
# El de una cuenta tiene que ser MÁS CHICO que el general: si son iguales, el
# ícono de la cuenta está abriendo el panel de todas y los cuatro íconos que
# pidió el usuario son cuatro veces la misma pantalla.
$bmp = Capturar $fixture 'teams' 'Oscuro' (Join-Path $salida 'teams.png')
if ($bmp) {
  if ($bmp.Width -ne $ANCHO) { Fallar "el panel de una cuenta salió de $($bmp.Width) px de ancho" }
  if ($altoGeneral -gt 0 -and $bmp.Height -ge $altoGeneral) {
    Fallar ("el panel de 'teams' mide $($bmp.Height) px y el general ${altoGeneral}: " +
            "el ícono de una cuenta está mostrando todas")
  }
  $bmp.Dispose()
}

# Y el tema claro, que es otra tabla de colores y se rompe sola.
$bmp = Capturar $fixture '' 'Claro' (Join-Path $salida 'claro.png')
if ($bmp) {
  $fondo = $bmp.GetPixel(2, 2)
  if ($fondo.R -lt 200) { Fallar "el panel en tema claro salió con fondo oscuro ($fondo)" }
  $bmp.Dispose()
}

# ── 5 · dónde busca a qm ────────────────────────────────────────────────
# La bandeja nació hablándole a WSL y `wsl.exe` estaba escrito a mano en los
# tres lugares que corren qm. Ahora elige entre el qm NATIVO de Windows y el de
# adentro de WSL, y esa elección es la que decide si el usuario ve números o no
# ve nada — o sea, exactamente la clase de cosa que no puede estar sin gate.
#
# No se puede comprobar cargando el archivo: al cargarlo levanta una bandeja y
# se queda en el bucle de mensajes. Así que se sacan las tres funciones por AST
# —no por recorte de texto, que se desincroniza sin avisar— y se corren en un
# scope de mentira con un qm.cmd de mentira. Es lo mismo que hace
# scripts/gate-duraciones.py con la escalera, por la misma razón.
$arbol = [System.Management.Automation.Language.Parser]::ParseFile($guion, [ref]$null, [ref]$null)
$queridas = @('ArgsWsl', 'ResolverQm', 'PsiQm')
$fns = $arbol.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $queridas -contains $n.Name
  }, $true)
if ($fns.Count -ne $queridas.Count) {
  $hay = ($fns | ForEach-Object { $_.Name }) -join ', '
  Fallar "esperaba las funciones $($queridas -join ', ') en bin/qm-tray.ps1 y encontré: $hay"
} else {
  $cuerpo = ($fns | ForEach-Object { $_.Extent.Text }) -join "`n`n"

  # Un bin de mentira CON ESPACIOS en la ruta: es el caso real —el instalador
  # deja todo en «C:\Program Files\quartermaster\bin»— y es el que se rompe si
  # alguien saca un par de comillas.
  $binFalso = Join-Path $salida 'qm gate\bin'
  New-Item -ItemType Directory -Path $binFalso -Force | Out-Null
  Set-Content -Path (Join-Path $binFalso 'qm.cmd') -Value '@echo off' -Encoding ASCII
  Set-Content -Path (Join-Path $binFalso 'qm-web.cmd') -Value '@echo off' -Encoding ASCII

  function Resolver([hashtable]$escenario) {
    $prologo = @"
Set-StrictMode -Version Latest
`$Qm = '$($escenario.Qm)'
`$QmLinux = '$($escenario.QmLinux)'
`$Distro = ''
`$script:PidieronQmLinux = `$$($escenario.PidieronQmLinux)
`$script:MiBin = '$($escenario.MiBin)'
`$script:QmResuelto = `$null
"@
    $epilogo = @'
[pscustomobject]@{ R = (ResolverQm); Psi = (PsiQm '--json --breve'); Web = (PsiQm '--sin-abrir' 'web') }
'@
    return & ([scriptblock]::Create("$prologo`n$cuerpo`n$epilogo"))
  }

  # a · nativo: el qm.cmd que está al lado gana, y la ruta con espacios viaja
  #     entera hasta la línea de comandos.
  $a = Resolver @{ Qm = ''; QmLinux = 'qm'; PidieronQmLinux = 'false'; MiBin = $binFalso }
  if ($a.R.Modo -ne 'nativo') {
    Fallar "con un qm.cmd al lado la bandeja tiene que ir por Windows nativo y eligió '$($a.R.Modo)'"
  } else {
    $esperado = '/d /s /c ""' + (Join-Path $binFalso 'qm.cmd') + '" --json --breve"'
    if ($a.Psi.Arguments -ne $esperado) {
      Fallar "la línea nativa quedó mal citada.`n  esperaba: $esperado`n  salió:    $($a.Psi.Arguments)"
    }
    if ($a.Web.Arguments -notmatch [regex]::Escape('qm-web.cmd')) {
      Fallar "el tablero nativo no resolvió a qm-web.cmd: $($a.Web.Arguments)"
    }
  }

  # b · WSL: pedir -QmLinux es pedir WSL, aunque haya un qm.cmd al lado. Es lo
  #     que hace bin/qm-tray, y romperlo deja sin bandeja a quien ya la tenía.
  $b = Resolver @{ Qm = ''; QmLinux = 'qm'; PidieronQmLinux = 'true'; MiBin = $binFalso }
  if ($b.R.Modo -ne 'wsl') { Fallar "con -QmLinux explícito el modo tiene que ser wsl y fue '$($b.R.Modo)'" }
  elseif ($b.Psi.FileName -ne 'wsl.exe') { Fallar "el modo wsl no arranca wsl.exe sino '$($b.Psi.FileName)'" }
  elseif ($b.Psi.Arguments -ne '-e bash -lc "qm --json --breve"') {
    Fallar "la línea de WSL cambió: $($b.Psi.Arguments)"
  }

  # c · silencio es el bug: un -Qm que no existe tiene que dar una FRASE, no un
  #     PsiQm nulo que después dibuje un panel vacío sin explicar nada.
  $c = Resolver @{ Qm = 'Z:\no\existe\qm.cmd'; QmLinux = 'qm'; PidieronQmLinux = 'false'; MiBin = $binFalso }
  if ($c.R.Modo -ne 'ninguno') { Fallar "un -Qm inexistente no puede resolver a '$($c.R.Modo)'" }
  elseif (-not $c.R.Motivo) { Fallar 'un -Qm inexistente se quedó sin frase: eso es el silencio que el repo no acepta' }
  elseif ($null -ne $c.Psi) { Fallar 'sin qm, PsiQm tiene que devolver $null para que Leer conteste la frase' }
}

Remove-Item $salida -Recurse -Force -ErrorAction SilentlyContinue

if ($fallas.Count) {
  foreach ($f in $fallas) { [Console]::Error.WriteLine("GATE ROJO: $f") }
  exit 1
}
Write-Host "gate de la bandeja: verde — parsea, dibuja $ANCHO px en los dos temas, nada se sale del margen, el panel de una cuenta no es el de todas, y resuelve qm nativo / WSL / frase"
exit 0
