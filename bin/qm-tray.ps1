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
  [switch]$SinCalentar,

  # Con esto la bandeja NO se relanza cuando el .ps1 cambia debajo.
  #
  # El reinicio automático existe para el caso del usuario —`git pull` o un
  # gestor de paquetes reemplazan el archivo y si no, seguís con el código viejo
  # para siempre— pero es hostil justo para quien está EDITANDO el archivo: cada
  # guardado relanza la bandeja, y la relanza con el trabajo a medio hacer. El
  # parseo previo atrapa un archivo roto; no atrapa uno que parsea y todavía no
  # está terminado, que es la forma normal de un archivo mientras se lo escribe.
  [switch]$SinAutoReinicio,

  # Qué íconos poner en la bandeja, separados por coma.
  #
  #   (vacío)        el general MÁS uno por cuenta — lo que se ve por defecto
  #   general        sólo el general, con todas las cuentas adentro
  #   main,codex     sólo esas dos cuentas, sin general
  #   general,codex  el general y codex
  #
  # El general lleva la marca de quartermaster y su panel es el de siempre:
  # todas las cuentas, con la cabecera de lo primero que te frena. Los de cada
  # cuenta llevan el glifo de su producto y su panel muestra ESA cuenta sola.
  # Con cuatro cuentas en una barra de tareas angosta, cuatro paneles completos
  # es cuatro veces la misma pantalla; el que importa es el que se abrió.
  [string]$Iconos = '',

  # ── el modo del gate ──────────────────────────────────────────────────
  # Dibuja contra un JSON fijo, escribe el PNG y sale, sin bandeja ni menú ni
  # bucle de mensajes. Es el equivalente de `--desde` y `--captura` en
  # bin/qm-indicator, y existe por la misma razón: con una entrada fija lo que
  # sale es comparable entre corridas y entre máquinas, así que se puede medir
  # en CI. Sin esto, de las 1200 líneas de este archivo el CI comprobaba UNA
  # función —la escalera de duración— y un error de dibujo en cualquier otra
  # pasaba en verde.
  [string]$Desde = '',
  [string]$Captura = '',
  # Cuál panel dibujar: 'general' o el nombre corto de una cuenta. Es la forma
  # de comprobar, sin bandeja, que el ícono de una cuenta muestra ESA cuenta.
  [string]$Panel = '',
  # El tema es una lectura del registro, y en un runner de CI no está el que
  # uno quiere comprobar. En modo captura se fuerza a mano.
  [switch]$Oscuro,
  [switch]$Claro
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

# Que una excepción en el hilo de la interfaz NO mate la bandeja.
#
# Por defecto WinForms le muestra al usuario el cartel morado de «Unhandled
# exception has occurred in your application», y si aprieta Quit —o si el cartel
# aparece con la máquina bloqueada y nadie lo ve— la bandeja desaparece. Una
# bandeja muerta no deja ícono, y un ícono que no está se lee exactamente igual
# que una cuenta que va bien: es el silencio del que habla la primera sección
# del README, con otra causa.
#
# Así que se atrapa, se sigue andando con lo que había, y se DICE: una línea a
# stderr siempre —que es lo único que explica por qué un tick no actualizó— y un
# globo la primera vez, para que el usuario se entere sin tener que ir a buscar
# un log. Una sola vez: un repintado que falla lo hace muchas veces seguidas.
#
# Va acá arriba de todo a propósito: SetUnhandledExceptionMode se niega a correr
# una vez que existe la primera ventana del hilo.
[System.Windows.Forms.Application]::SetUnhandledExceptionMode(
  [System.Windows.Forms.UnhandledExceptionMode]::CatchException)
