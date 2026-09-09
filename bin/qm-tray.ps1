<#
qm en el área de notificación de Windows.

Es la contraparte de `bin/qm-barra` (macOS) y `bin/qm-indicator` (GNOME) para
Windows: misma regla que las otras dos, SÓLO DIBUJA. Le pide el JSON a `qm` y
no sabe qué es una credencial, un llavero ni un endpoint. La regla de cuál
barra manda —la que evita que un 75 % con aviso quede tapado por un 8 % que se
ve más lindo— vive una sola vez, en src/core/tipos.ts, y llega acá resuelta en
`mostrar`, `frena`, `sesion` y `semanal`. Acá no se reimplementa.

El menú es el mismo dibujo que `VistaCuenta` en bin/qm-barra.swift: cabecera con
el glifo del producto, medidores redondeados con la paleta de estado, pie con el
reinicio y la edad del cache. En WinForms no se puede pintar un item de menú sin
subclasear, así que cada perfil se dibuja a un Bitmap y el Bitmap se mete en el
menú dentro de un PictureBox. El efecto es el mismo; el camino, no.

Tres cosas que Windows hace distinto y conviene saber antes de leer el código:

  · La bandeja no tiene etiqueta de texto. La barra de menú de macOS muestra
    "codex ~16%" al lado del ícono; acá un item es un cuadradito de 16x16 y
    nada más. Así que el número se DIBUJA ADENTRO del ícono (como los medidores
    de batería), y el detalle va al tooltip y al menú.

  · No hay FileMonitor. El indicador de GNOME se entera en el acto porque vigila
    cada .claude.json con Gio.FileMonitor; desde Windows esos archivos están del
    otro lado del 9P de WSL, donde FileSystemWatcher no es confiable. Acá el
    sondeo es el mecanismo principal, no la red de seguridad.

  · El calentado no puede bloquear. En macOS el refresco del endpoint va en una
    cola aparte; acá el timer corre en el hilo de la interfaz, así que
    `--calentar` se dispara y se suelta: el número que trae lo levanta el tick
    siguiente. Un menú congelado veinte segundos es peor que un número que
    llega medio minuto tarde.
#>

[CmdletBinding()]
param(
  # Ruta de `qm` ADENTRO de WSL. Por defecto se resuelve por PATH en un shell
  # de login, que es donde vive ~/.local/bin.
  [string]$QmLinux = 'qm',
  # Distro de WSL. Vacío = la default.
  [string]$Distro = '',
  # Cada cuánto se redibuja. El calentado tiene su propia cadencia, más abajo.
  [int]$Segundos = 30,
  [int]$Puerto = 7391,
  # Con esto no se le pide nada al endpoint: sólo se lee lo que haya en disco.
  [switch]$SinCalentar
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr handle);
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@ -Name Nativo -Namespace Qm

# Sin esto Windows estira el mapa de bits del menú y todo sale borroso.
try { [Qm.Nativo]::SetProcessDPIAware() | Out-Null } catch { }

$UMBRALES = @(80, 95)
# Cada cuánto se le pide el número al endpoint. Son los mismos de qm-barra.swift.
$SEGUNDOS_SONDEO = 300
$MINIMO_RED = 60
$VIEJO_SEGUNDOS = 6 * 3600

# ── la paleta ───────────────────────────────────────────────────────────
# La misma del tablero y de la barra de macOS. El color va en la MARCA, nunca
# en el texto: el número se queda con el color de etiqueta del sistema, que se
# adapta solo al tema claro u oscuro.

$PALETA = @{
  ok      = [System.Drawing.Color]::FromArgb(12, 163, 12)   # #0ca30c
  atento  = [System.Drawing.Color]::FromArgb(250, 178, 25)  # #fab219
  aviso   = [System.Drawing.Color]::FromArgb(236, 131, 90)  # #ec835a
  critico = [System.Drawing.Color]::FromArgb(208, 59, 59)   # #d03b3b
}

