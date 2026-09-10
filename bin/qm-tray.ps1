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

# Pintar los dibujos en oscuro no alcanza: el marco del menú, el resaltado del
# item bajo el mouse y los separadores los pinta WinForms con su propia tabla,
# que es clara. Sin esto el panel quedaba oscuro adentro de un menú blanco, que
# se ve peor que el problema original. La tabla no se puede configurar sin
# heredarla, y heredar en PowerShell es esto.
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System.Drawing;
using System.Windows.Forms;
public class QmTabla : ProfessionalColorTable {
  public static Color Fondo   = Color.FromArgb(43, 43, 43);
  public static Color Resalte = Color.FromArgb(62, 62, 62);
  public static Color Borde   = Color.FromArgb(80, 80, 80);
  public override Color ToolStripDropDownBackground { get { return Fondo; } }
  public override Color MenuBorder { get { return Borde; } }
  public override Color MenuItemBorder { get { return Resalte; } }
  public override Color MenuItemSelected { get { return Resalte; } }
  public override Color MenuItemSelectedGradientBegin { get { return Resalte; } }
  public override Color MenuItemSelectedGradientEnd { get { return Resalte; } }
  public override Color ImageMarginGradientBegin { get { return Fondo; } }
  public override Color ImageMarginGradientMiddle { get { return Fondo; } }
  public override Color ImageMarginGradientEnd { get { return Fondo; } }
  public override Color SeparatorDark { get { return Borde; } }
  public override Color SeparatorLight { get { return Fondo; } }
}
'@

Add-Type -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr handle);
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@ -Name Nativo -Namespace Qm

# Sin esto Windows estira el mapa de bits del menú y todo sale borroso.
try { [Qm.Nativo]::SetProcessDPIAware() | Out-Null } catch { }

# El texto del item que refresca. Está en una constante porque lo comparan el
# handler que cancela el cierre y el que pone «Actualizando…», y un literal
# repetido en tres lados es un renombre que rompe dos de ellos en silencio.
$ETIQUETA_ACTUALIZAR = 'Actualizar ahora'

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

# El color con que se identifica cada cuenta, en sus dos versiones.
#
# Deliberadamente lejos de la paleta de estado: verde, ámbar y rojo están
# reservados y no pueden significar además «esta es la cuenta 2».
#
# Son DOS tablas por lo mismo que colorCuenta() en Swift devuelve un NSColor
# dinámico: el mismo azul no sirve sobre los dos fondos. La diferencia es que
# acá hay que elegir a mano, y hay que elegir DOS VECES, porque el menú y la
# barra de tareas son superficies distintas con temas distintos. Medido en esta
# máquina: AppsUseLightTheme=0 y aun así SystemColors.Menu da 240,240,240 —los
# colores de sistema de Win32 no siguen al tema oscuro— mientras la barra de
# tareas sí es oscura. Con una sola tabla, los chevrones de codex (#4a3aa7)
# quedaban casi invisibles sobre la barra negra, que es la de fábrica. Se vio
# mirando el ícono a 16x16; no se deduce del código.
$COLOR_CUENTA_CLARO = @(
  [System.Drawing.Color]::FromArgb(42, 120, 214),   # #2a78d6
  [System.Drawing.Color]::FromArgb(74, 58, 167),    # #4a3aa7
  [System.Drawing.Color]::FromArgb(232, 123, 164)   # #e87ba4
)
$COLOR_CUENTA_OSCURO = @(
  [System.Drawing.Color]::FromArgb(57, 135, 229),   # #3987e5
  [System.Drawing.Color]::FromArgb(144, 133, 233),  # #9085e9
  [System.Drawing.Color]::FromArgb(213, 81, 129)    # #d55181
)

function ColorCuenta([int]$i, [bool]$fondoOscuro) {
  $tabla = if ($fondoOscuro) { $COLOR_CUENTA_OSCURO } else { $COLOR_CUENTA_CLARO }
  return $tabla[$i % $tabla.Count]
}

# ¿Es oscura la barra de tareas? Es OTRA clave que la de las apps. Si no está,
# oscura: es la de fábrica. Se relee en cada tick, así que cambiar el tema se
# nota en la vuelta siguiente sin reiniciar nada.
function BarraOscura {
  try {
    $v = Get-ItemProperty -ErrorAction Stop -Name SystemUsesLightTheme `
      -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    return ($v.SystemUsesLightTheme -eq 0)
  } catch { return $true }
}

# El fondo del menú NO sale de SystemColors, y eso fue un bug reportado: el
# panel era el único de los cuatro renderizadores sin modo oscuro.
#
# Medido acá: con AppsUseLightTheme=0 —Windows en oscuro— SystemColors.Menu
# igual devuelve 240,240,240, porque los colores clásicos de Win32 no siguen al
# tema de las apps. Es la misma trampa que ya había aparecido eligiendo el color
# de cuenta, y ahí sólo se usó para eso; el fondo se había quedado atrás. macOS
# lo saca de un NSColor dinámico y GNOME del tema de GTK, así que Windows era el
# único que tenía que preguntarlo a mano y no lo hacía.
#
# Se relee en cada tick, igual que el de la barra de tareas.
function TemaAppsOscuro {
  try {
    $v = Get-ItemProperty -ErrorAction Stop -Name AppsUseLightTheme `
      -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    return ($v.AppsUseLightTheme -eq 0)
  } catch { return $false }   # sin la clave, claro: es lo que hacía antes
}