$script:AvisoTropiezo = $false
[System.Windows.Forms.Application]::add_ThreadException({
    param($quien, $ev)
    [Console]::Error.WriteLine("[qm-tray] $($ev.Exception.GetType().Name): $($ev.Exception.Message)")
    [Console]::Error.WriteLine($ev.Exception.StackTrace)
    if (-not $script:AvisoTropiezo) {
      $script:AvisoTropiezo = $true
      try {
        Globo 'quartermaster' ("la bandeja tropezó dibujando y sigue andando con lo anterior: " +
                               $ev.Exception.Message) $false
      } catch { }
    }
  })

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
  # Forzado desde la línea de comandos: el gate tiene que poder pedir los dos
  # temas en una máquina que no es la de nadie.
  if ($Oscuro) { return $true }
  if ($Claro) { return $false }
  try {
    $v = Get-ItemProperty -ErrorAction Stop -Name AppsUseLightTheme `
      -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize'
    return ($v.AppsUseLightTheme -eq 0)
  } catch { return $false }   # sin la clave, claro: es lo que hacía antes
}

# Un menú por ícono de la bandeja, indexado por la misma clave que el ícono:
# 'general' y el nombre corto de cada cuenta. Se declara acá arriba porque
# AplicarTema lo recorre y puede correr antes de que exista ninguno.
$script:Menus = [ordered]@{}

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
  if ($oscuro) {
    [QmTabla]::Fondo = $script:Fondo
    [QmTabla]::Resalte = Mezclar $script:Fondo $script:Tinta 0.12
    [QmTabla]::Borde = Mezclar $script:Fondo $script:Tinta 0.22
  }
  # Ahora hay un menú POR ÍCONO, así que el tema se aplica a todos: con uno
  # solo actualizado, abrir otro ícono te daba el panel del tema anterior.
  foreach ($mn in @($script:Menus.Values)) { VestirMenu $mn $oscuro }
  return $true
}

function VestirMenu($mn, [bool]$oscuro) {
  if ($null -eq $mn) { return }
  $mn.BackColor = $script:Fondo
  $mn.ForeColor = $script:Tinta
  if ($oscuro) {
    $mn.Renderer = New-Object System.Windows.Forms.ToolStripProfessionalRenderer((New-Object QmTabla))
  } else {
    # De vuelta al de fábrica: la tabla oscura sobre un menú claro se ve
    # igual de mal que al revés.
    $mn.RenderMode = [System.Windows.Forms.ToolStripRenderMode]::ManagerRenderMode
  }
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

function CuentaRegresiva([double]$segundos) {
  # Como Dur, pero sin tirar los segundos abajo de la hora.
  #
  # Dur habla de duraciones que se REPORTAN —«reinicia en 2d14h»— y ahí los
  # segundos son ruido. Esto es un reloj que baja a la vista: si dijera sólo los
  # minutos cambiaría una vez por minuto, y una cuenta regresiva que no se mueve
  # no parece una cuenta regresiva, parece un número roto. Es cuenta_regresiva()
  # de bin/qm-indicator, y por eso NO entra en el gate de duraciones: es otra
  # escalera a propósito.
  $seg = [int][math]::Max(0, $segundos)
  if ($seg -ge 3600) { return (Dur $seg) }
  if ($seg -ge 60) { return ('{0}m {1:d2}s' -f [int][math]::Floor($seg / 60), ($seg % 60)) }
  return "${seg}s"
}

function CadaCuanto($historia) {
  # Cada cuánto se lee la cuota DE VERDAD, en segundos.
  #
  # No es la cadencia que este programa se propone: es la MEDIDA. El historial
  # se indexa por `medidoEn` —el instante que informa el servidor, no el momento
  # en que qm miró el disco— así que los huecos entre muestras son intervalos
  # entre lectura y lectura reales. Va la MEDIANA y no el promedio: una sola
  # pausa larga (la máquina suspendida) desplaza el promedio y no dice nada del
  # ritmo normal. Es cada_cuanto() de bin/qm-indicator.
  $ts = @(@($historia) | ForEach-Object { [double]$_.t } | Sort-Object)
  if ($ts.Count -lt 2) { return $null }
  $huecos = @()
  for ($i = 1; $i -lt $ts.Count; $i++) {
    $d = $ts[$i] - $ts[$i - 1]
    if ($d -gt 0) { $huecos += $d }
  }
  if (-not $huecos.Count) { return $null }
  $huecos = @($huecos | Sort-Object)
  return $huecos[[int][math]::Floor($huecos.Count / 2)] / 1000
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

function Reinicio($segundos) {
  # «reinicia en vencido» no es castellano. Cuando ya pasó, se dice que pasó.
  #
  # Es reinicio() de bin/qm-indicator. Se ve en cuanto se mira una captura con
  # una ventana ya reiniciada —el fixture tiene tres— y no se ve leyendo el
  # código, que es por lo que sobrevivió acá después de estar arreglado allá.
  if ($null -eq $segundos) { return '' }
  if ($segundos -lt 0) { return 'reinicio vencido' }
  return "reinicia en $(Dur $segundos)"
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
    # Una proyección con el techo en el PASADO ya no proyecta nada: se leía
    # «100 % en vencido», que no quiere decir nada. Cuando ya tocaste el techo
    # la pregunta es cuándo te liberás, y ésa la contesta la cabecera del panel.
    # Mismo criterio que VistaCuenta.ritmo en bin/qm-indicator.
    if ($null -eq $seg -or $seg -le 0) { return $null }
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

$script:Globos = @()

function Globo([string]$titulo, [string]$cuerpo, [bool]$urgente) {
  # No se muestra acá: se encola. Un globo necesita un item VISIBLE que lo
  # emita, y los items se crean después de dibujar —recién ahí se sabe cuántas
  # cuentas hay—. Mostrarlo en el momento perdía justo el aviso del primer
  # tick, que es el que llega cuando arrancás la máquina ya frenado.
  $script:Globos += @{ titulo = $titulo; cuerpo = $cuerpo; urgente = $urgente }
}

function Avisar([string]$clave, [string]$titulo, [string]$cuerpo, [bool]$urgente) {
  if ($script:Vistos.ContainsKey($clave)) { return }
  $script:Vistos[$clave] = $true
  try {
    $dir = Split-Path $script:RutaAvisos -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    ($script:Vistos.Keys | Sort-Object) | ConvertTo-Json | Set-Content $script:RutaAvisos -Encoding UTF8
  } catch { }
  Globo $titulo $cuerpo $urgente
}

# ── la memoria de la vuelta anterior ────────────────────────────────────
# Cuánto valía cada barra la última vez, para poder ver que se REINICIÓ.
#
# Un porcentaje solo no dice nada de eso: 3 % puede ser «recién empezás» o
# «acabás de salir de estar contra el techo», y la diferencia es justo lo que
# hay que avisar. Se guarda el minuto de reinicio junto al número: cuando el
# minuto cambia, la ventana es otra. Es Previos de bin/qm-indicator y
# previos.json de bin/qm-barra.swift, que era lo único de los avisos que la
# bandeja no tenía.

$script:RutaPrevios = Join-Path $env:LOCALAPPDATA 'quartermaster\previos.json'
$script:Previos = @{}
try {
  if (Test-Path $script:RutaPrevios) {
    $m = Get-Content $script:RutaPrevios -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($prop in $m.PSObject.Properties) { $script:Previos[$prop.Name] = @($prop.Value) }
  }
} catch { $script:Previos = @{} }   # sin memoria no se avisa de más: no se avisa

$script:PreviosSucio = $false

function GuardarPrevios {
  if (-not $script:PreviosSucio) { return }
  $script:PreviosSucio = $false
  try {
    $dir = Split-Path $script:RutaPrevios -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $script:Previos | ConvertTo-Json -Compress | Set-Content $script:RutaPrevios -Encoding UTF8
  } catch { }
}

function RevisarLiberada([string]$perfil, $v) {
  # El aviso que faltaba: YA PODÉS VOLVER A TRABAJAR.
  #
  # Todo lo demás avisa cuando subís. Éste avisa cuando la ventana se reinicia
  # habiendo estado contra el techo, que es el único momento en que la noticia
  # sirve para hacer algo distinto ahora mismo — y es justamente cuando dejaste
  # de mirar la barra, porque no había nada que mirar.
  #
  # No pasa por Avisar: la deduplicación de Avisar es para siempre, y acá la
  # condición ya es un FLANCO —sólo se cumple en la vuelta en que el minuto
  # cambia— así que anotarla en `avisados.json` la silenciaría para el próximo
  # reinicio, que es el que sí hay que avisar.
  $clave = "$perfil|$(NombreVentana $v)"
  $minuto = AlMinuto $v.reinicia
  $pct = [double]$v.porcentaje
  $antes = $script:Previos[$clave]
  $script:Previos[$clave] = @($minuto, $pct)
  $script:PreviosSucio = $true
  if ($null -eq $antes -or @($antes).Count -ne 2) { return }
  $minutoAntes = [string]@($antes)[0]
  $pctAntes = [double]@($antes)[1]
  # Ventana nueva, y en la anterior estabas contra el techo.
  if ($minuto -eq $minutoAntes -or $pctAntes -lt 80 -or $pct -ge $pctAntes) { return }
  Globo "${perfil}: se reinició $(NombreVentana $v)" `
    ("Estabas {0:d} % y ahora vas {1:d} %." -f [int][math]::Round($pctAntes), [int][math]::Round($pct)) `
    $false
}

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
# 6 de aire + 16 de curva + 12 para los rótulos de abajo, igual que
# VistaCuenta.ALTO_CURVA en Swift. Si esto no coincide con lo que dibuja
# DibujarPerfil, los rótulos se comen el renglón siguiente.
$ALTO_CURVA = 34
# El anillo (44) más el aire de arriba y abajo: el alto de VistaResumen.
$ALTO_RESUMEN = 74
# El renglón de «lecturas: cada ~5m · última hace 2m», que contesta «¿este
# número de cuándo es?» — una pregunta que un porcentaje no contesta.
$ALTO_LECTURAS = 15
# El renglón de «próxima lectura en 4m 12s», que va al pie del panel entero.
$ALTO_PIE = 20

function Px([double]$v) { return [float]($v * $script:Escala) }

# Un Bitmap, con las dimensiones acotadas a 1 px como PISO.
#
# GDI+ tira «Parameter is not valid» si una dimensión es 0 — comprobado: el
# constructor de Bitmap(340, 0) da exactamente ese texto— y esa excepción, en el
# hilo de la interfaz, es el cartel morado de .NET que mata la bandeja entera.
# Una bandeja muerta no deja ícono, y un ícono que no está se lee igual que una
# cuenta que va bien: el silencio otra vez.
#
# Un lienzo de 1 px no dibuja nada y se nota, pero es un renglón vacío y no una
# aplicación cerrada. Que un alto dé 0 sigue siendo un bug de medida, y lo
# agarra scripts/gate-bandeja.ps1, que mide los píxeles que salen.
function Lienzo($ancho, $alto) {
  return New-Object System.Drawing.Bitmap(
    [int][math]::Max(1, [math]::Round([double]$ancho)),
    [int][math]::Max(1, [math]::Round([double]$alto)))
}

function CrearFuentes {
  $f = { param($px, $estilo) New-Object System.Drawing.Font('Segoe UI', (Px $px), $estilo, [System.Drawing.GraphicsUnit]::Pixel) }
  $script:FTitulo = & $f 14 ([System.Drawing.FontStyle]::Bold)
  $script:FSub    = & $f 11 ([System.Drawing.FontStyle]::Regular)
  $script:FNombre = & $f 12 ([System.Drawing.FontStyle]::Regular)
  $script:FActiva = & $f 12 ([System.Drawing.FontStyle]::Bold)
  $script:FPct    = & $f 12 ([System.Drawing.FontStyle]::Bold)
  $script:FPie    = & $f 10 ([System.Drawing.FontStyle]::Regular)
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

# Escribe una línea. Con $ancho, la RECORTA con puntos suspensivos.
#
# GDI+ no recorta nada cuando se dibuja en un punto —igual que Cairo— así que un
# nombre de perfil más largo que la tarjeta se dibujaba por encima del borde y
# se salía del panel, y un nombre de ventana largo se metía por debajo del
# porcentaje de la derecha y quedaban los dos ilegibles. Se ve con el fixture de
# nombres largos y no se ve mirando el código, que es por lo que el panel de
# GNOME tiene un gate que mide los píxeles del margen en vez de confiar en el ojo.
function Escribir($g, [string]$t, [float]$x, [float]$y, $fuente, $color,
                  [float]$derecha = -1, [float]$ancho = -1) {
  if (-not $t) { return }
  $br = New-Object System.Drawing.SolidBrush($color)
  if ($derecha -ge 0) {
    $an = $g.MeasureString($t, $fuente).Width
    if ($ancho -gt 0 -and $an -gt $ancho) { $an = $ancho }
    $x = $derecha - $an
  }
  if ($ancho -gt 0) {
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
    $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
    # El alto de UNA línea, del tipo de letra y no del texto: MeasureString de
    # una cadena larga devuelve el alto que ocuparía envuelta, y con eso la caja
    # dejaba de ser de una línea justo en el caso que hay que recortar.
    $caja = New-Object System.Drawing.RectangleF($x, $y, $ancho, $fuente.GetHeight($g))
    $g.DrawString($t, $fuente, $br, $caja, $fmt)
    $fmt.Dispose()
  } else {
    $g.DrawString($t, $fuente, $br, $x, $y)
  }
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

# «lecturas: cada ~5m · última hace 2m».
#
# La pregunta «¿este número de cuándo es?» no la contesta un porcentaje, y la
# edad del cache sola tampoco: «hace 40 minutos» es tranquilizador si se lee
# cada hora y alarmante si se lee cada cinco minutos. Las dos juntas sí. Es
# VistaCuenta.lecturas de bin/qm-indicator.
function FraseLecturas($cuota) {
  if ($cuota.estado -ne 'ok') { return $null }
  $partes = @()
  $cada = CadaCuanto $cuota.historia
  if ($null -ne $cada) { $partes += "cada ~$(Dur ([int]$cada))" }
  if ($cuota.PSObject.Properties['edadSegundos'] -and $null -ne $cuota.edadSegundos) {
    $e = [int]$cuota.edadSegundos
    $partes += "última hace $(Dur $e)" + $(if ($e -ge $VIEJO_SEGUNDOS) { ' · viejo' } else { '' })
  }
  if (-not $partes.Count) { return $null }
  return 'lecturas:  ' + ($partes -join '   ·   ')
}

function AltoPerfil($p) {
  $alto = (Px $MARGEN) + (Px $ALTO_CABECERA)
  $cuota = $p.cuota
  $alto += (Px $ALTO_BARRA) * (@($cuota.mostrar)).Count
  # La curva es de la barra que frena, así que suma una vez y no por barra.
  if ((@($cuota.historia)).Count -ge 3) { $alto += (Px $ALTO_CURVA) }
  if (FraseRitmo $p.proyeccion) { $alto += (Px $ALTO_RITMO) }
  if (FraseLecturas $cuota) { $alto += (Px $ALTO_LECTURAS) }
  return [int]($alto + (Px 10))
}

function DibujarPerfil($p, [int]$indice) {
  $ancho = [int](Px $ANCHO_VISTA)
  $alto = AltoPerfil $p
  $bmp = Lienzo $ancho $alto
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
  $anchoCabecera = $der - $m - (Px 19)
  Escribir $g (Corto $p.perfil) ($m + (Px 19)) $y $script:FTitulo $script:Tinta -1 $anchoCabecera
  $y += Px 17

  $partes = @()
  if ($p.cuenta) { $partes += $p.cuenta }
  if ($p.plan) { $partes += $p.plan }
  Escribir $g ($partes -join '  ·  ') ($m + (Px 19)) $y $script:FSub $script:Tinta3 -1 $anchoCabecera
  $y += Px 22

  # Acá sólo llegan cuentas CON número: las mudas van a DibujarSinCuota, que
  # las junta en una tarjeta sola. Esta función tenía una rama para dibujarles
  # la frase y quedó muerta con ese cambio; se saca en vez de dejarla, porque
  # una rama que no se ejecuta es una rama que nadie va a notar cuando se rompa.
  $cuota = $p.cuota
  $peor = $cuota.frena
  $chocas = [bool]($p.proyeccion -and $p.proyeccion.estado -eq 'sube' -and $p.proyeccion.chocasAntesDelReinicio)

  foreach ($v in @($cuota.mostrar)) {
    $esPeor = ($null -ne $peor -and $v.clave -eq $peor.clave -and $v.alcance -eq $peor.alcance)
    $nivel = NivelDe ([int]$v.porcentaje) ([bool]($v.preocupa -or ($chocas -and $esPeor)))
    $activa = [bool]$v.activa

    $nombre = if ($activa) { (NombreVentana $v) + '  ▸' } else { NombreVentana $v }
    # El porcentaje se dibuja PRIMERO —es lo que se viene a leer— y el nombre se
    # recorta contra el hueco que dejó. Al revés, un nombre de ventana largo se
    # metía por debajo del número y quedaban los dos ilegibles.
    $cifra = '{0:d}%' -f [int][math]::Round($v.porcentaje)
    Escribir $g $cifra 0 $y $script:FPct $script:Tinta $der
    $anchoNombre = $der - $m - $g.MeasureString($cifra, $script:FPct).Width - (Px 8)
    Escribir $g $nombre $m $y $(if ($activa) { $script:FActiva } else { $script:FNombre }) `
      $(if ($activa) { $script:Tinta } else { $script:Tinta2 }) -1 $anchoNombre
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

    # La edad del cache ya NO va acá: se mudó al renglón de «lecturas», abajo,
    # donde va acompañada de cada cuánto se lee. Sola decía la mitad —«hace
    # 40 m» es tranquilizador si se lee cada hora y alarmante si se lee cada
    # cinco minutos— y encima la repetía una vez por perfil en el renglón de
    # una barra que no es la suya.
    Escribir $g (Reinicio (Faltan $v.reinicia)) $m $y $script:FPie $script:Tinta3
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
    Escribir $g $ritmo $m $y $script:FPie `
      $(if ($chocas) { $PALETA['critico'] } else { $script:Tinta3 }) -1 ($der - $m)
    $y += Px $ALTO_RITMO
  }

  $lecturas = FraseLecturas $cuota
  if ($lecturas) {
    Escribir $g $lecturas $m $y $script:FPie $script:Tinta3 -1 ($der - $m)
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
  $bmp = Lienzo $ancho $alto
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
  $der = $ancho - $m
  Escribir $g 'LO PRIMERO QUE TE FRENA' $x (Px 11) $script:FRotulo $script:Tinta3 -1 ($der - $x)
  $cifra = '{0:d}%' -f $pct
  Escribir $g $cifra $x (Px 22) $script:FCifra $script:Tinta
  # El nombre va a la derecha de la cifra, apoyado en su misma línea de base, y
  # recortado contra el margen: es el texto más largo del panel —perfil más
  # ventana— y era el que primero se salía.
  $xNombre = $x + $g.MeasureString($cifra, $script:FCifra).Width
  Escribir $g ('  {0} · {1}' -f (Corto $mejorP.perfil), (NombreVentana $mejor)) `
    $xNombre (Px 30) $script:FSub $script:Tinta2 -1 ($der - $xNombre)

  # Cuando ya te frenó, lo que importa no es cuándo «reinicia»: es cuándo
  # volvés a poder trabajar. Es la misma fecha y una pregunta distinta.
  $seg = Faltan $mejor.reinicia
  $texto = if ($pct -ge 95 -and $null -ne $seg -and $seg -gt 0) { "libre en $(Dur $seg)" }
    elseif ($null -ne $seg) { Reinicio $seg }
    else { 'sin reinicio informado' }
  Escribir $g $texto $x (Px 50) $script:FPie $(if ($pct -ge 95) { $c } else { $script:Tinta3 })

  $g.Dispose()
  return $bmp
}