function NivelDe([int]$pct, [bool]$preocupa) {
  if ($pct -ge 95) { return 'critico' }
  if ($preocupa -or $pct -ge 80) { return 'aviso' }
  if ($pct -ge 60) { return 'atento' }
  return 'ok'
}

# Deliberadamente lejos de la paleta de estado: verde, ámbar y rojo están
# reservados y no pueden significar además «esta es la cuenta 2».
$COLOR_CUENTA = @(
  [System.Drawing.Color]::FromArgb(42, 120, 214),   # #2a78d6
  [System.Drawing.Color]::FromArgb(74, 58, 167),    # #4a3aa7
  [System.Drawing.Color]::FromArgb(232, 123, 164)   # #e87ba4
)

# El equivalente de labelColor / secondaryLabelColor / tertiaryLabelColor: se
# sacan del tema del sistema mezclando el color de texto con el del fondo, así
# que el menú queda bien en claro y en oscuro sin preguntarle nada al registro.
$script:Fondo = [System.Drawing.SystemColors]::Menu
$script:Tinta = [System.Drawing.SystemColors]::MenuText

function Mezclar($a, $b, [double]$t) {
  [System.Drawing.Color]::FromArgb(
    [int]($a.R + ($b.R - $a.R) * $t),
    [int]($a.G + ($b.G - $a.G) * $t),
    [int]($a.B + ($b.B - $a.B) * $t))
}
$script:Tinta2 = Mezclar $script:Tinta $script:Fondo 0.38
$script:Tinta3 = Mezclar $script:Tinta $script:Fondo 0.58
$script:Pista  = Mezclar $script:Fondo $script:Tinta 0.14

# ── formato ─────────────────────────────────────────────────────────────

function Corto([string]$nombre) {
  $n = $nombre
  if ($n.StartsWith('.claude')) { $n = $n.Substring(7) }
  $n = $n.TrimStart('-')
  if ($n -eq '') { return 'main' }
  return $n
}

function Dur([int]$segundos) {
  # La misma escalera que duracion() en qm-barra.swift, incluidos los días: sin
  # ellos un reinicio semanal se lee "168h00m", que no es una duración, es una
  # cuenta de horas.
  if ($segundos -lt 0) { return 'ya' }
  if ($segundos -lt 60) { return "${segundos}s" }
  if ($segundos -lt 3600) { return "$([int][math]::Floor($segundos / 60))m" }
  $h = [int][math]::Floor($segundos / 3600)
  $m = [int][math]::Floor(($segundos % 3600) / 60)
  if ($h -lt 24) { if ($m -eq 0) { return "${h}h" } else { return "${h}h${m}m" } }
  return "$([int][math]::Floor($h / 24))d$($h % 24)h"
}

function Faltan($iso) {
  if (-not $iso) { return $null }
  try { $cuando = [datetimeoffset]::Parse($iso) } catch { return $null }
  return [int]($cuando - [datetimeoffset]::UtcNow).TotalSeconds
}

function AlMinuto($iso) {
  # Clave estable para no repetir avisos: el servidor manda microsegundos y no
  # siempre los mismos entre lecturas, así que con el valor crudo cada jitter
  # estrena clave y vuelve a notificar lo mismo.
  if (-not $iso) { return 'sin-reinicio' }
  try { return ([datetimeoffset]::Parse($iso)).ToString('yyyy-MM-ddTHH:mm') } catch { return $iso }
}

function NombreVentana($v) {
  if ($v.nombre) { return $v.nombre }
  if ($v.alcance) { return "$($v.clave) ($($v.alcance))" }
  return $v.clave
}

function FraseRitmo($p) {
  # La misma distinción que hace qm: "no sé" no es "no".
  if (-not $p) { return $null }
  if ($p.estado -eq 'sube') {
    $seg = Faltan $p.techo
    if ($null -eq $seg) { $seg = 0 }
    $cuando = ('{0:n1} pts/h · 100 % en {1}' -f $p.ritmoPuntosPorHora, (Dur $seg))
    if ($p.chocasAntesDelReinicio) { return "$cuando — antes del reinicio" }
    return "$cuando — después del reinicio"
  }
  if ($p.estado -eq 'plano') { return 'no sube' }
  return "todavía no sé el ritmo: $($p.motivo)"
}