# Los tonos del menú de Windows 11 en oscuro. En claro se siguen usando los del
# sistema, que ahí sí son los correctos.
$script:MenuOscuro = $null
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
$script:BarraOscura = $true

# Todo el tema en un lugar, y aplicable de nuevo: cambiar Windows de claro a
# oscuro es algo que se hace, y reiniciar la bandeja para que se entere sería
# la clase de detalle que uno descubre justo cuando no quiere. Devuelve $true
# si cambió algo, para no rehacer el menú al vicio en cada tick.
function AplicarTema {
  $oscuro = TemaAppsOscuro
  if ($oscuro -eq $script:MenuOscuro) { return $false }
  $script:MenuOscuro = $oscuro
  $script:Fondo = if ($oscuro) { [System.Drawing.Color]::FromArgb(43, 43, 43) }
                  else { [System.Drawing.SystemColors]::Menu }
  $script:Tinta = if ($oscuro) { [System.Drawing.Color]::FromArgb(255, 255, 255) }
                  else { [System.Drawing.SystemColors]::MenuText }
  $script:Tinta2 = Mezclar $script:Tinta $script:Fondo 0.38
  $script:Tinta3 = Mezclar $script:Tinta $script:Fondo 0.58
  $script:Pista  = Mezclar $script:Fondo $script:Tinta 0.14
  if ($null -ne $script:Menu) {
    $script:Menu.BackColor = $script:Fondo
    $script:Menu.ForeColor = $script:Tinta
    if ($oscuro) {
      [QmTabla]::Fondo = $script:Fondo
      [QmTabla]::Resalte = Mezclar $script:Fondo $script:Tinta 0.12
      [QmTabla]::Borde = Mezclar $script:Fondo $script:Tinta 0.22
      $script:Menu.Renderer = New-Object System.Windows.Forms.ToolStripProfessionalRenderer((New-Object QmTabla))
    } else {
      # De vuelta al de fábrica: la tabla oscura sobre un menú claro se ve
      # igual de mal que al revés.
      $script:Menu.RenderMode = [System.Windows.Forms.ToolStripRenderMode]::ManagerRenderMode
    }
  }
  return $true
}

# ── formato ─────────────────────────────────────────────────────────────

function Corto([string]$nombre) {
  $n = $nombre
  if ($n.StartsWith('.claude')) { $n = $n.Substring(7) }
  $n = $n.TrimStart('-')
  if ($n -eq '') { return 'main' }
  return $n
}

function Dur([int]$segundos) {
  # La escalera de duración del proyecto. El canon es duracion() en
  # src/render/barras.ts —por donde pasa todo lo que imprime el CLI— y está
  # congelado en test/fixtures/duraciones.json; make gate-duraciones corre las
  # cuatro implementaciones y las compara.
  #
  # Antes esta decía 'ya', '1h' y '1d0h' donde el CLI decía 'vencido', '1h00m' y
  # '1d'. Eran dos convenciones conviviendo, y sobrevivieron porque nadie había
  # comparado una GUI contra el CLI.
  if ($segundos -lt 0) { return 'vencido' }
  $h = [int][math]::Floor($segundos / 3600)
  $m = [int][math]::Floor(($segundos % 3600) / 60)
  if ($h -ge 24) {
    $d = [int][math]::Floor($h / 24)
    if (($h % 24) -eq 0) { return "${d}d" } else { return "${d}d$($h % 24)h" }
  }
  if ($h -gt 0) { return ('{0}h{1:d2}m' -f $h, $m) }
  if ($m -gt 0) { return "${m}m" }
  return "${segundos}s"
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
    # Invariante y no la cultura de la máquina: con `n1`, una Windows en
    # español escribe «1,8 pts/h» y una en inglés «1.8», así que las pantallas
    # dejaban de coincidir entre sí y con macOS, que usa %.1f. El separador de
    # un número no es una decisión de localización acá: es parte del dibujo.
    $ritmo = ([double]$p.ritmoPuntosPorHora).ToString('0.0', [cultureinfo]::InvariantCulture)
    $cuando = "$ritmo pts/h · 100 % en $(Dur $seg)"
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
  # No se muestra acá: se encola. Un globo necesita un item VISIBLE que lo
  # emita, y los items se crean después de dibujar —recién ahí se sabe cuántas
  # cuentas hay—. Mostrarlo en el momento perdía justo el aviso del primer
  # tick, que es el que llega cuando arrancás la máquina ya frenado.
  $script:Globos += @{ titulo = $titulo; cuerpo = $cuerpo; urgente = $urgente }
}