# Las cuentas que no dejaron número, JUNTAS en una tarjeta.
#
# Es VistaSinCuota de bin/qm-indicator. Antes cada perfil mudo se llevaba una
# tarjeta entera de 340 px para decir una línea, y con cuatro perfiles el panel
# se iba de pantalla mostrando sobre todo lo que NO se sabe. La respuesta a
# «¿por qué esta cuenta no tiene número?» es una frase corta, y cuatro frases
# cortas son una lista, no cuatro tarjetas.
#
# Ojo: esto agrupa el PANEL solamente. En la bandeja cada perfil mudo conserva
# su propio item, y eso es a propósito — está explicado en Refrescar.
function DibujarSinCuota($calladas) {
  $cal = @($calladas)
  if (-not $cal.Count) { return $null }

  $ancho = [int](Px $ANCHO_VISTA)
  $m = Px $MARGEN
  $der = $ancho - $m

  # Medir antes de dibujar: el alto depende de cuántas líneas ocupa cada frase.
  $medidor = New-Object System.Drawing.Bitmap(1, 1)
  $gm = [System.Drawing.Graphics]::FromImage($medidor)
  $altos = @()
  foreach ($c in $cal) {
    $an = $der - $m - (Px 84)
    $altos += [math]::Max((Px 15), $gm.MeasureString($c.frase, $script:FPie, [int]$an).Height)
  }
  $gm.Dispose(); $medidor.Dispose()

  $alto = [int]((Px $MARGEN) + (Px 15) + ($altos | Measure-Object -Sum).Sum + (Px ($cal.Count * 5)) + (Px 10))
  $bmp = Lienzo $ancho $alto
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($script:Fondo)

  $y = Px $MARGEN
  Escribir $g 'SIN NÚMERO' $m $y $script:FRotulo $script:Tinta3
  $y += Px 15

  for ($i = 0; $i -lt $cal.Count; $i++) {
    $c = $cal[$i]
    Escribir $g $c.nombre $m $y $script:FNombre $script:Tinta2 -1 (Px 78)
    $caja = New-Object System.Drawing.RectangleF(
      ($m + (Px 84)), $y, ($der - $m - (Px 84)), $altos[$i])
    $br = New-Object System.Drawing.SolidBrush($script:Tinta3)
    $g.DrawString($c.frase, $script:FPie, $br, $caja)
    $br.Dispose()
    $y += $altos[$i] + (Px 5)
  }

  $g.Dispose()
  return $bmp
}

