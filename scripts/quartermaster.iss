; El instalador de Windows.
;
; Por qué existe. Hasta acá Windows tenía todo escrito —el CLI corre nativo
; (numeros/h4-windows.md) y la bandeja son 2200 líneas— y ninguna forma de
; instalarlo que no fuera clonar el repo. Las otras tres plataformas tienen su
; camino de una línea (brew, apt, el .deb) y la que más código nuevo tiene era
; la única sin puerta de entrada.
;
; Qué instala, y qué NO:
;
;   · dist\ (el JS compilado), bin\qm.cmd, bin\qm-web.cmd, bin\buscar-node.cmd,
;     bin\qm-web y bin\qm-tray.ps1. Nada más: el lanzador de POSIX, el
;     indicador de GNOME y la barra de macOS no tienen nada que hacer acá.
;   · NO trae Node adentro. El paquete pesa ~1 MB en vez de ~60 y la versión de
;     Node la maneja quien la maneja siempre, que es el usuario. Si no hay uno
;     que sirva, el instalador lo dice ANTES de terminar, preguntándole a
;     buscar-node.cmd —el mismo archivo que después usa el CLI— en vez de
;     reimplementar la búsqueda acá adentro, que es como se consiguen dos
;     respuestas distintas a la misma pregunta.
;
; Se instala PARA EL USUARIO y sin UAC (PrivilegesRequired=lowest). Es lo que
; corresponde para algo que lee la cuota de las cuentas de ese usuario y deja
; un ícono en SU bandeja; y de paso es lo que hace que `winget install` no pida
; elevación. Quien quiera para toda la máquina puede pasar /ALLUSERS.
;
; Se compila con scripts/hacer-setup.ps1, que le pasa la versión:
;   iscc /DVersion=0.1.6 scripts\quartermaster.iss

#define Nombre    "quartermaster"
#define Publicador "Legios"
#define Sitio     "https://quartermaster.legios.com.ar/"
#define Repo      "https://github.com/legiosai/quartermaster"

#ifndef Version
  #define Version "0.0.0"
#endif

