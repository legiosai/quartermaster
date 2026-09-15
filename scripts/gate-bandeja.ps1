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
# El ancho del DIBUJO. El lienzo sale más ancho que esto: el panel se corre a la
# derecha para compensar que un ToolStripDropDownMenu reserva 8 px de hueco a la
# izquierda y 28 a la derecha, y el desplazo se mide en tiempo de ejecución (ver
# `Desplazo` en bin/qm-tray.ps1). Así que acá NO se compara contra un número
# fijo: se mide el mismo hueco y se comprueba la invariante que importa, que es
# que la tarjeta quede centrada EN PANTALLA.
$ANCHO = 340

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function HuecosDelMenu {
  $mn = New-Object System.Windows.Forms.ContextMenuStrip
  $mn.ShowImageMargin = $false
  $mn.ShowCheckMargin = $false
  $sonda = New-Object System.Drawing.Bitmap($ANCHO, 10)
  $pb = New-Object System.Windows.Forms.PictureBox
  $pb.Image = $sonda; $pb.Size = $sonda.Size
  $pb.Margin = New-Object System.Windows.Forms.Padding(0)
  $fila = New-Object System.Windows.Forms.ToolStripControlHost($pb)
  $fila.AutoSize = $false; $fila.Size = $sonda.Size
  $fila.Margin = New-Object System.Windows.Forms.Padding(0)
  $fila.Padding = New-Object System.Windows.Forms.Padding(0)
  $mn.Items.Add($fila) | Out-Null
  $mn.PerformLayout()
  $izq = $fila.Bounds.X
  $der = $mn.ClientSize.Width - $izq - $ANCHO
  $mn.Dispose(); $pb.Dispose(); $sonda.Dispose()
  return @{ izq = $izq; der = $der }
}
$HUECO = HuecosDelMenu
$ANCHO_LIENZO = $ANCHO + [math]::Max(0, $HUECO.der - $HUECO.izq)