# ── avisos ──────────────────────────────────────────────────────────────
# La clave incluye el instante de reinicio: cuando la ventana se reinicia la
# clave cambia sola y el mismo umbral puede volver a avisar. Sin eso, o
# spameás cada minuto o avisás una sola vez en la vida.

$script:RutaAvisos = Join-Path $env:LOCALAPPDATA 'quartermaster\avisados.json'
$script:Vistos = @{}
try {
  if (Test-Path $script:RutaAvisos) {
    foreach ($k in (Get-Content $script:RutaAvisos -Raw -Encoding UTF8 | ConvertFrom-Json)) {
      $script:Vistos[$k] = $true
    }
  }
} catch { $script:Vistos = @{} }   # sin memoria se avisa de más, no de menos

function Avisar([string]$clave, [string]$titulo, [string]$cuerpo, [bool]$urgente) {
  if ($script:Vistos.ContainsKey($clave)) { return }
  $script:Vistos[$clave] = $true
  try {
    $dir = Split-Path $script:RutaAvisos -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    ($script:Vistos.Keys | Sort-Object) | ConvertTo-Json | Set-Content $script:RutaAvisos -Encoding UTF8
  } catch { }
  $ico = if ($urgente) { [System.Windows.Forms.ToolTipIcon]::Error } else { [System.Windows.Forms.ToolTipIcon]::Warning }
  try { $script:Ni.ShowBalloonTip(($(if ($urgente) { 30000 } else { 10000 })), $titulo, $cuerpo, $ico) } catch { }
}

# ── dibujo ──────────────────────────────────────────────────────────────
# Las medidas están en píxeles lógicos (los mismos números que la vista de
# macOS) y se escalan por DPI al crear las fuentes. Si una constante de acá no
# coincide con lo que dibuja DibujarPerfil, los renglones se pisan — que es
# exactamente lo que le pasó a la versión de macOS y por eso lo dice ahí.

$script:Escala = 1.0
$ANCHO_VISTA = 340
$MARGEN = 15
$ALTO_CABECERA = 17 + 14 + 8   # título + subtítulo + aire
$ALTO_BARRA = 15 + 3 + 5 + 4 + 12 + 7
$ALTO_RITMO = 16
$ALTO_FRASE = 30

function Px([double]$v) { return [float]($v * $script:Escala) }

function CrearFuentes {
  $f = { param($px, $estilo) New-Object System.Drawing.Font('Segoe UI', (Px $px), $estilo, [System.Drawing.GraphicsUnit]::Pixel) }
  $script:FTitulo = & $f 14 ([System.Drawing.FontStyle]::Bold)
  $script:FSub    = & $f 11 ([System.Drawing.FontStyle]::Regular)
  $script:FNombre = & $f 12 ([System.Drawing.FontStyle]::Regular)
  $script:FActiva = & $f 12 ([System.Drawing.FontStyle]::Bold)
  $script:FPct    = & $f 12 ([System.Drawing.FontStyle]::Bold)
  $script:FPie    = & $f 10 ([System.Drawing.FontStyle]::Regular)
  $script:FFrase  = & $f 11 ([System.Drawing.FontStyle]::Regular)
}

function RectRedondeado($g, $rect, [float]$r, $brocha) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $p.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $p.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $p.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brocha, $p)
  $p.Dispose()
}

function Escribir($g, [string]$t, [float]$x, [float]$y, $fuente, $color, [float]$derecha = -1) {
  if (-not $t) { return }
  $br = New-Object System.Drawing.SolidBrush($color)
  if ($derecha -ge 0) {
    $an = $g.MeasureString($t, $fuente).Width
    $x = $derecha - $an
  }
  $g.DrawString($t, $fuente, $br, $x, $y)
  $br.Dispose()
}