# El pie del panel: CUÁNDO DEJA DE SER CIERTO ESTE NÚMERO.
#
# Cada cuenta dice de cuándo es su número; esto dice cuándo deja de serlo. Es
# la otra mitad de la misma pregunta, y es el renglón que baja solo mientras el
# panel está abierto — por eso se dibuja aparte y no adentro de una tarjeta.
function DibujarPieLectura([double]$falta) {
  $ancho = [int](Px $ANCHO_VISTA)
  $alto = [int](Px $ALTO_PIE)
  $bmp = Lienzo $ancho $alto
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($script:Fondo)
  Escribir $g "próxima lectura en $(CuentaRegresiva $falta)" (Px $MARGEN) (Px 4) `
    $script:FPie $script:Tinta3
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
# en el tooltip. Y arriba de todos, el general, que dice lo de la máquina entera
# con la marca — incluso cuando qm no contesta y es el único que queda.
#
# La pista es gris al 41 % de alfa a propósito: la barra de tareas puede ser
# clara u oscura y el ícono no se entera, así que un gris translúcido es lo
# único que se ve en las dos.

# El ícono general: la marca de quartermaster, que ya es un medidor.
#
# El logo (docs/logo-mono.svg) es un anillo INCOMPLETO con una cola en diagonal
# —un manómetro—, así que la marca y el medidor son el mismo dibujo: el arco se
# llena hasta el peor porcentaje de la máquina y se pinta con el color de ese
# estado, y la cola va siempre porque es lo que hace que se lea como la marca y
# no como un donut más. Un logo que nunca cambia de color sería una marca y no
# un indicador, y en una bandeja el ícono tiene que decir algo de un vistazo.
#
# Las medidas salen del SVG, que está en un viewBox de 64: centro (32,32),
# radio 20, trazo 9, cola de (41,41) a (51.5,51.5). Acá se dibuja a 32 px, o
# sea la mitad de todo.
function IconoGeneral([double]$pct, [string]$nivel) {
  $lado = 32
  $k = $lado / 64.0
  $bmp = Lienzo $lado $lado
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $grosor = [float](9 * $k)
  $r = 20 * $k
  $c = 32 * $k
  $caja = New-Object System.Drawing.RectangleF(($c - $r), ($c - $r), (2 * $r), (2 * $r))

  # La pista, igual que en el logo: el mismo trazo al 20 %. Gris y no del color
  # del estado, porque la barra de tareas puede ser clara u oscura.
  $lapPista = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(105, 128, 128, 128), $grosor)
  $g.DrawEllipse($lapPista, $caja)

  $col = $PALETA[$nivel]
  $lap = New-Object System.Drawing.Pen($col, $grosor)
  $lap.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $lap.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  # El logo abre el anillo a los 240°, así que el medidor llena ESE recorrido y
  # no los 360: el hueco de arriba a la izquierda es parte de la marca.
  $barrido = [float]([math]::Max(4, [math]::Min(240, $pct * 2.4)))
  $g.DrawArc($lap, $caja, -90, $barrido)

  # La cola, que es lo que distingue la marca de un anillo cualquiera.
  $g.DrawLine($lap, [float](41 * $k), [float](41 * $k), [float](51.5 * $k), [float](51.5 * $k))

  $h = $bmp.GetHicon()
  $ico = [System.Drawing.Icon]::FromHandle($h)
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
  $bmp = Lienzo $lado $lado
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

  # El JSON de un archivo en vez del de qm. Acá se LEVANTA si no se puede leer,
  # al revés que todo lo demás en esta función: una frase se dibujaría como un
  # panel de una línea y el gate la mediría como si fuera un panel válido, que
  # es exactamente la falla que el gate tiene que encontrar. Mismo criterio que
  # leer_desde() en bin/qm-indicator.
  if ($Desde) {
    $texto = [System.IO.File]::ReadAllText($Desde, [System.Text.Encoding]::UTF8)
    return ($texto | ConvertFrom-Json)
  }

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

# ── «el número está, pero no se ve» ─────────────────────────────────────
# Windows decide POR ÍCONO si va a la barra o al desplegable de escondidos, y a
# los nuevos los manda al desplegable. Eso ya estaba dicho en el README como el
# costo de la tira; lo que faltaba es que se enterara el usuario. Un ícono que
# Windows escondió y un ícono que no arrancó se ven exactamente igual: nada. Es
# la misma clase de silencio que motivó el repo, y macOS ya la cubre por el otro
# lado con revisarSiSeVe() —la barra llena y la muesca— en bin/qm-barra.swift.
#
# Se puede MEDIR y no hay que suponerlo: cada item vive en
# HKCU\Control Panel\NotifyIconSettings con su UID y un `IsPromoted` que vale 1
# si está en la barra. El UID lo reparte WinForms y lo guarda en un campo
# privado, así que se lee por reflexión — el mismo camino que ya se usa para
# ShowContextMenu, y por la misma razón.
$script:AvisoEscondido = $false
$script:CampoUid = [System.Windows.Forms.NotifyIcon].GetField(
  'id', [System.Reflection.BindingFlags]'Instance,NonPublic')

function RevisarSiSeVe {
  # Una sola vez por corrida: un ícono que el usuario esconde y muestra no tiene
  # que avisar en cada vuelta. Es la misma decisión que `avisoBarraLlena` en
  # Swift, y por el mismo motivo — ahí se tomó después de que avisara en bucle.
  if ($script:AvisoEscondido -or $null -eq $script:CampoUid) { return }
  if (-not $script:Bandeja.Count) { return }

  $uids = @()
  foreach ($ni in @($script:Bandeja.Values)) {
    try { $uids += [int]$script:CampoUid.GetValue($ni) } catch { }
  }
  if (-not $uids.Count) { return }

  # La clave guarda la ruta con un GUID de carpeta conocida adelante
  # ({1AC14E77-...}\WindowsPowerShell\v1.0\powershell.exe), así que se compara
  # por el nombre del ejecutable y se desempata por UID.
  try {
    $exe = [System.IO.Path]::GetFileName(
      [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)
  } catch { return }

  $vistos = 0; $promovidos = 0
  try {
    foreach ($k in (Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction Stop)) {
      $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $p) { continue }
      if (-not $p.PSObject.Properties['ExecutablePath']) { continue }
      if (-not $p.PSObject.Properties['UID']) { continue }
      if (([string]$p.ExecutablePath) -notlike "*\$exe") { continue }
      if ($uids -notcontains [int]$p.UID) { continue }
      $vistos++
      if ($p.PSObject.Properties['IsPromoted'] -and [int]$p.IsPromoted -eq 1) { $promovidos++ }
    }
  } catch { return }

  # Cero vistos no es «está escondido», es «Windows todavía no los anotó»: se
  # vuelve a mirar en la vuelta siguiente en vez de avisar de algo que no se sabe.
  if ($vistos -eq 0 -or $promovidos -gt 0) { return }
  $script:AvisoEscondido = $true
  Globo 'quartermaster' `
    ('el número está, pero Windows dejó los íconos en el desplegable de ' +
     'escondidos: arrastrá uno a la barra de tareas y se queda ahí. ' +
     'Mientras tanto el panel se abre desde el desplegable.') $false
}

