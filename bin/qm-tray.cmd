@echo off
rem Arrancar la bandeja, del lado de Windows y sin WSL.
rem
rem bin/qm-tray (sin extension) es el lanzador que se usa DESDE WSL: traduce
rem rutas con wslpath y le pasa -QmLinux al guion. Este es el otro lado: la
rem bandeja nativa, que resuelve sola donde esta qm (ver ResolverQm en
rem qm-tray.ps1) y no necesita que le digan nada.
rem
rem Existe porque un .lnk, un `scoop install` y un doble click necesitan algo
rem que se pueda ejecutar; un .ps1 suelto no lo es.
rem
rem El -WindowStyle Hidden deja una consola parpadeando un instante al arrancar:
rem es el precio de no empaquetar un .exe, y pasa una sola vez por sesion.
rem
rem Todo lo que se le pase viaja tal cual al guion, asi que esto anda:
rem   qm-tray.cmd -Iconos general,codex
rem   qm-tray.cmd -SinCalentar

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0qm-tray.ps1" %*
exit /b 0