# La marca de cada producto, dibujada: no hay ícono de sistema ni para Claude ni
# para Codex. El asterisco es la forma de la de Claude; los chevrones, código.
function GlifoProducto($g, [string]$producto, $color, [float]$x, [float]$y, [float]$lado) {
  $lapiz = New-Object System.Drawing.Pen($color, (Px 1.3))
  $lapiz.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $lapiz.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cx = $x + $lado / 2; $cy = $y + $lado / 2
  if ($producto -eq 'codex') {
    # Los chevrones necesitan aire en el medio: pegados se fusionan y el glifo
    # se lee como una «o».
    $a = $lado * 0.30; $hueco = $lado * 0.20
    $g.DrawLines($lapiz, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF(($cx - $hueco), ($cy - $a))),
        (New-Object System.Drawing.PointF(($cx - $hueco - $a * 0.85), $cy)),
        (New-Object System.Drawing.PointF(($cx - $hueco), ($cy + $a)))))
    $g.DrawLines($lapiz, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF(($cx + $hueco), ($cy - $a))),
        (New-Object System.Drawing.PointF(($cx + $hueco + $a * 0.85), $cy)),
        (New-Object System.Drawing.PointF(($cx + $hueco), ($cy + $a)))))
  } elseif ($producto -eq 'opencode' -or $producto -eq 'zai') {
    $r0 = $lado * 0.34
    $g.DrawPolygon($lapiz, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF($cx, ($cy - $r0))),
        (New-Object System.Drawing.PointF(($cx + $r0), $cy)),
        (New-Object System.Drawing.PointF($cx, ($cy + $r0))),
        (New-Object System.Drawing.PointF(($cx - $r0), $cy))))
  } else {
    $r0 = $lado * 0.36
    foreach ($k in 0..2) {
      $ang = $k * [math]::PI / 3
      $g.DrawLine($lapiz,
        [float]($cx + $r0 * [math]::Cos($ang)), [float]($cy + $r0 * [math]::Sin($ang)),
        [float]($cx - $r0 * [math]::Cos($ang)), [float]($cy - $r0 * [math]::Sin($ang)))
    }
  }
  $lapiz.Dispose()
}

function AltoPerfil($p) {
  $alto = (Px $MARGEN) + (Px $ALTO_CABECERA)
  $cuota = $p.cuota
  if ($cuota.estado -ne 'ok') {
    $alto += (Px $ALTO_FRASE)
  } else {
    $alto += (Px $ALTO_BARRA) * (@($cuota.mostrar)).Count
    if (FraseRitmo $p.proyeccion) { $alto += (Px $ALTO_RITMO) }
  }
  return [int]($alto + (Px 10))
}

