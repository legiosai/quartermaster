@echo off
rem Lanzador de qm del lado de Windows.
rem
rem Es el gemelo de bin/qm, que es un /bin/sh y por lo tanto no sirve aca: eso
rem es exactamente lo que quedo anotado como pendiente al final de
rem numeros/h4-windows.md. El CLI ya corria nativo --medido, con Node v24.15.0 y
rem `plataforma: win32`-- pero habia que invocar `node src\cli\qm.ts` a mano, y
rem con eso no se puede construir ni un paquete, ni un instalador, ni una
rem bandeja que no dependa de WSL.
rem
rem Hace lo mismo que bin/qm:
rem
rem   1. busca un Node 22.6 o mas nuevo (eso vive en buscar-node.cmd, que
rem      comparte con qm-web.cmd);
rem   2. prefiere dist\ si esta, y si no lee src\;
rem   3. si no hay Node que sirva, lo DICE y explica como conseguirlo.
rem
rem ASCII puro a proposito: ver el encabezado de buscar-node.cmd.

setlocal

set "RAIZ=%~dp0.."

call "%~dp0buscar-node.cmd"
if not defined NODO exit /b 1

rem -- la consola, que no muestra UTF-8 sin que se lo pidan ---------------
rem Medido en numeros/h4-windows.md: sin esto los separadores del medio de la
rem linea salen como
rem mojibake. Se guarda la codepage anterior y se devuelve al salir, porque
rem esta consola es la del usuario y no la nuestra.
set "CPVIEJA="
for /f "tokens=2 delims=:" %%p in ('chcp 2^>nul') do set "CPVIEJA=%%p"
if defined CPVIEJA set "CPVIEJA=%CPVIEJA: =%"
if defined CPVIEJA set "CPVIEJA=%CPVIEJA:.=%"
if defined CPVIEJA chcp 65001 >nul 2>&1

rem -- dist\ si esta, src\ si no ------------------------------------------
rem No es una optimizacion: Node se NIEGA a hacer type stripping de archivos
rem bajo node_modules, y un `npm install -g` deja el paquete justo ahi. Solo el
rem tarball de npm lleva dist\; un clone y el instalador leen el TypeScript.
if exist "%RAIZ%\dist\cli\qm.js" (
  "%NODO%" "%RAIZ%\dist\cli\qm.js" %*
) else (
  "%NODO%" "%RAIZ%\src\cli\qm.ts" %*
)
set "CODIGO=%ERRORLEVEL%"

if defined CPVIEJA chcp %CPVIEJA% >nul 2>&1

rem El codigo de salida importa: `--umbral` sale 3 y quien lo encadena lo mira.
exit /b %CODIGO%