$bmp = Capturar $fixture '' 'Oscuro' (Join-Path $salida 'general.png')
if ($bmp) {
  if ($bmp.Width -ne $ANCHO_LIENZO) { Fallar "el panel general salió de $($bmp.Width) px de ancho y tiene que ser $ANCHO_LIENZO" }
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
# La franja que se vigila es el PADDING de la tarjeta: desde adentro de su borde
# hasta donde arranca el contenido. Antes era el margen del panel y la regla era
# «acá todo tiene que ser del color del fondo», que funcionaba cuando cada
# cuenta se dibujaba plana. Con la cuenta adentro de una tarjeta redondeada, ese
# margen lo ocupa legítimamente la tarjeta, y la regla vieja marcaba 3935
# píxeles buenos.
#
# La regla nueva dice lo mismo con lo que hay ahora: en el padding sólo puede
# haber gris de tarjeta. Medido en el tema oscuro, los tres grises que
# corresponden son el fondo del panel (43), el de la tarjeta (56) y su borde
# (68); el texto más tenue del panel es 133 y las barras son de color. Así que
# un tope de fondo+30 y la exigencia de que el píxel sea NEUTRO separan «esto es
# la tarjeta» de «esto se salió», que es el bug que el fixture de nombres largos
# existe para provocar.
$bmp = Capturar $largos '' 'Oscuro' (Join-Path $salida 'largos.png')
if ($bmp) {
  $fondo = $bmp.GetPixel(2, 2)
  $tope = $fondo.R + 30

  # a · AFUERA de la tarjeta no puede haber nada. La tarjeta va de 6 a 333 y su
  #     antialias muere en 334, así que de 336 para afuera es fondo del panel y
  #     punto. Es la pregunta original —«¿esto se salió?»— hecha contra el borde
  #     que hoy existe.
  $afuera = @()
  foreach ($y in 0..($bmp.Height - 1)) {
    foreach ($x in @(0..4) + @(($bmp.Width - 4)..($bmp.Width - 1))) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -ne $fondo.R -or $c.G -ne $fondo.G -or $c.B -ne $fondo.B) { $afuera += "$x,$y" }
    }
  }
  if ($afuera.Count) {
    Fallar ("con nombres largos hay $($afuera.Count) píxeles dibujados FUERA de la tarjeta " +
            "(el primero en " + $afuera[0] + "): se salió del panel")
  }

  # b · Y en el PADDING —entre el borde de la tarjeta y donde arranca el
  #     contenido— sólo puede haber gris de tarjeta. Medido en oscuro: fondo 43,
  #     tarjeta 56, borde 68; el texto más tenue del panel es 133 y las barras
  #     son de color, así que un tope de fondo+30 y exigir que el píxel sea
  #     NEUTRO alcanzan para distinguirlos.
  #
  #     Los bordes de la tarjeta se BUSCAN en la imagen en vez de escribirlos
  #     acá: el dibujo se corre a la derecha una cantidad que se mide en
  #     tiempo de ejecución (ver `Desplazo` en bin/qm-tray.ps1), así que unos
  #     números fijos dejarían de apuntar al padding sin que nada avise.
  #
  #     A la derecha la franja termina 9 px antes del borde y no 2 por el punto
  #     con que termina la curva: está centrado en el último dato, que cae justo
  #     en el margen del contenido, y su radio lo lleva 3 px más allá. Sobresale
  #     del margen y NO de la tarjeta —le quedan 5 px hasta el borde—, así que
  #     es dibujo bueno.
  $medio = [int]($bmp.Height / 2)
  $bIzq = 0
  while ($bIzq -lt $bmp.Width - 1) {
    $c = $bmp.GetPixel($bIzq, $medio)
    if ($c.R -ne $fondo.R -or $c.G -ne $fondo.G -or $c.B -ne $fondo.B) { break }
    $bIzq++
  }
  $bDer = $bmp.Width - 1
  while ($bDer -gt 0) {
    $c = $bmp.GetPixel($bDer, $medio)
    if ($c.R -ne $fondo.R -or $c.G -ne $fondo.G -or $c.B -ne $fondo.B) { break }
    $bDer--
  }
  if ($bDer - $bIzq -lt 200) {
    Fallar "no encontré la tarjeta en la captura (bordes en $bIzq y $bDer): ¿se dejó de dibujar?"
  }
  # El CENTRADO, que es lo que se reportó: la tarjeta estaba corrida a la
  # izquierda porque el dibujo estaba centrado en su lienzo y el lienzo no
  # estaba centrado en el menú. Con los huecos medidos, los dos aires en
  # pantalla tienen que dar lo mismo.
  $aireIzq = $HUECO.izq + $bIzq
  $aireDer = $HUECO.der + ($bmp.Width - 1 - $bDer)
  if ([math]::Abs($aireIzq - $aireDer) -gt 1) {
    Fallar ("la tarjeta queda descentrada en el menú: $aireIzq px de aire a la izquierda " +
            "y $aireDer a la derecha")
  }

  $padding = @()
  foreach ($y in 0..($bmp.Height - 1)) {
    foreach ($x in @(($bIzq + 2)..($bIzq + 7)) + @(($bDer - 4)..($bDer - 1))) {
      $c = $bmp.GetPixel($x, $y)
      $max = [math]::Max($c.R, [math]::Max($c.G, $c.B))
      $min = [math]::Min($c.R, [math]::Min($c.G, $c.B))
      if ($max -gt $tope -or ($max - $min) -gt 12) { $padding += "$x,$y" }
    }
  }
  if ($padding.Count) {
    Fallar ("con nombres largos hay $($padding.Count) píxeles dibujados en el padding de la " +
            "tarjeta (el primero en " + $padding[0] + "): algo se está saliendo del contenido")
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
  if ($bmp.Width -ne $ANCHO_LIENZO) { Fallar "el panel de una cuenta salió de $($bmp.Width) px de ancho" }
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
$queridas = @('TzIana', 'ArgsWsl', 'ResolverQm', 'PsiQm')
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
  # La zona va adelante del comando: sin ella WSL corre en UTC y el día del
  # presupuesto no es el del reloj de la pantalla.
  elseif ($b.Psi.Arguments -notmatch '^-e bash -lc "TZ=''([A-Za-z_]+/[A-Za-z0-9_+\-/]+|UTC)'' qm --json --breve"$') {
    Fallar "la línea de WSL cambió: $($b.Psi.Arguments)"
  }

  # c · silencio es el bug: un -Qm que no existe tiene que dar una FRASE, no un
  #     PsiQm nulo que después dibuje un panel vacío sin explicar nada.
  $c = Resolver @{ Qm = 'Z:\no\existe\qm.cmd'; QmLinux = 'qm'; PidieronQmLinux = 'false'; MiBin = $binFalso }
  if ($c.R.Modo -ne 'ninguno') { Fallar "un -Qm inexistente no puede resolver a '$($c.R.Modo)'" }
  elseif (-not $c.R.Motivo) { Fallar 'un -Qm inexistente se quedó sin frase: eso es el silencio que el repo no acepta' }
  elseif ($null -ne $c.Psi) { Fallar 'sin qm, PsiQm tiene que devolver $null para que Leer conteste la frase' }
}