function DibujarPerfil($p, [int]$indice) {
  $ancho = [int](Px $ANCHO_VISTA)
  $alto = AltoPerfil $p
  $bmp = New-Object System.Drawing.Bitmap($ancho, $alto)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($script:Fondo)

  $m = Px $MARGEN
  $der = $ancho - $m
  $y = Px $MARGEN

  $colorCuenta = $COLOR_CUENTA[$indice % $COLOR_CUENTA.Count]
  GlifoProducto $g $p.producto $colorCuenta $m ($y + (Px 2)) (Px 13)
  Escribir $g (Corto $p.perfil) ($m + (Px 19)) $y $script:FTitulo $script:Tinta
  $y += Px 17

  $partes = @()
  if ($p.cuenta) { $partes += $p.cuenta }
  if ($p.plan) { $partes += $p.plan }
  Escribir $g ($partes -join '  ·  ') ($m + (Px 19)) $y $script:FSub $script:Tinta3
  $y += Px 22

  $cuota = $p.cuota
  if ($cuota.estado -ne 'ok') {
    # Silencio es el bug: si no hay número, hay una frase.
    $frase = if ($cuota.PSObject.Properties['frase']) { $cuota.frase } else { 'sin cuota' }
    $caja = New-Object System.Drawing.RectangleF($m, $y, ($der - $m), (Px ($ALTO_FRASE + 4)))
    $br = New-Object System.Drawing.SolidBrush($script:Tinta2)
    $g.DrawString($frase, $script:FFrase, $br, $caja)
    $br.Dispose(); $g.Dispose()
    return $bmp
  }

  $peor = $cuota.frena
  $chocas = [bool]($p.proyeccion -and $p.proyeccion.estado -eq 'sube' -and $p.proyeccion.chocasAntesDelReinicio)

  foreach ($v in @($cuota.mostrar)) {
    $esPeor = ($null -ne $peor -and $v.clave -eq $peor.clave -and $v.alcance -eq $peor.alcance)
    $nivel = NivelDe ([int]$v.porcentaje) ([bool]($v.preocupa -or ($chocas -and $esPeor)))
    $activa = [bool]$v.activa

    $nombre = if ($activa) { (NombreVentana $v) + '  ▸' } else { NombreVentana $v }
    Escribir $g $nombre $m $y $(if ($activa) { $script:FActiva } else { $script:FNombre }) `
      $(if ($activa) { $script:Tinta } else { $script:Tinta2 })
    Escribir $g ('{0:d}%' -f [int][math]::Round($v.porcentaje)) 0 $y $script:FPct $script:Tinta $der
    $y += Px 18

    # El medidor: pista tenue y relleno con el color del estado.
    $h = Px 5
    $brPista = New-Object System.Drawing.SolidBrush($script:Pista)
    RectRedondeado $g (New-Object System.Drawing.RectangleF($m, $y, ($der - $m), $h)) ($h / 2) $brPista
    $brPista.Dispose()
    $frac = [math]::Max(0, [math]::Min(100, $v.porcentaje)) / 100
    $anchoLleno = [math]::Max((Px 5), ($der - $m) * $frac)
    $brLleno = New-Object System.Drawing.SolidBrush($PALETA[$nivel])
    RectRedondeado $g (New-Object System.Drawing.RectangleF($m, $y, $anchoLleno, $h)) ($h / 2) $brLleno
    $brLleno.Dispose()
    $y += Px 9

    $pie = ''
    $seg = Faltan $v.reinicia
    if ($null -ne $seg) { $pie = "reinicia en $(Dur $seg)" }
    if ($esPeor -and $cuota.PSObject.Properties['edadSegundos']) {
      $e = [int]$cuota.edadSegundos
      if ($pie) { $pie += '   ·   ' }
      $pie += "cache de hace $(Dur $e)"
      if ($e -ge $VIEJO_SEGUNDOS) { $pie += ' · viejo' }
    }
    Escribir $g $pie $m $y $script:FPie $script:Tinta3
    $y += Px 19
  }

  $ritmo = FraseRitmo $p.proyeccion
  if ($ritmo) {
    Escribir $g $ritmo $m $y $script:FPie $(if ($chocas) { $PALETA['critico'] } else { $script:Tinta3 })
  }

  $g.Dispose()
  return $bmp
}

# ── el ícono de la bandeja ──────────────────────────────────────────────
# Un anillo, no un número.
#
# La primera versión dibujaba el porcentaje adentro del ícono, como los
# medidores de batería. Se renderizó a 16x16 —el tamaño real de la bandeja a
# 96 dpi— y se miró: un dígito se lee, dos son una mancha. Así que el número se
# va al tooltip y al menú, y el ícono hace lo que la barra de macOS ya hacía en
# su lugar: un MEDIDOR. El arco dice cuánto va y el color dice cuánto importa,
# y las dos cosas sobreviven a 16 píxeles.
#
# La pista es gris al 41 % de alfa a propósito: la barra de tareas puede ser
# clara u oscura y el ícono no se entera, así que un gris translúcido es lo
# único que se ve en las dos.

function HacerIcono([double]$pct, [string]$nivel) {
  $lado = 32
  $grosor = 8.0
  $bmp = New-Object System.Drawing.Bitmap($lado, $lado)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $m = $grosor / 2 + 0.5
  $caja = New-Object System.Drawing.RectangleF($m, $m, ($lado - 2 * $m), ($lado - 2 * $m))
  $lapPista = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(105, 128, 128, 128), $grosor)
  $g.DrawEllipse($lapPista, $caja)

  $lap = New-Object System.Drawing.Pen($PALETA[$nivel], $grosor)
  $lap.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $lap.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  # Un mínimo de arco: a 1 % un barrido exacto no dibuja nada, y "no dibuja
  # nada" se lee igual que "no hay datos", que es justo lo que no es.
  $barrido = [float]([math]::Max(4, [math]::Min(360, $pct * 3.6)))
  $g.DrawArc($lap, $caja, -90, $barrido)

  $h = $bmp.GetHicon()
  $ico = [System.Drawing.Icon]::FromHandle($h)
  # Se clona para poder destruir el handle ya mismo: GetHicon() entrega un
  # handle que el GC no libera, y esto se rehace cada tick.
  $clon = $ico.Clone()
  [Qm.Nativo]::DestroyIcon($h) | Out-Null
  $ico.Dispose(); $g.Dispose(); $bmp.Dispose(); $lapPista.Dispose(); $lap.Dispose()
  return $clon
}

# ── datos ───────────────────────────────────────────────────────────────

function ArgsWsl([string]$cmd) {
  $prefijo = if ($Distro) { "-d $Distro " } else { '' }
  return "$prefijo-e bash -lc `"$cmd`""
}

function Leer {
  # Devuelve el objeto del JSON, o un string con la frase del problema.
  # Silencio es el bug (SOUL.md): si no hay número, hay una frase.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'wsl.exe'
  $psi.Arguments = ArgsWsl "$QmLinux --json --breve"
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $salida = $p.StandardOutput.ReadToEnd()
    $err = $p.StandardError.ReadToEnd()
    if (-not $p.WaitForExit(20000)) { try { $p.Kill() } catch { }; return 'qm tardó más de 20 s' }
  } catch {
    return "no pude correr qm: $($_.Exception.Message)"
  }
  # 3 es "cruzaste el umbral", no un error.
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3) {
    $linea = (($err + $salida).Trim() -split "`n")[0]
    if (-not $linea) { $linea = 'sin detalle' }
    return "qm salió $($p.ExitCode): $linea"
  }
  try { return ($salida | ConvertFrom-Json) } catch { return 'qm no devolvió JSON' }
}