# ── cuando el archivo cambia debajo ─────────────────────────────────────
# `git pull`, `apt upgrade` y `npm update` reemplazan los archivos y se van; el
# proceso que ya está corriendo tiene el guión LEÍDO y sigue igual hasta que
# alguien lo reinicie a mano — que no lo hace nadie, porque la bandeja es
# justamente lo que se deja andando y se olvida. Es vigilar_version() de
# bin/qm-indicator.
#
# Va por sondeo y NO por FileSystemWatcher, al revés que la versión de GNOME.
# Es la misma razón que explica el encabezado de este archivo: el guión puede
# estar del otro lado del 9P de WSL —\\wsl.localhost\...— donde FileSystemWatcher
# no es confiable. Y acá no cuesta nada: ya hay un tick cada 30 s.
$script:Yo = $PSCommandPath
$script:SelloYo = $null
try { $script:SelloYo = (Get-Item $script:Yo).LastWriteTimeUtc } catch { }

function RevisarVersion {
  if ($SinAutoReinicio) { return }
  if (-not $script:Yo -or $null -eq $script:SelloYo) { return }
  try { $ahora = (Get-Item $script:Yo -ErrorAction Stop).LastWriteTimeUtc } catch { return }
  if ($ahora -eq $script:SelloYo) { return }

  # Compila antes de saltar. Si la versión nueva está rota, reiniciar deja al
  # usuario SIN bandeja; quedarse con la vieja lo deja con una que anda. Entre
  # las dos, la que anda. Es la misma decisión que _reiniciar() en Python, y de
  # paso resuelve gratis el otro problema: un gestor de paquetes escribe en
  # varios pasos, y un archivo a medio escribir no parsea, así que esto es
  # también la espera a que la escritura termine.
  $errores = $null
  try {
    [System.Management.Automation.Language.Parser]::ParseFile(
      $script:Yo, [ref]$null, [ref]$errores) | Out-Null
  } catch { return }
  if ($errores -and $errores.Count) {
    # No se anota el sello: se vuelve a probar en la vuelta siguiente, que es
    # cuando el gestor de paquetes terminó de escribir.
    return
  }

  $script:SelloYo = $ahora
  try {
    $exe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  } catch { return }
  # `$args` no: es una variable automática de PowerShell y pisarla adentro de una
  # función es la clase de colisión silenciosa que este archivo ya tuvo dos veces.
  $lanzar = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
              '-File', $script:Yo) + $script:MisArgs
  # El candado se suelta ANTES de lanzar: si no, la instancia nueva se encuentra
  # el nombre tomado por la vieja y se va enseguida, y el usuario se queda sin
  # bandeja — que es justo lo que las dos protecciones quieren evitar.
  SoltarCandado
  try {
    Start-Process -FilePath $exe -ArgumentList $lanzar -WindowStyle Hidden | Out-Null
  } catch {
    return   # el candado ya se soltó, pero seguimos siendo la única viva
  }
  $script:Ctx.ExitThread()
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
  # La señal de que está pasando algo, en el item que se apretó. Se pone en
  # TODOS los menús y no sólo en el visible: el calentado es uno para toda la
  # máquina, así que abrir otro ícono mientras corre tiene que mostrar lo mismo.
  foreach ($mn in @($script:Menus.Values)) {
    foreach ($it in @($mn.Items)) {
      if ($it -is [System.Windows.Forms.ToolStripMenuItem] -and $it.Text -eq $ETIQUETA_ACTUALIZAR) {
        $it.Text = 'Actualizando…'
        $it.Enabled = $false
      }
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

# ── el pie que baja solo ────────────────────────────────────────────────
# Cada cuenta dice de cuándo es su número; el pie dice cuándo deja de serlo.
#
# El panel de Windows se rehace entero cada 30 s, así que un número acá se
# quedaría quieto medio minuto y después daría un salto — y una cuenta regresiva
# que no se mueve no parece una cuenta regresiva, parece un número roto. Se
# redibuja SÓLO este renglón una vez por segundo, y sólo mientras el panel está
# abierto: el resto del panel no cambió, así que no hay nada más que rehacer.
# Es la misma decisión que _tic() en bin/qm-indicator.
# El mapa de bits del pie es UNO y lo comparten todos los menús —el mismo Image
# se puede mostrar en varios PictureBox— así que el latido lo redibuja una vez
# por segundo y no una vez por menú abierto.
$script:PbPies = @()
$script:BmpPie = $null
$script:Latido = $null

function FaltaParaLectura {
  # Segundos hasta el próximo calentado, o $null si no hay uno previsto.
  if ($SinCalentar) { return $null }
  if ($script:UltimoCalentar -eq [datetime]::MinValue) { return $null }
  $falta = (Cadencia) - ((Get-Date) - $script:UltimoCalentar).TotalSeconds
  return [math]::Max(0, $falta)
}

# El pie se dibuja UNA vez por vuelta y lo comparten todos los menús.
#
# Antes lo creaba ArmarMenu, o sea una vez POR MENÚ, y cada llamada liberaba el
# bitmap anterior — el que el menú de la vuelta anterior acababa de recibir. Con
# cuatro íconos, tres de los cuatro pies quedaban apuntando a una imagen muerta:
# el renglón salía en blanco y, al repintarse, GDI+ tiraba «Parameter is not
# valid». Es el mismo error de razonamiento que el de las tarjetas —liberar algo
# que todavía tiene dueños— cometido dos veces en el mismo archivo.
#
# Ahora el dueño es uno solo: Refrescar lo crea, ArmarMenu lo usa, y el viejo se
# libera con las tarjetas viejas, al final, cuando ya no lo mira nadie.
function LatirPie {
  if (-not $script:PbPies.Count) { return }
  $falta = FaltaParaLectura
  if ($null -eq $falta) { return }
  $antes = $script:BmpPie
  $script:BmpPie = DibujarPieLectura $falta
  foreach ($pb in @($script:PbPies)) { try { $pb.Image = $script:BmpPie } catch { } }
  if ($antes) { try { $antes.Dispose() } catch { } }
}

function ItemTexto([string]$t) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($t)
  $it.Enabled = $false
  # Un item deshabilitado se pinta con el gris del sistema, que sobre fondo
  # oscuro no se lee. Y es justo el item que lleva la frase del problema.
  $it.ForeColor = $script:Tinta2
  return $it
}

# Recorre TODAS las ventanas visibles, no sólo la que frena.
#
# Antes esto recibía una sola ventana —`frena`— y ahí se perdían avisos: `peor()`
# en src/core/tipos.ts devuelve la más alta, así que con la sesión al 96 % y una
# semanal al 85 % la bandeja avisaba de la sesión y de la semanal no decía nada.
# Las otras dos siempre recorrieron la lista (revisarAvisos en qm-barra.swift,
# revisar_avisos en qm-indicator); ésta era la que se había quedado corta, y es
# justo lo contrario del principio de SOUL.md que dice leer todas las barras.
function RevisarAvisos([string]$perfil, $ventanas, $frena, $proy, [bool]$chocas) {
  foreach ($v in @($ventanas)) {
    $nombre = NombreVentana $v
    $minuto = AlMinuto $v.reinicia
    $base = "$perfil|$nombre|$minuto"
    $pct = [double]$v.porcentaje
    foreach ($u in $UMBRALES) {
      if ($pct -ge $u) {
        $seg = Faltan $v.reinicia
        $cola = if ($null -ne $seg) { " Se reinicia en $(Dur $seg)." } else { '' }
        Avisar "$base|$u" ("{0}: {1:d}% de {2}" -f $perfil, [int][math]::Round($pct), $nombre) `
          "Pasaste el $u%.$cola" ($u -ge 95)
      }
    }
    RevisarLiberada $perfil $v
  }

  if ($chocas -and $proy -and $null -ne $frena) {
    $base = "$perfil|$(NombreVentana $frena)|$(AlMinuto $frena.reinicia)"
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
    if ($script:Bandeja.Contains($t.clave)) {
      $ni = $script:Bandeja[$t.clave]
    } else {
      $ni = New-Object System.Windows.Forms.NotifyIcon
      $ni.Add_MouseUp($script:AbrirMenu)
      $ni.Visible = $true
      $script:Bandeja[$t.clave] = $ni
    }
    # Cada ícono abre SU panel: el general muestra todas las cuentas y el de
    # una cuenta muestra esa sola. Antes todos compartían un único menú, así
    # que con cuatro íconos en la barra los cuatro abrían la misma pantalla y
    # el ícono que clickeabas no quería decir nada.
    $ni.ContextMenuStrip = $script:Menus[$t.clave]
    $anterior = $ni.Icon
    $ni.Icon = $t.icono
    if ($anterior) { $anterior.Dispose() }
    # NotifyIcon.Text no acepta más de 63 caracteres.
    $texto = [string]$t.texto
    if ($texto.Length -gt 63) { $texto = $texto.Substring(0, 60) + '...' }
    $ni.Text = $texto
  }

  foreach ($clave in @($script:Bandeja.Keys)) {
    if ($vivas -contains $clave) { continue }
    $ni = $script:Bandeja[$clave]
    $ni.Visible = $false
    if ($ni.Icon) { $ni.Icon.Dispose() }
    $ni.Dispose()
    $script:Bandeja.Remove($clave)
  }
  # El que emite los globos. Tiene que estar visible; se prefiere el general
  # porque es el que habla de la máquina entera, y si no está, el primero.
  $script:Ni = $null
  if ($script:Bandeja.Contains('general')) { $script:Ni = $script:Bandeja['general'] }
  elseif ($script:Bandeja.Count) { $script:Ni = @($script:Bandeja.Values)[0] }
}

# Un menú por clave, creado cuando hace falta.
#
# Todos comparten los handlers: se arman una sola vez y se enganchan acá, en vez
# de repetir los bloques por menú — que es como se consiguen tres menús que se
# comportan distinto sin que nadie lo haya decidido.
function MenuDe([string]$clave) {
  if ($script:Menus.Contains($clave)) { return $script:Menus[$clave] }
  $mn = New-Object System.Windows.Forms.ContextMenuStrip
  # Sin esto el menú reserva una canaleta a la izquierda para tildes e íconos,
  # y el dibujo queda corrido y con un escalón que no es parte del diseño.
  $mn.ShowImageMargin = $false
  $mn.ShowCheckMargin = $false
  $mn.Add_ItemClicked($script:AlClickear)
  $mn.Add_Closing($script:AlCerrar)
  $mn.Add_Opened($script:AlAbrir)
  $mn.Add_Closed($script:AlCerrado)
  VestirMenu $mn ([bool]$script:MenuOscuro)
  $script:Menus[$clave] = $mn
  return $mn
}

# Llena un menú: las tarjetas que le tocan, el pie y los tres botones.
#
# Es la MISMA función para el panel general y para el de una cuenta: lo único
# que cambia es la lista de tarjetas que recibe. Con una función por caso, la
# de la cuenta sola se hubiera quedado sin el pie y sin «Actualizar ahora» la
# primera vez que alguien tocara una de las dos.
function ArmarMenu($mn, $piezas, [string]$frase) {
  # Si el panel está abierto —«Actualizar ahora» lo deja así— hay que suspender
  # el layout mientras se cambian los items. Sin esto, cada Add() relayoutea y
  # reposiciona el menú visible: se ve saltar de tamaño una vez por sección.
  $abierto = $false
  try { $abierto = $mn.Visible } catch { $abierto = $false }
  if ($abierto) { $mn.SuspendLayout() }

  # Items.Clear() saca los items de la lista pero no los libera, y acá se
  # reconstruye el menú entero cada tick.
  foreach ($viejo in @($mn.Items)) { $viejo.Dispose() }
  $mn.Items.Clear()

  if ($frase) {
    # Silencio es el bug: si no hay número, hay una frase.
    $mn.Items.Add((ItemTexto $frase)) | Out-Null
  } else {
    foreach ($b in @($piezas)) {
      $mn.Items.Add((FilaImagen $b)) | Out-Null
      $mn.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    }
  }

  # El pie va después de las tarjetas y antes de los botones, igual que en el
  # panel de GNOME. Su mapa de bits lo comparten todos los menús y lo reemplaza
  # el latido una vez por segundo, así que NO entra en $script:Bitmaps.
  if ($script:BmpPie) {
    $filaPie = FilaImagen $script:BmpPie
    $script:PbPies += $filaPie.Control
    $mn.Items.Add($filaPie) | Out-Null
  }

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
    $mn.Items.Add($it) | Out-Null
  }

  if ($abierto) {
    $mn.ResumeLayout($true)
    # El panel cambió de alto, así que hay que reacomodarlo: sin esto se queda
    # con el tamaño de antes y recorta la última sección.
    $mn.PerformLayout()
  }
}

# ¿Va este ícono en la bandeja? Lo decide -Iconos; vacío quiere decir todos.
function QuieroIcono([string]$clave) {
  if (-not $script:BandejaPedidos.Count) { return $true }
  return ($script:BandejaPedidos -contains $clave.ToLower())
}

# El modelo del panel: qué tarjetas van en cada ícono.
#
# Es modelo_panel() de bin/qm-indicator y existe por la misma razón: dibujar y
# decidir-qué-dibujar son dos cosas, y el gate necesita la segunda sin bandeja.
# Devuelve las tarjetas por clave, las frases de las cuentas mudas y la tira.
#
# Con $avisar en $false no notifica ni toca la cadencia: el modo captura arma
# exactamente el mismo panel sin mandarle un globo a nadie.
function ModeloPaneles($datos, [bool]$avisar) {
  $paneles = [ordered]@{}
  $frases = @{}
  $tira = @()
  $bitmaps = @()

  if ($datos -is [string]) {
    # Sin datos no hay cuentas: queda el general solo, con el arco vacío.
    $paneles['general'] = @()
    $frases['general'] = $datos
    $tira += @{ clave = 'general'; icono = (IconoGeneral 0 'atento'); texto = "qm · $datos" }
    return @{ paneles = $paneles; frases = $frases; tira = $tira; bitmaps = $bitmaps }
  }

  $pico = 0.0
  $alTecho = $null
  $mueven = @()
  $general = @()

  $resumen = DibujarResumen $datos.perfiles
  if ($resumen) { $bitmaps += $resumen; $general += $resumen }

  # El índice del color de cuenta avanza sólo con las que dejaron número, igual
  # que iCuenta en qm-barra.swift: una cuenta muda no gasta un color, así que
  # las que se ven conservan el suyo de una lectura a la otra.
  $iCuenta = 0
  $calladas = @()
  foreach ($p in $datos.perfiles) {
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
      # En el PANEL general las mudas van juntas al final, en una sola tarjeta:
      # una tarjeta de 340 px por frase corta llenaba la pantalla de lo que NO
      # se sabe. En su panel propio va la frase sola, que es la respuesta
      # completa a por qué no hay número.
      $calladas += @{ nombre = $nombre; frase = $frase }
      # Su panel propio es la MISMA tarjeta que le toca en el general, con ella
      # sola adentro: así el menú y la captura dibujan lo mismo, que es la única
      # forma de que el gate esté comprobando lo que el usuario ve. Va aparte y
      # no reusa la tarjeta agrupada porque esa lleva las demás cuentas.
      $suya = DibujarSinCuota @(@{ nombre = $nombre; frase = $frase })
      $bitmaps += $suya
      $paneles[$nombre] = @($suya)
      $tira += @{
        clave = $nombre
        icono = (IconoCuenta $p.producto $colorCuenta $null 'ok')
        texto = "$nombre · $frase"
      }
      continue
    }

    $bmp = DibujarPerfil $p $iCuenta
    $bitmaps += $bmp
    $general += $bmp
    $paneles[$nombre] = @($bmp)
    $iCuenta++

    $peor = $cuota.frena
    $proy = $p.proyeccion
    $chocas = [bool]($proy -and $proy.estado -eq 'sube' -and $proy.chocasAntesDelReinicio)
    $viejo = if ($cuota.edadSegundos -gt $VIEJO_SEGUNDOS) { '~' } else { '' }

    # El medidor es SIEMPRE la semanal; el número de la sesión —que en macOS va
    # al lado del medidor— acá no tiene dónde ir y se va al tooltip.
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
      clave = $nombre
      icono = (IconoCuenta $p.producto $colorCuenta `
          $(if ($null -ne $sem) { [int]$sem.porcentaje } else { $null }) $nivelSem)
      texto = ($partes -join ' · ')
    }

    if ($avisar) { RevisarAvisos $nombre $cuota.mostrar $peor $proy $chocas }
    if ($null -ne $peor) {
      $pct = [double]$peor.porcentaje
      if ($pct -ge 40) { $mueven += $nombre }
      if ($pct -gt $pico) { $pico = $pct }
    }
    if ($chocas) {
      $seg = Faltan $proy.techo
      if ($null -ne $seg) {
        $min = $seg / 60
        if ($null -eq $alTecho -or $min -lt $alTecho) { $alTecho = $min }
      }
    }
  }

  # Las mudas, todas juntas y al final del panel general: lo que no se sabe va
  # después de lo que sí.
  $sin = DibujarSinCuota $calladas
  if ($sin) { $bitmaps += $sin; $general += $sin }

  if ($avisar) {
    $script:Alto = $pico
    $script:CuentasQueMueven = $mueven
    $script:MinutosAlTecho = $alTecho
  }

  # El general va PRIMERO en la tira: Windows ordena los íconos por orden de
  # registro, así que éste es el orden en que aparecen, y el de la máquina
  # entera es el que uno busca cuando no sabe qué cuenta mirar.
  $nivelPico = NivelDe ([int][math]::Round($pico)) ([bool]($null -ne $alTecho))
  $paneles.Insert(0, 'general', $general)
  $tira = @(@{
      clave = 'general'
      icono = (IconoGeneral $pico $nivelPico)
      texto = ('quartermaster · {0} cuenta(s) · lo peor {1:d}%' -f $iCuenta, [int][math]::Round($pico))
    }) + $tira
  if (-not $general.Count) { $frases['general'] = 'qm no encontró ningún perfil' }

  return @{ paneles = $paneles; frases = $frases; tira = $tira; bitmaps = $bitmaps }
}

function Refrescar {
  $datos = Leer
  # Los dos temas, que son dos claves distintas del registro y pueden no
  # coincidir. Si el de las apps cambió, AplicarTema rehace la paleta y vuelve a
  # vestir todos los menús; se redibujan igual acá abajo.
  $null = AplicarTema
  $script:BarraOscura = BarraOscura

  # Los mapas de bits del tick anterior se APARTAN acá y se liberan al final,
  # cuando ya no los mira nadie.
  #
  # Un PictureBox no libera su Image al morir, así que hay que soltarlos a mano
  # — pero soltarlos ACÁ fue un crash: entre este renglón y el ArmarMenu de más
  # abajo, los PictureBox de los menús siguen apuntando a los Bitmap viejos, y
  # si en ese hueco entra un repintado, GDI+ tira «Parameter is not valid» y
  # WinForms le muestra al usuario el cartel de excepción no manejada. El
  # original no tenía el problema porque liberaba los items del menú PRIMERO y
  # los bitmaps después; el refactor a varios menús invirtió el orden, y con N
  # menús compartiendo la misma tarjeta el hueco es más ancho todavía.
  #
  # Es el mismo cuidado que hay que tener con el pie del panel, aplicado donde
  # hacía falta: primero se dibuja lo nuevo, después se suelta lo viejo.
  $bitmapsViejos = @($script:Bitmaps)
  if ($script:BmpPie) { $bitmapsViejos += $script:BmpPie }
  $script:BmpPie = $null
  $script:Bitmaps = @()
  $script:PbPies = @()

  $m = ModeloPaneles $datos $true
  $script:Bitmaps = $m.bitmaps
  $paneles = $m.paneles
  $frases = $m.frases

  # El filtro de -Iconos. Se aplica a la TIRA y no a los paneles: el panel
  # general sigue mostrando todas las cuentas aunque no tengan ícono propio.
  $tira = @($m.tira | Where-Object { QuieroIcono $_.clave })
  if (-not $tira.Count) {
    # Una bandeja vacía es el silencio otra vez, y acá sería un silencio que se
    # causó el usuario con un -Iconos que no coincide con nada. Queda el general
    # y se dice por qué.
    $tira = @(@{ clave = 'general'; icono = (IconoGeneral 0 'atento')
                 texto = 'quartermaster · -Iconos no coincidió con ninguna cuenta' })
    if (-not $paneles.Contains('general')) { $paneles['general'] = @() }
  }

  # El pie, uno solo para todos los menús. Va antes de armarlos porque
  # ArmarMenu lo consume.
  $falta = FaltaParaLectura
  if ($null -ne $falta) { $script:BmpPie = DibujarPieLectura $falta }

  # Los menús: uno por ícono que quedó, y se tiran los de los que ya no están.
  foreach ($t in $tira) {
    ArmarMenu (MenuDe $t.clave) $paneles[$t.clave] ([string]$frases[$t.clave])
  }
  $claves = @($tira | ForEach-Object { $_.clave })
  foreach ($clave in @($script:Menus.Keys)) {
    if ($claves -contains $clave) { continue }
    $mn = $script:Menus[$clave]
    foreach ($viejo in @($mn.Items)) { $viejo.Dispose() }
    $mn.Dispose()
    $script:Menus.Remove($clave)
  }

  ActualizarTira $tira
  RevisarSiSeVe
  SoltarGlobos
  GuardarPrevios

  # Recién ahora: todos los menús se rearmaron, así que ningún PictureBox sigue
  # apuntando a estos.
  foreach ($b in $bitmapsViejos) { try { $b.Dispose() } catch { } }
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

# Los argumentos con los que arrancamos, para poder relanzarnos iguales cuando
# el archivo cambie debajo. Se reconstruyen de los parámetros ligados y no de
# la línea original, que PowerShell no conserva de forma confiable.
$script:MisArgs = @()
foreach ($kv in $PSBoundParameters.GetEnumerator()) {
  if ($kv.Value -is [switch]) {
    if ($kv.Value.IsPresent) { $script:MisArgs += "-$($kv.Key)" }
  } else {
    $script:MisArgs += "-$($kv.Key)"
    $script:MisArgs += [string]$kv.Value
  }
}

# ── una bandeja por sesión, y la segunda se va ──────────────────────────
# Sin esto, arrancarla dos veces —el arranque automático más un `make tray` a
# mano, que es lo más fácil del mundo— deja DOS tiras enteras en la bandeja: un
# ícono por cuenta repetido, los globos por duplicado, y los dos procesos
# pisándose el mismo avisados.json y el mismo previos.json. En GNOME el mismo
# problema se resuelve con un nombre en el bus (soy_el_unico en bin/qm-indicator)
# y acá con un mutex nombrado, que es lo equivalente: si el proceso muere de
# cualquier forma, Windows suelta el mutex solo. Un archivo con el PID hay que
# limpiarlo, y nunca se limpia en el caso que importa.
#
# Global\ y no Local\: el alcance es la máquina y no la sesión de terminal.
$script:Mutex = $null
$script:TengoCandado = $false

function TomarCandado {
  $nuevo = $false
  try {
    $script:Mutex = New-Object System.Threading.Mutex($true, 'Global\ai.legios.quartermaster.tray', [ref]$nuevo)
  } catch {
    return $true   # si el mutex no se puede crear, seguir es mejor que no arrancar
  }
  $script:TengoCandado = $nuevo
  return $nuevo
}

function SoltarCandado {
  if (-not $script:TengoCandado -or $null -eq $script:Mutex) { return }
  $script:TengoCandado = $false
  try { $script:Mutex.ReleaseMutex() } catch { }
  try { $script:Mutex.Dispose() } catch { }
  $script:Mutex = $null
}

# El modo captura no toca la bandeja ni el candado: dibuja, escribe y se va, así
# que puede correr al lado de una bandeja viva (y en un runner de CI, donde no
# hay ninguna).
if (-not $Captura) {
  if (-not (TomarCandado)) {
    Write-Host 'ya hay una bandeja de quartermaster andando en esta máquina.'
    exit 0
  }
}

# Qué íconos pidió el usuario. Vacío = todos, que es el caso normal.
$script:BandejaPedidos = @(
  $Iconos -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })

# Los handlers que comparten todos los menús. Se arman UNA vez y MenuDe los
# engancha en cada menú nuevo.
#
# Que «Actualizar ahora» no cierre el panel: WinForms cierra un menú al clickear
# cualquier item, y ahí se pierde justo lo que se venía a mirar. El cierre se
# puede cancelar, pero sólo se cancela para ESE item: «Abrir tablero» y «Salir»
# tienen que seguir cerrándolo, y clickear afuera o apretar Escape también.
#
# Hacen falta los dos handlers y no uno: ItemClicked corre antes que Closing y
# es el único que sabe QUÉ se clickeó; Closing es el único que puede cancelar.
$script:MantenerAbierto = $false
$script:AlClickear = {
  $script:MantenerAbierto = ($_.ClickedItem.Text -eq $ETIQUETA_ACTUALIZAR)
}
$script:AlCerrar = {
  if ($script:MantenerAbierto -and
      $_.CloseReason -eq [System.Windows.Forms.ToolStripDropDownCloseReason]::ItemClicked) {
    $_.Cancel = $true
  }
  $script:MantenerAbierto = $false
}
# El latido del pie: sólo corre mientras hay un panel abierto, porque es lo
# único que se mueve ahí y nadie lo mira cerrado.
$script:AlAbrir = { if ($script:Latido) { $script:Latido.Start() } }
$script:AlCerrado = { if ($script:Latido) { $script:Latido.Stop() } }

# La tira, indexada por clave y en orden de aparición. Y el item que emite los
# globos, que sale de ella.
#
# Se llama $script:Bandeja y no $script:Iconos por la TERCERA colisión de
# nombres de este archivo, y la peor de las tres: el parámetro -Iconos crea un
# $script:Iconos tipado [string], así que asignarle un diccionario no fallaba —
# lo CONVERTÍA a texto— y el error salía mucho después, al indexarlo, sin línea
# ni nombre de variable. PowerShell no distingue mayúsculas y un parámetro vive
# en el ámbito del script: cualquier $script:Algo que se llame como un parámetro
# es el parámetro.
$script:Bandeja = [ordered]@{}
$script:Bitmaps = @()
$script:Ni = $null

# Click izquierdo también abre el menú: en la bandeja lo único que se ve es el
# ícono, y esperar que el usuario adivine que va con botón derecho es la misma
# clase de silencio que motivó el repo. `$this` es el item clickeado, que con
# varios en la tira ya no es siempre el mismo — y ahora cada uno abre SU panel.
$script:AbrirMenu = {
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { MostrarMenu $this }
}

# El DPI sale de un menú cualquiera, así que se crea el general —que existe
# siempre— antes de medir. AplicarTema viene después para que lo vista.
$null = MenuDe 'general'
$null = AplicarTema
$script:Escala = [math]::Max(1.0, $script:Menus['general'].DeviceDpi / 96.0)
# En modo captura la escala se fija: el DPI del runner no es el de nadie, y un
# gate que mide píxeles necesita que la misma entrada dé el mismo tamaño en
# todas las máquinas.
if ($Captura) { $script:Escala = 1.0 }
CrearFuentes

# Un panel en un PNG, sin bandeja y sin bucle de mensajes.
#
# Arma las MISMAS piezas que Refrescar, con la misma ModeloPaneles y las mismas
# funciones de dibujo: si esto dibujara por su cuenta, el gate estaría
# comprobando un dibujo que nadie ve. Es capturar() de bin/qm-indicator y de
# bin/qm-barra.swift, y existe por la razón que explica el comentario de esta
# última: diseñar a ciegas fue el error.
#
# -Panel elige cuál: 'general' (el de todas las cuentas) o el nombre corto de
# una, que es exactamente lo que muestra el ícono de esa cuenta.
function Capturar([string]$ruta, [string]$cual) {
  $datos = Leer
  $m = ModeloPaneles $datos $false
  if (-not $cual) { $cual = 'general' }
  if (-not $m.paneles.Contains($cual)) {
    throw ("no hay panel '$cual'; los que hay: " + (@($m.paneles.Keys) -join ', '))
  }

  $piezas = @($m.paneles[$cual])
  $frase = [string]$m.frases[$cual]
  if ($frase) {
    # Sólo el general puede quedarse sin tarjetas: es cuando qm no contestó, y
    # entonces lo que hay que dibujar es la frase del problema.
    throw "el panel '$cual' no tiene nada que dibujar: $frase"
  }
  # Un valor fijo y no la cadencia real: el pie tiene que salir igual en cada
  # corrida para que el gate pueda compararlo.
  $piezas += (DibujarPieLectura $SEGUNDOS_SONDEO)
  if (-not $piezas.Count) { throw 'el fixture no produjo ni una tarjeta' }

  $ancho = ($piezas | ForEach-Object { $_.Width } | Measure-Object -Maximum).Maximum
  # Un píxel de separador entre piezas, que es lo que pone el menú.
  $alto = ($piezas | ForEach-Object { $_.Height } | Measure-Object -Sum).Sum + $piezas.Count - 1

  $lienzo = Lienzo $ancho $alto
  $g = [System.Drawing.Graphics]::FromImage($lienzo)
  $g.Clear($script:Fondo)
  $brSep = New-Object System.Drawing.SolidBrush((Mezclar $script:Fondo $script:Tinta 0.22))
  $y = 0
  for ($i = 0; $i -lt $piezas.Count; $i++) {
    $g.DrawImageUnscaled($piezas[$i], 0, $y)
    $y += $piezas[$i].Height
    if ($i -lt $piezas.Count - 1) {
      $g.FillRectangle($brSep, 0, $y, [int]$ancho, 1)
      $y += 1
    }
  }
  $brSep.Dispose()
  $g.Dispose()

  $dir = Split-Path $ruta -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $lienzo.Save($ruta, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host ("panel {0}: {1}x{2} en {3}" -f $cual, $lienzo.Width, $lienzo.Height, $ruta)
  Write-Host ("iconos: " + (@($m.tira | ForEach-Object { $_.clave }) -join ', '))
  foreach ($b in $m.bitmaps) { try { $b.Dispose() } catch { } }
  $lienzo.Dispose()
}

if ($Captura) {
  Capturar $Captura $Panel
  exit 0
}

$script:Ctx = New-Object System.Windows.Forms.ApplicationContext

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $Segundos * 1000
# RevisarVersion va PRIMERO: si el archivo cambió, no tiene sentido gastar un
# calentado y un redibujo con el código viejo antes de saltar al nuevo.
$timer.Add_Tick({ RevisarVersion; $null = Calentar; Refrescar })
$timer.Start()

$script:Latido = New-Object System.Windows.Forms.Timer
$script:Latido.Interval = 1000
$script:Latido.Add_Tick({ LatirPie })

$null = Calentar
Refrescar

try {
  [System.Windows.Forms.Application]::Run($script:Ctx)
} finally {
  $timer.Stop()
  $script:Latido.Stop()
  GuardarPrevios
  foreach ($ni in @($script:Bandeja.Values)) {
    $ni.Visible = $false
    if ($ni.Icon) { $ni.Icon.Dispose() }
    $ni.Dispose()
  }
  foreach ($b in @($script:Bitmaps)) { try { $b.Dispose() } catch { } }
  if ($script:BmpPie) { try { $script:BmpPie.Dispose() } catch { } }
  SoltarCandado
}