$script:Globos = @()

function SoltarGlobos {
  if (-not $script:Ni) { $script:Globos = @(); return }
  foreach ($gl in @($script:Globos)) {
    $ico = if ($gl.urgente) { [System.Windows.Forms.ToolTipIcon]::Error } else { [System.Windows.Forms.ToolTipIcon]::Warning }
    try { $script:Ni.ShowBalloonTip(($(if ($gl.urgente) { 30000 } else { 10000 })), $gl.titulo, $gl.cuerpo, $ico) } catch { }
  }
  $script:Globos = @()
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
# 6 de aire + 16 de curva + 12 para los rótulos de abajo, igual que
# VistaCuenta.ALTO_CURVA en Swift. Si esto no coincide con lo que dibuja
# DibujarPerfil, los rótulos se comen el renglón siguiente.
$ALTO_CURVA = 34
# El anillo (44) más el aire de arriba y abajo: el alto de VistaResumen.
$ALTO_RESUMEN = 74

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
  $script:FRotulo = & $f 9  ([System.Drawing.FontStyle]::Bold)
  $script:FMini   = & $f 9  ([System.Drawing.FontStyle]::Regular)
  $script:FCifra  = & $f 20 ([System.Drawing.FontStyle]::Bold)
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
function GlifoProducto($g, [string]$producto, $color, [float]$x, [float]$y, [float]$lado, [float]$grosor = -1) {
  # El grosor por defecto sigue al DPI, como el resto del menú. El ícono de la
  # bandeja lo pasa explícito: ese se dibuja a 32 px fijos y lo baja Windows,
  # así que un trazo de 1,3 se le desaparece en el camino a 16.
  if ($grosor -le 0) { $grosor = Px 1.3 }
  $lapiz = New-Object System.Drawing.Pen($color, $grosor)
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

# Las muestras recientes de la barra que frena, dibujadas.
#
# El eje Y va del mínimo al máximo de la serie y NO de 0 a 100: lo que
# interesa acá es la PENDIENTE, y a escala completa una subida de tres puntos
# se ve plana. Es el mismo criterio —y el mismo dibujo— que dibujarCurva() en
# qm-barra.swift, con la diferencia obvia de que en GDI+ la Y crece para abajo.
function DibujarCurva($g, $historia, [string]$nivel, $caja) {
  $h = @($historia)
  if ($h.Count -lt 3) { return }
  $ts = @($h | ForEach-Object { [double]$_.t })
  $ps = @($h | ForEach-Object { [double]$_.porcentaje })
  $t0 = ($ts | Measure-Object -Minimum).Minimum
  $t1 = ($ts | Measure-Object -Maximum).Maximum
  $p0 = ($ps | Measure-Object -Minimum).Minimum
  $p1 = ($ps | Measure-Object -Maximum).Maximum
  if ($t1 -le $t0) { return }
  $rango = [math]::Max(1, $p1 - $p0)

  $pts = @()
  for ($i = 0; $i -lt $h.Count; $i++) {
    $pts += New-Object System.Drawing.PointF(
      [float]($caja.X + $caja.Width * ($ts[$i] - $t0) / ($t1 - $t0)),
      [float]($caja.Bottom - $caja.Height * ($ps[$i] - $p0) / $rango))
  }

  $c = $PALETA[$nivel]
  # Un piso tenue, para que se vea que es un área y no una raya suelta.
  $area = @(New-Object System.Drawing.PointF($pts[0].X, $caja.Bottom)) + $pts +
          @(New-Object System.Drawing.PointF($pts[$pts.Count - 1].X, $caja.Bottom))
  $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, $c.R, $c.G, $c.B))
  $g.FillPolygon($br, [System.Drawing.PointF[]]$area)
  $br.Dispose()

  $lap = New-Object System.Drawing.Pen($c, (Px 1.5))
  $lap.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawLines($lap, [System.Drawing.PointF[]]$pts)
  $lap.Dispose()

  # El punto de ahora, que es el que se mira.
  $fin = $pts[$pts.Count - 1]
  $d = Px 5
  $brF = New-Object System.Drawing.SolidBrush($c)
  $g.FillEllipse($brF, ($fin.X - $d / 2), ($fin.Y - $d / 2), $d, $d)
  $brF.Dispose()

  $horas = ($t1 - $t0) / 3600000
  Escribir $g ('{0:d}%' -f [int][math]::Round($p0)) $caja.X ($caja.Bottom + (Px 1)) $script:FMini $script:Tinta3
  $cola = if ($horas -ge 1) {
    'últimas ' + ([double]$horas).ToString('0.0', [cultureinfo]::InvariantCulture) + ' h'
  } else { 'última hora' }
  Escribir $g $cola 0 ($caja.Bottom + (Px 1)) $script:FMini $script:Tinta3 $caja.Right
}

