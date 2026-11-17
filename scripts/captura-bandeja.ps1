<#
Dibuja el panel de la bandeja de Windows a partir de los fixtures, sin cuenta ni
red, en los dos temas.

  powershell -File scripts/captura-bandeja.ps1 <salida> <fixture.json>...

Es scripts/captura-barra.sh para Windows: no hay forma de MIRAR la bandeja sin
un Windows prendido al lado, y diseñarla a ciegas fue lo que la dejó con otro
dibujo que GNOME y macOS. Los instantes se corren a «ahora» antes
(scripts/fixture-a-ahora.py): un reinicio de septiembre dibujaría todas las
barras «vencidas» y ninguna proyección hacia adelante.

Por cada fixture deja <nombre>-oscuro.png y <nombre>-claro.png, y de
panel.json además una variante, panel-codigo, con la frase de verdad de una
cuenta sin cuota —la que lleva `qm --statusline` entre acentos graves—, que es
la que tiene que salir en monoespaciada y sin partir. Falla si alguna captura
no salió: es también la prueba de que la curva con proyección DIBUJA, que el
gate de la bandeja no ve porque mira los fixtures sin correr.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Salida,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Fixtures
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$raiz = Split-Path (Split-Path $PSCommandPath -Parent) -Parent
$guion = Join-Path $raiz 'bin\qm-tray.ps1'
$correr = Join-Path $raiz 'scripts\fixture-a-ahora.py'
New-Item -ItemType Directory -Path $Salida -Force | Out-Null
$Salida = (Resolve-Path $Salida).Path
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("qm-captura-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$python = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'python3' }
$fallas = @()

function Dibujar([string]$datos, [string]$nombre) {
  foreach ($tema in 'Oscuro', 'Claro') {
    $png = Join-Path $Salida ("{0}-{1}.png" -f $nombre, $tema.ToLower())
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $guion -Desde $datos -Captura $png "-$tema"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $png)) {
      $script:fallas += "$nombre ($tema) no se dibujó (salió $LASTEXITCODE)"
    }
  }
}

foreach ($f in @($Fixtures)) {
  $nombre = [System.IO.Path]::GetFileNameWithoutExtension($f)
  $datos = Join-Path $tmp "$nombre.json"
  & $python $correr $f $datos
  if ($LASTEXITCODE -ne 0) { $fallas += "no pude correr $f a ahora"; continue }
  Dibujar $datos $nombre

  if ($nombre -eq 'panel') {
    # La frase de verdad de `qm` para una cuenta sin cuota guardada, en UNA de
    # las dos cuentas mudas: así además sale el agrupado por frase con dos
    # frases distintas.
    $d = Get-Content -Raw -Encoding UTF8 $datos | ConvertFrom-Json
    $muda = @($d.perfiles | Where-Object { $_.cuota.estado -ne 'ok' }) | Select-Object -First 1
    $muda.cuota.frase = 'no hay cuota guardada para este perfil — poné `qm --statusline` como ' +
                        'statusLine de Claude Code (sin red ni credencial), o corré `qm --refrescar`'
    $codigo = Join-Path $tmp 'panel-codigo.json'
    $d | ConvertTo-Json -Depth 30 | Set-Content -Path $codigo -Encoding UTF8
    Dibujar $codigo 'panel-codigo'
  }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($fallas.Count) {
  foreach ($x in $fallas) { [Console]::Error.WriteLine("✗ $x") }
  exit 1
}
Write-Host "bandeja de Windows: $(@($Fixtures).Count) fixtures dibujados en los dos temas, en $Salida"
exit 0