# Cada cuánto volver a preguntarle al endpoint.
#
# Un intervalo fijo de 5 minutos es inservible para una barra que sube rápido:
# se llega al 100 % adentro de una sola espera. La cadencia sale de lo que ya
# sabemos —cuán alto está y cuánto falta para el techo—, que es exactamente
# para lo que existe la proyección. Misma escalera que cadencia() en
# qm-barra.swift.
$script:Alto = 0.0
$script:MinutosAlTecho = $null

function Cadencia {
  $seg = $SEGUNDOS_SONDEO
  if ($script:Alto -ge 90) { $seg = $MINIMO_RED }
  elseif ($script:Alto -ge 75) { $seg = 120 }
  elseif ($script:Alto -ge 50) { $seg = 240 }
  if ($null -ne $script:MinutosAlTecho) {
    if ($script:MinutosAlTecho -le 30) { $seg = [math]::Min($seg, $MINIMO_RED) }
    elseif ($script:MinutosAlTecho -le 90) { $seg = [math]::Min($seg, 120) }
  }
  return [math]::Max($MINIMO_RED, $seg)
}

$script:UltimoCalentar = [datetime]::MinValue
$script:CuentasQueMueven = @()

function Calentar {
  # Se dispara y se suelta: el resultado lo levanta el tick siguiente. Esperarlo
  # acá congelaría el menú, porque esto corre en el hilo de la interfaz.
  if ($SinCalentar) { return }
  if (((Get-Date) - $script:UltimoCalentar).TotalSeconds -lt (Cadencia)) { return }
  $script:UltimoCalentar = Get-Date
  # Sólo las cuentas que se mueven. Refrescar una que va al 9 % es gastar un
  # pedido para confirmar que no pasó nada.
  $cmd = if ($script:CuentasQueMueven.Count) {
    "$QmLinux --calentar --cuentas=" + ($script:CuentasQueMueven -join ',')
  } else { "$QmLinux --calentar" }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'wsl.exe'
  $psi.Arguments = ArgsWsl $cmd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  try { [System.Diagnostics.Process]::Start($psi) | Out-Null } catch { }
}

