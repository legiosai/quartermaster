@echo off
rem Cerrar la bandeja.
rem
rem Existe por dos motivos, y el segundo es el que lo hace un archivo y no una
rem linea suelta adentro del desinstalador:
rem
rem   1. el usuario necesita poder cerrarla sin buscar el proceso a mano;
rem   2. el desinstalador TIENE que cerrarla antes de borrar nada. Un .ps1 que
rem      un proceso tiene abierto no se puede borrar, asi que la desinstalacion
rem      quedaria a medias y el icono seguiria en la bandeja sin programa
rem      detras -- que es peor que no desinstalar.
rem
rem Se filtra por linea de comandos y NO por nombre de proceso: el que corre es
rem powershell.exe, igual que cualquier otro. Y se excluye el $PID propio
rem porque la linea de comandos de este mismo proceso contiene el texto que
rem estamos buscando: sin esa exclusion, lo primero que mata es a si mismo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*qm-tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
exit /b 0