# ── 6 · que el menú no se cierre al tildar un ícono ─────────────────────
# Reportado a mano dos veces. La primera se «arregló» con un par de handlers en
# el ContextMenuStrip —prender una bandera en ItemClicked, cancelar en Closing—
# y siguió pasando, porque ese par sirve para un hijo DIRECTO del menú y cada
# tilde de «Íconos en la bandeja» es un NIETO. Medido, el orden real al
# clickear un tilde es:
#
#     SUB.Closing     reason=ItemClicked
#     padre.Closing   reason=AppFocusChange
#     item.Click      <- la bandera se prendía acá, tarde
#
# Las dos mitades fallaban: la bandera llegaba después del Closing del padre, y
# el padre ni siquiera ve ItemClicked. Un arreglo que no se puede comprobar es
# cómo se llega a arreglar lo mismo dos veces, así que acá está el gate.
#
# Se sacan los tres handlers por AST y se los corre contra un menú de verdad con
# la FORMA real —ContextMenuStrip · «⋯» · «Íconos» · los tildes—, porque cargar
# el archivo entero levanta una bandeja. Tres niveles no es un detalle: es la
# razón por la que el primer arreglo no podía andar.
$queridos = @('$script:AlCerrarSub', '$script:AlCerrarMas', '$script:AlClickearMas')
$hs = @{}
foreach ($n in $queridos) {
  $a = $arbol.FindAll({
      param($x)
      $x -is [System.Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq $n
    }.GetNewClosure(), $true)
  if ($a.Count -eq 1) { $hs[$n] = $a[0].Right.Extent.Text }
}
if ($hs.Count -ne $queridos.Count) {
  $faltan = @($queridos | Where-Object { -not $hs.ContainsKey($_) }) -join ', '
  Fallar "faltan handlers en bin/qm-tray.ps1 ($faltan): sin ellos, tocar el menú lo cierra"
} else {
  Add-Type -AssemblyName System.Windows.Forms
  $ETIQUETA_ACTUALIZAR = 'Actualizar ahora'
  $script:MantenerAbierto = $false
  $script:MasAbierto = $false
  $script:SubIconosAbierto = $false
  $hSub = & ([scriptblock]::Create($hs['$script:AlCerrarSub']))
  $hCerrarMas = & ([scriptblock]::Create($hs['$script:AlCerrarMas']))
  $hClickMas = & ([scriptblock]::Create($hs['$script:AlClickearMas']))

  $f = New-Object System.Windows.Forms.Form
  $f.Show(); $f.Visible = $false
  $mn = New-Object System.Windows.Forms.ContextMenuStrip
  $mas = New-Object System.Windows.Forms.ToolStripMenuItem([string][char]0x22EF)
  $mas.DropDown.Add_ItemClicked($hClickMas)
  $mas.DropDown.Add_Closing($hCerrarMas)
  $ico = New-Object System.Windows.Forms.ToolStripMenuItem('Íconos en la bandeja')
  $ico.DropDown.Add_Closing($hSub)
  foreach ($k in @('general', 'main', 'glm')) {
    $ico.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripMenuItem($k))) | Out-Null
  }
  $mas.DropDownItems.Add($ico) | Out-Null
  foreach ($t in @($ETIQUETA_ACTUALIZAR, 'Abrir tablero', 'Salir')) {
    $mas.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripMenuItem($t))) | Out-Null
  }
  $mn.Items.Add($mas) | Out-Null

  $mn.Show(100, 100)
  $mas.ShowDropDown(); $ico.ShowDropDown()
  # Tres tildes seguidos, que es la tarea: elegir qué íconos querés no es tocar
  # uno, es tocar varios mirando cómo queda la bandeja.
  foreach ($i in 0..2) {
    $ico.DropDownItems[$i].PerformClick()
    [System.Windows.Forms.Application]::DoEvents()
    if (-not $mn.Visible) { Fallar "el panel se cerró al tildar el ícono #$($i + 1): es el bug reportado dos veces" ; break }
    if (-not $ico.DropDown.Visible) { Fallar "el submenú de íconos se cerró al tildar el #$($i + 1): hay que volver a entrar una vez por tilde" ; break }
  }
  # «Actualizar ahora» refresca lo que estás mirando: cerrarlo obligaría a
  # reabrir el panel para ver el resultado.
  if ($mn.Visible) {
    $mas.DropDownItems[1].PerformClick()
    [System.Windows.Forms.Application]::DoEvents()
    if (-not $mn.Visible) { Fallar '«Actualizar ahora» cerró el panel: el número nuevo queda sin verse' }
  }
  # Y lo que TIENE que cerrar, que es la otra mitad: cancelar de más deja un
  # panel que no se va nunca.
  if ($mn.Visible) {
    $mas.DropDownItems[3].PerformClick()
    [System.Windows.Forms.Application]::DoEvents()
    if ($mn.Visible) { Fallar '«Salir» ya no cierra el panel: se cancela de más' }
  }
  $mn.Dispose(); $f.Dispose()
}