# ── el menú ─────────────────────────────────────────────────────────────

function FilaImagen($bmp) {
  $pb = New-Object System.Windows.Forms.PictureBox
  $pb.Image = $bmp
  $pb.Size = $bmp.Size
  $pb.Margin = New-Object System.Windows.Forms.Padding(0)
  $fila = New-Object System.Windows.Forms.ToolStripControlHost($pb)
  $fila.AutoSize = $false
  $fila.Size = $bmp.Size
  $fila.Margin = New-Object System.Windows.Forms.Padding(0)
  $fila.Padding = New-Object System.Windows.Forms.Padding(0)
  return $fila
}

function ItemTexto([string]$t) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($t)
  $it.Enabled = $false
  return $it
}

function RevisarAvisos([string]$perfil, $v, $proy, [bool]$chocas) {
  $base = "$perfil|$(NombreVentana $v)|$(AlMinuto $v.reinicia)"
  $pct = $v.porcentaje
  foreach ($u in $UMBRALES) {
    if ($pct -ge $u) {
      $seg = Faltan $v.reinicia
      $cola = if ($null -ne $seg) { " Se reinicia en $(Dur $seg)." } else { '' }
      Avisar "$base|$u" ("{0}: {1:d}% de {2}" -f $perfil, [int]$pct, (NombreVentana $v)) "Pasaste el $u%.$cola" ($u -ge 95)
    }
  }
  if ($chocas -and $proy) {
    $seg = Faltan $proy.techo
    if ($null -eq $seg) { $seg = 0 }
    Avisar "$base|choque" "${perfil}: a este ritmo llegás al 100%" `
      ('{0:n1} pts/h — tocás el techo en {1}, antes de que la ventana se reinicie.' -f $proy.ritmoPuntosPorHora, (Dur $seg)) $true
  }
}

function Refrescar {
  $datos = Leer
  $menu = $script:Ni.ContextMenuStrip
  # Items.Clear() saca los items de la lista pero no los libera, y acá se
  # reconstruye el menú entero cada tick.
  foreach ($viejo in @($menu.Items)) { $viejo.Dispose() }
  $menu.Items.Clear()

  $etiquetas = @()
  $pico = 0.0
  $nivelPico = 'ok'
  $script:MinutosAlTecho = $null
  $mueven = @()

  if ($datos -is [string]) {
    $menu.Items.Add((ItemTexto $datos)) | Out-Null
    $script:Ni.Text = 'qm · sin datos'
    $ico = HacerIcono 0 'atento'
  } else {
    $i = 0
    foreach ($p in $datos.perfiles) {
      $menu.Items.Add((FilaImagen (DibujarPerfil $p $i))) | Out-Null
      $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
      $i++

      $cuota = $p.cuota
      if ($cuota.estado -ne 'ok') { continue }
      $nombre = Corto $p.perfil
      $peor = $cuota.frena
      $proy = $p.proyeccion
      $chocas = [bool]($proy -and $proy.estado -eq 'sube' -and $proy.chocasAntesDelReinicio)

      if ($null -ne $peor) {
        $pct = [double]$peor.porcentaje
        if ($pct -ge 40) { $mueven += $nombre }
        if ($pct -gt $pico) {
          $pico = $pct
          $nivelPico = NivelDe ([int]$pct) ([bool]($peor.preocupa -or $chocas))
        }
        $viejo = if ($cuota.edadSegundos -gt $VIEJO_SEGUNDOS) { '~' } else { '' }
        $marca = if ($peor.severidad -ne 'normal' -or $chocas) { '!' } else { '' }
        $etiquetas += ('{0} {1}{2:d}%{3}' -f $nombre, $viejo, [int][math]::Round($pct), $marca)
        RevisarAvisos $nombre $peor $proy $chocas
      }
      if ($chocas) {
        $seg = Faltan $proy.techo
        if ($null -ne $seg) {
          $min = $seg / 60
          if ($null -eq $script:MinutosAlTecho -or $min -lt $script:MinutosAlTecho) { $script:MinutosAlTecho = $min }
        }
      }
    }

    $script:Alto = $pico
    $script:CuentasQueMueven = $mueven

    $texto = if ($etiquetas.Count) { $etiquetas -join ' · ' } else { 'sin cuota' }
    # NotifyIcon.Text no acepta más de 63 caracteres.
    if ($texto.Length -gt 63) { $texto = $texto.Substring(0, 60) + '...' }
    $script:Ni.Text = $texto
    $ico = HacerIcono $pico $nivelPico
  }

  $anterior = $script:Ni.Icon
  $script:Ni.Icon = $ico
  if ($anterior) { $anterior.Dispose() }

  foreach ($par in @(
      @{ t = 'Actualizar ahora'; a = { $script:UltimoCalentar = [datetime]::MinValue; Calentar; Refrescar } },
      @{ t = 'Abrir tablero'; a = { AbrirTablero } },
      @{ t = 'Salir'; a = { $script:Ctx.ExitThread() } }
    )) {
    $it = New-Object System.Windows.Forms.ToolStripMenuItem($par.t)
    $it.Add_Click($par.a)
    $menu.Items.Add($it) | Out-Null
  }
}

function AbrirTablero {
  # Si ya hay alguien escuchando, no se levanta un segundo servidor.
  $vivo = $false
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $vivo = $c.ConnectAsync('127.0.0.1', $Puerto).Wait(400)
    $c.Close()
  } catch { $vivo = $false }
  if (-not $vivo) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = ArgsWsl "qm-web --sin-abrir --puerto=$Puerto"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    try { [System.Diagnostics.Process]::Start($psi) | Out-Null; Start-Sleep -Milliseconds 1200 } catch { }
  }
  Start-Process "http://127.0.0.1:$Puerto"
}

# ── arranque ────────────────────────────────────────────────────────────

$script:Ni = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
# Sin esto el menú reserva una canaleta a la izquierda para tildes e íconos, y
# el dibujo queda corrido y con un escalón que no es parte del diseño.
$menu.ShowImageMargin = $false
$menu.ShowCheckMargin = $false
$menu.BackColor = $script:Fondo
$script:Ni.ContextMenuStrip = $menu

$script:Escala = [math]::Max(1.0, $menu.DeviceDpi / 96.0)
CrearFuentes

$script:Ni.Icon = HacerIcono 0 'ok'
$script:Ni.Text = 'quartermaster'
$script:Ni.Visible = $true
# Click izquierdo también abre el menú: en la bandeja lo único que se ve es el
# ícono, y esperar que el usuario adivine que va con botón derecho es la misma
# clase de silencio que motivó el repo.
$script:Ni.Add_MouseUp({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      try {
        $m = $script:Ni.GetType().GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
        if ($m) { $m.Invoke($script:Ni, $null) }
      } catch { }
    }
  })

$script:Ctx = New-Object System.Windows.Forms.ApplicationContext

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Segundos * 1000
$timer.Add_Tick({ Calentar; Refrescar })
$timer.Start()

Calentar
Refrescar

try {
  [System.Windows.Forms.Application]::Run($script:Ctx)
} finally {
  $timer.Stop()
  $script:Ni.Visible = $false
  $script:Ni.Dispose()
}