function AltoPerfil($p) {
  $alto = (Px $MARGEN) + (Px $ALTO_CABECERA)
  $cuota = $p.cuota
  if ($cuota.estado -ne 'ok') {
    $alto += (Px $ALTO_FRASE)
  } else {
    $alto += (Px $ALTO_BARRA) * (@($cuota.mostrar)).Count
    # La curva es de la barra que frena, así que suma una vez y no por barra.
    if ((@($cuota.historia)).Count -ge 3) { $alto += (Px $ALTO_CURVA) }
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

  # El del MENÚ, que va sobre el fondo del menú.
  $colorCuenta = ColorCuenta $indice $script:MenuOscuro
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

    # La curva va pegada a la barra que frena: es de ella, no del perfil.
    if ($esPeor -and (@($cuota.historia)).Count -ge 3) {
      DibujarCurva $g $cuota.historia $nivel `
        (New-Object System.Drawing.RectangleF($m, ($y + (Px 2)), ($der - $m), (Px 16)))
      $y += Px $ALTO_CURVA
    }
  }

  $ritmo = FraseRitmo $p.proyeccion
  if ($ritmo) {
    Escribir $g $ritmo $m $y $script:FPie $(if ($chocas) { $PALETA['critico'] } else { $script:Tinta3 })
  }

  $g.Dispose()
  return $bmp
}

# La cabecera del panel: LO PRIMERO QUE TE FRENA.
#
# Es VistaResumen de qm-barra.swift. Con varias cuentas la primera pregunta no
# es «cómo va cada una» sino «cuál me frena y cuándo me suelta», y eso es una
# sola línea: va arriba de todo y el detalle por cuenta viene después.
#
# Devuelve $null cuando ninguna cuenta dejó número: una cabecera vacía sería
# peor que no tenerla, y cada perfil ya dice su propia frase abajo.
function DibujarResumen($perfiles) {
  $mejorP = $null; $mejor = $null
  foreach ($p in $perfiles) {
    if ($p.cuota.estado -ne 'ok') { continue }
    $v = $p.cuota.frena
    if ($null -eq $v) { continue }
    if ($null -eq $mejor -or $v.porcentaje -gt $mejor.porcentaje) { $mejor = $v; $mejorP = $p }
  }
  if ($null -eq $mejor) { return $null }

  $pct = [int][math]::Round($mejor.porcentaje)
  $chocas = [bool]($mejorP.proyeccion -and $mejorP.proyeccion.estado -eq 'sube' `
      -and $mejorP.proyeccion.chocasAntesDelReinicio)
  $nivel = NivelDe $pct ([bool]($mejor.preocupa -or $chocas))
  $c = $PALETA[$nivel]

  $ancho = [int](Px $ANCHO_VISTA)
  $alto = [int](Px $ALTO_RESUMEN)
  $bmp = New-Object System.Drawing.Bitmap($ancho, $alto)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($script:Fondo)

  # El anillo, igual que el del tablero: pista tenue del mismo color y arco
  # con punta redondeada.
  $m = Px $MARGEN
  $lado = Px 44
  $grosor = Px 5
  $caja = New-Object System.Drawing.RectangleF(
    ($m + $grosor / 2), (($alto - $lado) / 2 + $grosor / 2),
    ($lado - $grosor), ($lado - $grosor))
  $lapPista = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(46, $c.R, $c.G, $c.B)), $grosor)
  $g.DrawEllipse($lapPista, $caja)
  $lapPista.Dispose()
  $lap = New-Object System.Drawing.Pen($c, $grosor)
  $lap.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $lap.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($lap, $caja, -90, [float]([math]::Max(4, [math]::Min(360, $pct * 3.6))))
  $lap.Dispose()

  $x = $m + $lado + (Px 14)
  Escribir $g 'LO PRIMERO QUE TE FRENA' $x (Px 11) $script:FRotulo $script:Tinta3
  $cifra = '{0:d}%' -f $pct
  Escribir $g $cifra $x (Px 22) $script:FCifra $script:Tinta
  # El nombre va a la derecha de la cifra, apoyado en su misma línea de base.
  Escribir $g ('  {0} · {1}' -f (Corto $mejorP.perfil), (NombreVentana $mejor)) `
    ($x + $g.MeasureString($cifra, $script:FCifra).Width) (Px 30) $script:FSub $script:Tinta2

  # Cuando ya te frenó, lo que importa no es cuándo «reinicia»: es cuándo
  # volvés a poder trabajar. Es la misma fecha y una pregunta distinta.
  $seg = Faltan $mejor.reinicia
  $texto = if ($pct -ge 95 -and $null -ne $seg) { "libre en $(Dur $seg)" }
    elseif ($null -ne $seg) { "reinicia en $(Dur $seg)" }
    else { 'sin reinicio informado' }
  Escribir $g $texto $x (Px 50) $script:FPie $(if ($pct -ge 95) { $c } else { $script:Tinta3 })

  $g.Dispose()
  return $bmp
}

# ── los íconos de la bandeja ────────────────────────────────────────────
# Nunca un número, y uno por cuenta.
#
# Lo primero que se aprendió acá: la primera versión dibujaba el porcentaje
# adentro del ícono, como los medidores de batería. Se renderizó a 16x16 —el
# tamaño real de la bandeja a 96 dpi— y se miró: un dígito se lee, dos son una
# mancha. Así que el número se va al tooltip y al menú, y el ícono hace de
# MEDIDOR: la forma dice cuánto va y el color dice cuánto importa, y las dos
# cosas sobreviven a 16 píxeles.
#
# Lo segundo: la barra de menú de macOS no muestra UN medidor, muestra una
# TIRA —glifo, medidor y número, una vez por cuenta— y eso es lo que se viene
# a mirar. En un item de bandeja no cabe, porque no tiene etiqueta de texto y
# es un cuadrado de 16x16. Así que la tira se reparte: un item por cuenta, con
# el glifo de su producto y el medidor de su semanal, y el número de la sesión
# en el tooltip. HacerIcono quedó para el único caso sin cuenta que mostrar:
# cuando qm no contesta.
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

# Un trozo de la tira de macOS, hecho ícono: el glifo del producto y, al lado,
# el medidor vertical de la semanal.
#
# El glifo dice QUÉ suscripción es —la forma, el producto; el color, cuál de
# ellas— y el medidor dice cómo va. La identidad va en el glifo y nunca en el
# medidor, que está reservado para el estado: verde, ámbar y rojo no pueden
# significar además «esta es la cuenta 2».
#
# Se dibuja a 32 px, que es lo que pide la bandeja al 200 %, y Windows lo baja
# a 16 cuando hace falta. Por eso el trazo del glifo va explícito y grueso.
function IconoCuenta([string]$producto, $colorCuenta, $semanal, [string]$nivelSemanal) {
  $lado = 32
  $bmp = New-Object System.Drawing.Bitmap($lado, $lado)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  GlifoProducto $g $producto $colorCuenta 0 6 20 2.4

  # El medidor es SIEMPRE la semanal. Si la cuenta no informa ninguna queda la
  # pista vacía: mejor un hueco honesto que dibujar ahí otra cosa.
  # 22 de 32 es la misma proporción que altoBarra/alto en medidores() de Swift
  # (15 de 22). A 26 el medidor le ganaba al glifo y el ícono dejaba de decir
  # de qué cuenta era.
  $ancho = 6.0; $x = 23.0; $y0 = 5.0; $altoBarra = 22.0
  $r = $ancho / 2
  $brPista = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(105, 128, 128, 128))
  RectRedondeado $g (New-Object System.Drawing.RectangleF($x, $y0, $ancho, $altoBarra)) $r $brPista
  $brPista.Dispose()
  if ($null -ne $semanal) {
    $frac = [math]::Max(0, [math]::Min(100, $semanal)) / 100
    $h = [math]::Max($ancho, $altoBarra * $frac)
    $br = New-Object System.Drawing.SolidBrush($PALETA[$nivelSemanal])
    # Se llena desde ABAJO, como el medidor vertical de la barra de macOS.
    RectRedondeado $g (New-Object System.Drawing.RectangleF($x, ($y0 + $altoBarra - $h), $ancho, $h)) $r $br
    $br.Dispose()
  }

  $handle = $bmp.GetHicon()
  $ico = [System.Drawing.Icon]::FromHandle($handle)
  # Se clona para poder destruir el handle ya mismo: GetHicon() entrega uno que
  # el GC no libera, y esto se rehace cada tick por cada cuenta.
  $clon = $ico.Clone()
  [Qm.Nativo]::DestroyIcon($handle) | Out-Null
  $ico.Dispose(); $g.Dispose(); $bmp.Dispose()
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
# La espera de «Actualizar ahora», si hay una en curso.
$script:Espera = $null
$script:EsperaProc = $null
$script:EsperaDesde = [datetime]::MinValue

function Calentar([switch]$Forzado) {
  # Se dispara y se suelta: el resultado lo levanta el tick siguiente. Esperarlo
  # acá congelaría el menú, porque esto corre en el hilo de la interfaz.
  #
  # Devuelve el proceso para que quien lo pidió a mano pueda esperarlo sin
  # bloquear, y -Forzado saltea la cadencia: si el usuario apretó el botón, la
  # respuesta no es "todavía no toca".
  if ($SinCalentar) { return $null }
  if (-not $Forzado -and ((Get-Date) - $script:UltimoCalentar).TotalSeconds -lt (Cadencia)) { return $null }
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
  try { return [System.Diagnostics.Process]::Start($psi) } catch { return $null }
}

# Abrir el panel a mano. `ShowContextMenu` es interno, así que va por reflexión;
# es lo mismo que hace el click izquierdo sobre un item.
function MostrarMenu($ni) {
  if ($null -eq $ni) { return }
  try {
    $m = $ni.GetType().GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')
    if ($m) { $m.Invoke($ni, $null) }
  } catch { }
}

# «Actualizar ahora», que antes no actualizaba nada y después parpadeaba.
#
# Dos problemas encadenados. El primero: era el mismo `Calentar; Refrescar` del
# tick, y el calentado tarda ~930 ms mientras el Refrescar que venía detrás
# tarda ~250, así que leía el cache de ANTES del calentado que él mismo acababa
# de disparar. El número era exactamente el que ya estabas mirando.
#
# El segundo, que apareció recién al arreglar el primero: Windows cierra un
# menú al clickear cualquier item, así que el panel desaparecía y volvía dos
# segundos después. Un parpadeo no es una actualización.
#
# Ahora el panel NO se cierra —el cierre se cancela cuando el item clickeado es
# éste, y sólo éste— y el número aparece adentro del panel abierto. Mientras
# llega, el item dice «Actualizando…» y no acepta otro click: dos segundos sin
# ninguna señal se leen como que no pasó nada, que es de donde vino todo esto.
#
# La espera va con un timer y no con el hilo: congelar la interfaz un segundo
# sería volver al problema que explica el comentario de Calentar.
function ActualizarAhora {
  if ($null -ne $script:Espera) { return }   # ya hay uno en curso
  $proc = Calentar -Forzado
  if ($null -eq $proc) { Refrescar; return }
  $script:EsperaProc = $proc
  $script:EsperaDesde = Get-Date
  # La señal de que está pasando algo, en el item que se apretó.
  foreach ($it in @($script:Menu.Items)) {
    if ($it -is [System.Windows.Forms.ToolStripMenuItem] -and $it.Text -eq $ETIQUETA_ACTUALIZAR) {
      $it.Text = 'Actualizando…'
      $it.Enabled = $false
    }
  }
  $script:Espera = New-Object System.Windows.Forms.Timer
  $script:Espera.Interval = 250
  $script:Espera.Add_Tick({
      $listo = $false
      try { $listo = $script:EsperaProc.HasExited } catch { $listo = $true }
      # Un techo, para no quedarse esperando un calentado que no vuelve.
      if (-not $listo -and ((Get-Date) - $script:EsperaDesde).TotalSeconds -lt 15) { return }
      $script:Espera.Stop()
      $script:Espera.Dispose()
      $script:Espera = $null
      try { $script:EsperaProc.Dispose() } catch { }
      $script:EsperaProc = $null
      Refrescar
    })
  $script:Espera.Start()
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
  # Un item deshabilitado se pinta con el gris del sistema, que sobre fondo
  # oscuro no se lee. Y es justo el item que lleva la frase del problema.
  $it.ForeColor = $script:Tinta2
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
      ("$(([double]$proy.ritmoPuntosPorHora).ToString('0.0', [cultureinfo]::InvariantCulture)) pts/h — " +
       "tocás el techo en $(Dur $seg), antes de que la ventana se reinicie.") $true
  }
}

# La tira: crea, actualiza y saca items de bandeja según las cuentas que haya.
#
# Reusar el mismo NotifyIcon mientras la cuenta siga existiendo es lo que evita
# que los íconos salten de lugar —o al desplegable de overflow— en cada tick.
# Windows los ordena por orden de registro, así que el orden de la tira es el
# orden en que aparecieron, que es el del menú.
function ActualizarTira($tira) {
  $vivas = @()
  foreach ($t in $tira) {
    $vivas += $t.clave
    if ($script:Iconos.Contains($t.clave)) {
      $ni = $script:Iconos[$t.clave]
    } else {
      $ni = New-Object System.Windows.Forms.NotifyIcon
      # Los items comparten el MISMO menú: hacer click en cualquiera abre el
      # panel completo, con todas las cuentas.
      $ni.ContextMenuStrip = $script:Menu
      $ni.Add_MouseUp($script:AbrirMenu)
      $ni.Visible = $true
      $script:Iconos[$t.clave] = $ni
    }
    $anterior = $ni.Icon
    $ni.Icon = $t.icono
    if ($anterior) { $anterior.Dispose() }
    # NotifyIcon.Text no acepta más de 63 caracteres.
    $texto = [string]$t.texto
    if ($texto.Length -gt 63) { $texto = $texto.Substring(0, 60) + '...' }
    $ni.Text = $texto
  }

  foreach ($clave in @($script:Iconos.Keys)) {
    if ($vivas -contains $clave) { continue }
    $ni = $script:Iconos[$clave]
    $ni.Visible = $false
    if ($ni.Icon) { $ni.Icon.Dispose() }
    $ni.Dispose()
    $script:Iconos.Remove($clave)
  }
  # El que emite los globos. Cualquiera sirve; tiene que estar visible.
  $script:Ni = if ($script:Iconos.Count) { @($script:Iconos.Values)[0] } else { $null }
}

function Refrescar {
  # Si el panel está abierto —«Actualizar ahora» lo deja así— hay que suspender
  # el layout mientras se cambian los items. Sin esto, cada Add() relayoutea y
  # reposiciona el menú visible: se ve saltar de tamaño una vez por sección.
  $abierto = $false
  try { $abierto = $script:Menu.Visible } catch { $abierto = $false }
  if ($abierto) { $script:Menu.SuspendLayout() }

  $datos = Leer
  # Los dos temas, que son dos claves distintas del registro y pueden no
  # coincidir. Si el de las apps cambió, AplicarTema rehace la paleta; el menú
  # se redibuja igual acá abajo, así que no hace falta hacer nada más.
  $null = AplicarTema
  $script:BarraOscura = BarraOscura
  $menu = $script:Menu
  # Items.Clear() saca los items de la lista pero no los libera, y acá se
  # reconstruye el menú entero cada tick.
  foreach ($viejo in @($menu.Items)) { $viejo.Dispose() }
  $menu.Items.Clear()
  # Un PictureBox no libera su Image al morir, así que los mapas de bits del
  # tick anterior se sueltan a mano. Con la cabecera son uno más por vuelta, y
  # cada uno mide 340 px de ancho.
  foreach ($b in @($script:Bitmaps)) { try { $b.Dispose() } catch { } }
  $script:Bitmaps = @()

  $pico = 0.0
  $script:MinutosAlTecho = $null
  $mueven = @()
  $tira = @()

  if ($datos -is [string]) {
    $menu.Items.Add((ItemTexto $datos)) | Out-Null
    # Sin datos no hay cuentas: queda un solo item, con el arco vacío.
    $tira = @(@{ clave = '?'; icono = (HacerIcono 0 'atento'); texto = "qm · $datos" })
  } else {
    $resumen = DibujarResumen $datos.perfiles
    if ($resumen) {
      $script:Bitmaps += $resumen
      $menu.Items.Add((FilaImagen $resumen)) | Out-Null
      $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    }

    # El índice del color de cuenta avanza sólo con las que dejaron número,
    # igual que iCuenta en qm-barra.swift: una cuenta muda no gasta un color,
    # así que las que se ven conservan el suyo de una lectura a la otra.
    $iCuenta = 0
    foreach ($p in $datos.perfiles) {
      $bmp = DibujarPerfil $p $iCuenta
      $script:Bitmaps += $bmp
      $menu.Items.Add((FilaImagen $bmp)) | Out-Null
      $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

      $cuota = $p.cuota
      $nombre = Corto $p.perfil
      # El del ÍCONO, que va sobre la barra de tareas y puede no ser el mismo.
      $colorCuenta = ColorCuenta $iCuenta $script:BarraOscura

      # Un lugar en la tira POR PERFIL, tenga número o no.
      #
      # macOS puede dejar afuera a una cuenta muda porque su tira es un solo
      # dibujo que se rehace entero. Acá cada lugar es un item de bandeja, y
      # Windows lo identifica por el hash de (ejecutable + UID) donde el UID lo
      # reparte WinForms POR ORDEN DE CREACIÓN. Medido en el registro, en
      # Control Panel\NotifyIconSettings. O sea: sacar y volver a poner un item
      # corre los UID de los que vienen después, y con eso se le muda de cuenta
      # la decisión de "este ícono va fijo en la barra" que el usuario tomó
      # arrastrándolo. Un lugar fijo por perfil, con el medidor vacío cuando no
      # hay número, cuesta un cuadradito y salva esa decisión.
      if ($cuota.estado -ne 'ok') {
        $frase = if ($cuota.PSObject.Properties['frase']) { $cuota.frase } else { 'sin cuota' }
        $tira += @{
          clave = [string]$p.perfil
          icono = (IconoCuenta $p.producto $colorCuenta $null 'ok')
          texto = "$nombre · $frase"
        }
        continue
      }
      $iCuenta++

      $peor = $cuota.frena
      $proy = $p.proyeccion
      $chocas = [bool]($proy -and $proy.estado -eq 'sube' -and $proy.chocasAntesDelReinicio)
      $viejo = if ($cuota.edadSegundos -gt $VIEJO_SEGUNDOS) { '~' } else { '' }

      # El medidor es SIEMPRE la semanal; el número de la sesión —que en macOS
      # va al lado del medidor— acá no tiene dónde ir y se va al tooltip.
      $ses = $cuota.sesion
      $sem = $cuota.semanal
      $nivelSem = if ($null -ne $sem) {
        NivelDe ([int]$sem.porcentaje) `
          ([bool]($sem.preocupa -or ($chocas -and $null -ne $peor -and $sem.clave -eq $peor.clave)))
      } else { 'ok' }
      $partes = @($nombre)
      if ($null -ne $ses) { $partes += ('sesión {0}{1:d}%' -f $viejo, [int][math]::Round($ses.porcentaje)) }
      if ($null -ne $sem) { $partes += ('{0} {1:d}%' -f (NombreVentana $sem), [int][math]::Round($sem.porcentaje)) }
      $tira += @{
        clave = [string]$p.perfil
        icono = (IconoCuenta $p.producto $colorCuenta `
            $(if ($null -ne $sem) { [int]$sem.porcentaje } else { $null }) $nivelSem)
        texto = ($partes -join ' · ')
      }

      if ($null -ne $peor) {
        $pct = [double]$peor.porcentaje
        if ($pct -ge 40) { $mueven += $nombre }
        if ($pct -gt $pico) { $pico = $pct }
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

    # Ahora cada perfil tiene su lugar, así que esto sólo salta si qm no
    # encontró ni un perfil. La bandeja vacía es el silencio otra vez.
    if (-not $tira.Count) {
      $tira = @(@{ clave = '?'; icono = (HacerIcono 0 'atento'); texto = 'qm · sin cuota' })
    }
  }

  ActualizarTira $tira
  SoltarGlobos

  # El item que se apretó volvió a nacer con su texto normal, así que no hay
  # que deshacer el «Actualizando…»: se fue con el item viejo.
  foreach ($par in @(
      @{ t = $ETIQUETA_ACTUALIZAR; a = { ActualizarAhora } },
      @{ t = 'Abrir tablero'; a = { AbrirTablero } },
      @{ t = 'Salir'; a = { $script:Ctx.ExitThread() } }
    )) {
    $it = New-Object System.Windows.Forms.ToolStripMenuItem($par.t)
    $it.ForeColor = $script:Tinta
    $it.Add_Click($par.a)
    $menu.Items.Add($it) | Out-Null
  }

  if ($abierto) {
    $script:Menu.ResumeLayout($true)
    # El panel cambió de alto, así que hay que reacomodarlo: sin esto se queda
    # con el tamaño de antes y recorta la última sección.
    $script:Menu.PerformLayout()
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

# El menú es uno solo y lo comparten todos los items de la tira, así que se
# arma antes que ellos.
$script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
# Sin esto el menú reserva una canaleta a la izquierda para tildes e íconos, y
# el dibujo queda corrido y con un escalón que no es parte del diseño.
$script:Menu.ShowImageMargin = $false
$script:Menu.ShowCheckMargin = $false
$null = AplicarTema

# Que «Actualizar ahora» no cierre el panel.
#
# WinForms cierra un menú al clickear cualquier item, y ahí se pierde justo lo
# que se venía a mirar. El cierre se puede cancelar, pero sólo se cancela para
# ESTE item: «Abrir tablero» y «Salir» tienen que seguir cerrándolo, y clickear
# afuera o apretar Escape también.
#
# Hacen falta los dos handlers y no uno: ItemClicked corre antes que Closing y
# es el único que sabe QUÉ se clickeó; Closing es el único que puede cancelar.
$script:MantenerAbierto = $false
$script:Menu.Add_ItemClicked({
    $script:MantenerAbierto = ($_.ClickedItem.Text -eq $ETIQUETA_ACTUALIZAR)
  })
$script:Menu.Add_Closing({
    if ($script:MantenerAbierto -and
        $_.CloseReason -eq [System.Windows.Forms.ToolStripDropDownCloseReason]::ItemClicked) {
      $_.Cancel = $true
    }
    $script:MantenerAbierto = $false
  })

# La tira, indexada por perfil y en orden de aparición. Y el item que emite los
# globos, que sale de ella.
$script:Iconos = [ordered]@{}
$script:Bitmaps = @()
$script:Ni = $null

# Click izquierdo también abre el menú: en la bandeja lo único que se ve es el
# ícono, y esperar que el usuario adivine que va con botón derecho es la misma
# clase de silencio que motivó el repo. `$this` es el item clickeado, que con
# varios en la tira ya no es siempre el mismo.
$script:AbrirMenu = {
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { MostrarMenu $this }
}

$script:Escala = [math]::Max(1.0, $script:Menu.DeviceDpi / 96.0)
CrearFuentes

$script:Ctx = New-Object System.Windows.Forms.ApplicationContext

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Segundos * 1000
$timer.Add_Tick({ $null = Calentar; Refrescar })
$timer.Start()

$null = Calentar
Refrescar

try {
  [System.Windows.Forms.Application]::Run($script:Ctx)
} finally {
  $timer.Stop()
  foreach ($ni in @($script:Iconos.Values)) {
    $ni.Visible = $false
    if ($ni.Icon) { $ni.Icon.Dispose() }
    $ni.Dispose()
  }
  foreach ($b in @($script:Bitmaps)) { try { $b.Dispose() } catch { } }
}