# Y que el submenú se reabra DESPUÉS del layout, que es de lo que salió el
# segundo reporte: se reabría bien pero en la esquina de arriba a la izquierda
# de la pantalla, suelto. Un ToolStripMenuItem recién agregado todavía no tiene
# posición y `ShowDropDown()` la usa para ubicarse. Medido con el panel abierto
# en {X=600,Y=400}: llamándolo antes del layout el item mide {0,0,32,19} y el
# desplegable sale en {0,0}; después de PerformLayout() mide {0,24,163,22} y
# sale en {763,424}. Es una cuestión de ORDEN dentro de ArmarMenu, así que se
# comprueba el orden.
$armar = $arbol.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'ArmarMenu'
  }, $true)
if ($armar.Count -ne 1) {
  Fallar "esperaba una función ArmarMenu en bin/qm-tray.ps1 y encontré $($armar.Count)"
} else {
  $cuerpoArmar = $armar[0].Extent.Text
  $iLayout = $cuerpoArmar.IndexOf('PerformLayout()')
  $iAbrir = $cuerpoArmar.IndexOf('.ShowDropDown()')
  if ($iAbrir -lt 0) {
    Fallar 'ArmarMenu ya no reabre el submenú de íconos: tildar uno obliga a volver a entrar una vez por tilde'
  } elseif ($iLayout -lt 0) {
    Fallar 'ArmarMenu ya no llama PerformLayout(): no se puede comprobar el orden del que depende dónde sale el submenú'
  } elseif ($iAbrir -lt $iLayout) {
    Fallar 'ArmarMenu abre el submenú ANTES de PerformLayout(): sale en la esquina {0,0} de la pantalla, suelto del panel'
  }
}

Remove-Item $salida -Recurse -Force -ErrorAction SilentlyContinue

if ($fallas.Count) {
  foreach ($f in $fallas) { [Console]::Error.WriteLine("GATE ROJO: $f") }
  exit 1
}
Write-Host "gate de la bandeja: verde — parsea, dibuja $ANCHO px centrados en los dos temas, nada se sale del margen, el panel de una cuenta no es el de todas, resuelve qm nativo / WSL / frase, y tildar íconos no cierra el panel"
exit 0
