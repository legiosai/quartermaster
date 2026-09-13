@echo off
rem El tablero en el navegador, del lado de Windows.
rem
rem bin/qm-web es JavaScript comun con shebang de Node, asi que en POSIX se
rem ejecuta solo. En Windows el shebang no significa nada: hace falta alguien
rem que encuentre el node.exe y se lo pase. Eso es todo lo que hace esto.
rem
rem El tablero es la superficie que anda en cualquier maquina: si la bandeja no
rem aparece --Windows manda los iconos nuevos al desplegable de escondidos-- esta
rem sigue estando, y es la que usa el menu "Abrir el tablero".
rem
rem ASCII puro a proposito: ver el encabezado de buscar-node.cmd.

setlocal

set "RAIZ=%~dp0.."

call "%~dp0buscar-node.cmd"
if not defined NODO exit /b 1

"%NODO%" "%RAIZ%\bin\qm-web" %*
exit /b %ERRORLEVEL%