[Setup]
; Este GUID identifica al producto para siempre: si cambia, Windows deja de
; ver la instalación vieja y la nueva se instala AL LADO en vez de encima.
AppId={{7B1D2C64-5B3E-4E0A-9A1E-2F7C4C2B8E11}
AppName={#Nombre}
AppVersion={#Version}
AppVerName={#Nombre} {#Version}
AppPublisher={#Publicador}
AppPublisherURL={#Sitio}
AppSupportURL={#Repo}/issues
AppUpdatesURL={#Repo}/releases
VersionInfoVersion={#Version}
DefaultDirName={autopf}\quartermaster
DefaultGroupName=quartermaster
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
OutputDir=..\dist
OutputBaseFilename=quartermaster-{#Version}-setup
SetupIconFile=..\bin\quartermaster.ico
UninstallDisplayIcon={app}\bin\quartermaster.ico
UninstallDisplayName={#Nombre} {#Version}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
; La bandeja dibuja con System.Drawing y WinForms sobre Windows PowerShell 5.1,
; que es lo que hay en un Windows sin instalar nada desde el 10.
MinVersion=10.0
; Sin esto, el PATH nuevo no llega a los programas que ya estaban abiertos.
ChangesEnvironment=yes

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
es.TareaPath=Agregar %1 al PATH (para poder escribir `qm` en cualquier consola)
es.TareaInicio=Arrancar la bandeja al iniciar sesión
es.CorrerAhora=Arrancar la bandeja ahora
es.VerTablero=El tablero en el navegador
es.LaBandeja=La bandeja de quartermaster
es.SinNode=No encontré Node 22.6 o más nuevo en esta máquina.%n%nquartermaster quedó instalado igual, pero `qm` no va a andar hasta que haya uno:%n%n    winget install OpenJS.NodeJS.LTS%n%nSi ya tenés uno en otra ruta, podés indicarlo con la variable QM_NODE.
en.TareaPath=Add %1 to PATH (so you can type `qm` in any console)
en.TareaInicio=Start the tray when you sign in
en.CorrerAhora=Start the tray now
en.VerTablero=The dashboard in your browser
en.LaBandeja=The quartermaster tray
en.SinNode=I could not find Node 22.6 or newer on this machine.%n%nquartermaster is installed, but `qm` will not run until there is one:%n%n    winget install OpenJS.NodeJS.LTS%n%nIf you already have one elsewhere, point at it with the QM_NODE variable.

[Tasks]
Name: "path"; Description: "{cm:TareaPath,{app}\bin}"
Name: "inicio"; Description: "{cm:TareaInicio}"

[Files]
Source: "..\dist\*";            DestDir: "{app}\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\bin\qm.cmd";        DestDir: "{app}\bin";  Flags: ignoreversion
Source: "..\bin\qm-web.cmd";    DestDir: "{app}\bin";  Flags: ignoreversion
Source: "..\bin\buscar-node.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\bin\qm-web";        DestDir: "{app}\bin";  Flags: ignoreversion
Source: "..\bin\qm-tray.ps1";   DestDir: "{app}\bin";  Flags: ignoreversion
Source: "..\bin\qm-tray.cmd";   DestDir: "{app}\bin";  Flags: ignoreversion
Source: "..\bin\qm-tray-quitar.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\bin\quartermaster.ico"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "..\LICENSE";           DestDir: "{app}";      Flags: ignoreversion
Source: "..\README.md";         DestDir: "{app}";      Flags: ignoreversion

[Icons]
Name: "{group}\{cm:LaBandeja}"; Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\qm-tray.ps1"""; \
  IconFilename: "{app}\bin\quartermaster.ico"; Comment: "{#Nombre}"
Name: "{group}\{cm:VerTablero}"; Filename: "{app}\bin\qm-web.cmd"; \
  IconFilename: "{app}\bin\quartermaster.ico"
Name: "{userstartup}\quartermaster"; Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\qm-tray.ps1"""; \
  IconFilename: "{app}\bin\quartermaster.ico"; Tasks: inicio

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\qm-tray.ps1"""; \
  Description: "{cm:CorrerAhora}"; Flags: postinstall nowait skipifsilent

[Code]

{ ── el PATH ────────────────────────────────────────────────────────────
  Se toca el PATH del USUARIO (HKCU\Environment) y nunca el de la máquina:
  esto se instala por usuario. Y se reescribe a mano en vez de dejarlo en una
  entrada de la sección Registry con la constante olddata, por una razón de la
  que no se vuelve: el desinstalador de Inno borraría el VALOR ENTERO, o sea el
  PATH del usuario, no nuestro pedacito.

  Dos cosas de sintaxis que este comentario aprendió a los golpes, las dos
  medidas contra ISCC 6.7.3:

  - el nombre de esa sección va sin corchetes. ISCC busca las etiquetas de
    sección al principio de cada línea y las encuentra ADENTRO de un
    comentario: «Error on line 125: Invalid section tag».
  - y la constante va sin llaves, por lo mismo un nivel más abajo: en Pascal
    Script los comentarios de llaves NO anidan, así que la llave que cierra
    olddata cerraba este comentario y el resto del párrafo se compilaba como
    código: «Column 47: BEGIN expected». }

const
  ENTORNO = 'Environment';

function LeerPath(var valor: string): Boolean;
begin
  Result := RegQueryStringValue(HKEY_CURRENT_USER, ENTORNO, 'Path', valor);
  if not Result then
    valor := '';
end;

function YaEstaEnPath(const dir: string): Boolean;
var
  actual: string;
begin
  LeerPath(actual);
  Result := Pos(';' + Lowercase(dir) + ';', ';' + Lowercase(actual) + ';') > 0;
end;

procedure AgregarAlPath(const dir: string);
var
  actual, nuevo: string;
begin
  if YaEstaEnPath(dir) then
    exit;
  LeerPath(actual);
  if actual = '' then
    nuevo := dir
  else if Copy(actual, Length(actual), 1) = ';' then
    nuevo := actual + dir
  else
    nuevo := actual + ';' + dir;
  RegWriteExpandStringValue(HKEY_CURRENT_USER, ENTORNO, 'Path', nuevo);
end;

procedure SacarDelPath(const dir: string);
var
  actual, nuevo: string;
begin
  if not LeerPath(actual) then
    exit;
  nuevo := ';' + actual + ';';
  StringChangeEx(nuevo, ';' + dir + ';', ';', True);
  { Los punto y coma de los extremos se sacan siempre, hayamos cambiado algo
    o no: son los que agregamos nosotros dos líneas más arriba. }
  Delete(nuevo, 1, 1);
  if (Length(nuevo) > 0) and (Copy(nuevo, Length(nuevo), 1) = ';') then
    Delete(nuevo, Length(nuevo), 1);
  if nuevo <> actual then
    RegWriteExpandStringValue(HKEY_CURRENT_USER, ENTORNO, 'Path', nuevo);
end;

{ ── ¿hay un Node que sirva? ────────────────────────────────────────────
  Se pregunta DESPUÉS de copiar los archivos y se pregunta con
  buscar-node.cmd, que es el mismo archivo que va a usar `qm` cada vez que
  arranque. Reimplementar la búsqueda acá sería tener dos respuestas para la
  misma pregunta, y la que importa es la del CLI.

  No se cancela la instalación si no hay: `qm` sin Node es un comando que
  explica qué falta, y eso es mejor que no dejar nada instalado. }

procedure AvisarSiFaltaNode;
var
  codigo: Integer;
begin
  if WizardSilent then
    exit;
  { La forma `cmd /c ""prog" args"` es la que documenta `cmd /?` para que una
    ruta con espacios no se parta en dos. }
  if not Exec(ExpandConstant('{cmd}'),
              '/c ""' + ExpandConstant('{app}\bin\buscar-node.cmd') + '" >nul 2>&1"',
              '', SW_HIDE, ewWaitUntilTerminated, codigo) then
    exit;
  if codigo <> 0 then
    MsgBox(ExpandConstant('{cm:SinNode}'), mbInformation, MB_OK);
end;

procedure CurStepChanged(paso: TSetupStep);
begin
  if paso = ssPostInstall then
  begin
    if WizardIsTaskSelected('path') then
      AgregarAlPath(ExpandConstant('{app}\bin'));
    AvisarSiFaltaNode;
  end;
end;

{ ── al desinstalar ─────────────────────────────────────────────────────
  Primero se cierra la bandeja. Si queda corriendo, Windows no puede borrar el
  .ps1 que tiene abierto y el desinstalador deja el directorio a medias — y el
  ícono sigue ahí, que es peor: un ícono que ya no tiene programa detrás. }

procedure CerrarBandeja;
var
  codigo: Integer;
begin
  { La lógica vive en bin\qm-tray-quitar.cmd y no acá: el usuario también
    necesita poder cerrarla, y una regla escrita dos veces son dos reglas. }
  Exec(ExpandConstant('{cmd}'),
       '/c "' + ExpandConstant('{app}\bin\qm-tray-quitar.cmd') + '"',
       '', SW_HIDE, ewWaitUntilTerminated, codigo);
end;

procedure CurUninstallStepChanged(paso: TUninstallStep);
begin
  if paso = usUninstall then
  begin
    CerrarBandeja;
    SacarDelPath(ExpandConstant('{app}\bin'));
  end;
end;
