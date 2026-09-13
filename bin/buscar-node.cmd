@echo off
rem Encontrar un Node 22.6 o mas nuevo del lado de Windows. Deja la ruta en %NODO%.
rem
rem Es la mitad de bin/qm que no se puede escribir dos veces: la usan qm.cmd y
rem qm-web.cmd, y se `call`ea SIN setlocal a proposito, porque la gracia es que
rem la variable quede seteada en quien llama.
rem
rem El piso es 22.6 porque qm lee el TypeScript sin paso de build y el type
rem stripping recien existe desde ahi. No baja con dist\: src\adapters\
rem opencode.ts usa node:sqlite, que tampoco existe antes.
rem
rem Diferencia deliberada con bin/qm: alla las versiones de nvm se ordenan de
rem mayor a menor para quedarse con la mas nueva. Aca se toma la PRIMERA que
rem sirva, porque el requisito es un piso y no un maximo: cualquiera que lo pase
rem corre el mismo codigo. Lo que si se respeta es el orden de las FUENTES, para
rem que el gestor de versiones que el usuario eligio no quede tapado por una
rem instalacion vieja en Archivos de programa.
rem
rem ASCII puro a proposito: un .cmd con acentos se lee con la codepage de la
rem consola --850 en Windows en espanol-- y ahi el texto sale roto justo cuando
rem algo fallo.

set "NODO="

rem -- 1. el que eligio el usuario ----------------------------------------
if defined QM_NODE call :probar "%QM_NODE%"

rem -- 2. el del PATH -----------------------------------------------------
if not defined NODO (
  for /f "delims=" %%n in ('where node 2^>nul') do call :probar "%%~n"
)

rem -- 3. los gestores de versiones ---------------------------------------
rem nvm-windows apunta la version activa con un symlink (NVM_SYMLINK) y guarda
rem las demas en NVM_HOME\vX.Y.Z. Se prueba primero la activa.
if not defined NODO if defined NVM_SYMLINK call :probar "%NVM_SYMLINK%\node.exe"
if not defined NODO if defined NVM_HOME (
  for /f "delims=" %%d in ('dir /b /ad "%NVM_HOME%\v*" 2^>nul') do call :probar "%NVM_HOME%\%%d\node.exe"
)

rem fnm deja cada version en node-versions\vX.Y.Z\installation\node.exe. La activa
rem cuelga de FNM_MULTISHELL_PATH, que solo existe dentro de un shell donde fnm
rem ya corrio: por eso no alcanza con mirar esa.
if not defined NODO if defined FNM_MULTISHELL_PATH call :probar "%FNM_MULTISHELL_PATH%\node.exe"
set "FNMDIR=%FNM_DIR%"
if not defined FNMDIR set "FNMDIR=%LOCALAPPDATA%\fnm"
if not defined NODO (
  for /f "delims=" %%d in ('dir /b /ad "%FNMDIR%\node-versions" 2^>nul') do call :probar "%FNMDIR%\node-versions\%%d\installation\node.exe"
)

if not defined NODO call :probar "%LOCALAPPDATA%\Volta\bin\node.exe"

rem -- 4. las instalaciones normales --------------------------------------
if not defined NODO call :probar "%ProgramFiles%\nodejs\node.exe"
if not defined NODO call :probar "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODO call :probar "%LOCALAPPDATA%\Programs\nodejs\node.exe"

if defined NODO exit /b 0

rem Silencio es el bug (SOUL.md): si no hay Node, hay una frase que dice como
rem conseguirlo, no un error de sintaxis de un archivo .ts.
echo quartermaster necesita Node ^>= 22.6 y no encontre ninguno.>&2
echo Lee TypeScript sin paso de build, y eso recien existe desde 22.6.>&2
echo.>&2
echo   winget install OpenJS.NodeJS.LTS       instalarlo>&2
echo   set QM_NODE=C:\ruta\a\node.exe         o decirle cual usar>&2
exit /b 1

rem -- :probar ------------------------------------------------------------
rem Se queda con el candidato si existe Y si la version alcanza. Se guarda
rem solo, asi que se lo puede llamar en cadena sin envolverlo en ifs: el
rem primero que sirva gana y los demas no hacen nada.
:probar
if defined NODO exit /b 0
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
"%~1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)" >nul 2>&1
if errorlevel 1 exit /b 0
set "NODO=%~1"
exit /b 0
