// La pregunta de la barra, en la primera corrida de `qm` en una terminal.
//
// POR QUÉ EXISTE. La barra es el punto entero del programa y ninguna vía de
// instalación la puede mostrar sola: `brew install` corre en un sandbox que no
// deja escribir en ~/Library ni en ~/.cache, y el postinstall de npm dejó de
// registrar el LaunchAgent a propósito (ver scripts/instalar-barra.mjs: un
// paquete que lee tokens OAuth no registra agentes que nadie pidió). Así que
// quedaba a un comando que había que leer en un caveat — y nadie lo lee.
//
// En Linux el agujero era el mismo y más grande: el item de la barra de arriba
// sólo se prendía con `make indicador` y `make autostart`, y quien instaló por
// apt o por npm no tiene un Makefile. El .deb deja bin/qm-indicator en
// /usr/lib/quartermaster y nada más. Por eso la misma pregunta va en las dos
// plataformas, con el mismo consentimiento explícito y la misma anotación de
// que ya se preguntó.
//
// Y en Windows faltaba entero. La bandeja viaja en el paquete de npm —`files`
// incluye `bin/`, así que `qm-tray` y `qm-tray.ps1` están ahí— pero nada la
// ofrecía: quien instalaba por npm en WSL se quedaba con el CLI y sin ícono,
// sin que nada se lo dijera. Reportado a mano: «ya instalé, ¿cómo hago para que
// se vean los iconos?». Es la misma forma de silencio de siempre, y ahora la
// pregunta va también ahí.
//
// La salida es preguntar. Una vez, en una terminal, después de mostrar los
// números: quien acaba de instalar ve la pregunta en el primer `qm`, y el
// consentimiento es explícito, que es lo que el postinstall no tenía.
//
// Nunca pregunta donde una pregunta rompe algo: --json, --breve, --watch y
// --umbral los leen scripts y statuslines, y sin terminal el proceso quedaría
// colgado esperando una respuesta que no va a llegar.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { RUTA_CONFIG } from '../core/config.ts';

/** Lo que hace falta saber de la máquina para decidir si se pregunta. */
export interface Situacion {
  readonly plataforma: string;
  /** stdin y stdout son una terminal: hay alguien para contestar. */
  readonly terminal: boolean;
  readonly ci: boolean;
  /** `qm` a secas, sin --json, --breve, --watch ni --umbral. */
  readonly modoNormal: boolean;
  readonly yaPreguntado: boolean;
  /** Existe el lanzador al lado de este paquete: qm-barra en macOS, qm-indicator en Linux. */
  readonly hayBarra: boolean;
  /** macOS: las Command Line Tools. Sin swiftc la barra no compila. */
  readonly compilador: boolean;
  /** Linux: hay una sesión gráfica. Por SSH no hay barra de arriba donde poner nada. */
  readonly sesionGrafica: boolean;
  /** Linux: python3 con gi y AyatanaAppIndicator3. Sin eso el item no levanta. */
  readonly interprete: boolean;
  /**
   * Linux: YA hay una extensión del shell que muestre el item — la propia o una
   * de AppIndicator. Sin ninguna, el proceso arranca igual y no aparece nada
   * arriba, que es peor que no ofrecer: es prometer algo que no se ve.
   */
  readonly hostDelItem: boolean;
  /**
   * Linux: podemos PONER el host nosotros. El paquete trae la extensión propia
   * —la que hace que un click abra el panel de verdad, en vez del menú de GTK
   * que se cierra apenas lo tocás— y hay un GNOME Shell donde instalarla.
   * Hasta 0.1.11 `extension/` no viajaba en el paquete de npm, así que un
   * usuario de npm no podía tener ese panel ni sabiéndolo.
   */
  readonly puedeHospedar: boolean;
  /**
   * Windows: acá la barra es la BANDEJA, y `qm` puede estar corriendo adentro
   * de WSL —que es lo normal: el paquete de npm se instala en WSL— o nativo.
   * En los dos casos el item es un proceso de Windows.
   */
  readonly bandeja: boolean;
  /** Windows desde WSL: se llega a powershell.exe. Sin interop no hay bandeja. */
  readonly interop: boolean;
  readonly arranqueInstalado: boolean;
  readonly corriendo: boolean;
}

export function debeOfrecer(s: Situacion): boolean {
  // Lo que vale en las dos plataformas, primero: hay alguien para contestar,
  // no se preguntó antes, y no está puesto ya.
  if (!s.terminal || s.ci || !s.modoNormal || s.yaPreguntado) return false;
  if (!s.hayBarra || s.arranqueInstalado || s.corriendo) return false;
  // Y después, lo que cada una necesita para que lo ofrecido llegue a verse.
  //
  // La bandeja va PRIMERO y no adentro de la rama de linux, aunque en WSL
  // `process.platform` diga linux: lo que decide no es el kernel sino dónde
  // aparece el item. Preguntar por GNOME en una WSL sería ofrecer una barra de
  // arriba que no existe.
  if (s.bandeja) return s.interop;
  if (s.plataforma === 'darwin') return s.compilador;
  if (s.plataforma === 'linux') {
    return s.sesionGrafica && s.interprete && (s.hostDelItem || s.puedeHospedar);
  }
  return false;
}

export type Arranque =
  | { readonly via: 'brew'; readonly brew: string; readonly lanzador: string }
  | { readonly via: 'lanzador'; readonly lanzador: string }
  /** Linux: escribir el .desktop NO lo arranca, así que además hay que lanzarlo. */
  | { readonly via: 'indicador'; readonly lanzador: string }
  /** Windows: el acceso directo en Inicio tampoco arranca nada hoy. */
  | { readonly via: 'bandeja'; readonly lanzador: string };

/**
 * Por dónde se arranca, según dónde vive el paquete.
 *
 * En brew, `qm` corre desde `<prefijo>/Cellar/quartermaster/<versión>/libexec`.
 * El plist que escribe `qm-barra --instalar-arranque` apunta a la ruta del
 * lanzador, y esa lleva la versión adentro: el primer `brew upgrade` la borra y
 * la barra deja de arrancar sin decir nada. Por eso ahí va `brew services`, que
 * usa la ruta `opt/` estable. El lanzador por `opt/` queda de repuesto para una
 * fórmula instalada antes de que tuviera el bloque `service`.
 */
export function comoArrancar(
  raiz: string,
  plataforma: string = process.platform,
  // Sin default de la máquina a propósito: con `esBandeja()` acá la función
  // dejaba de ser pura y sus tests contestaban distinto según dónde corrieran
  // —en esta WSL los tres de macOS y Linux empezaron a fallar—. Quien pregunta
  // ya tiene la respuesta en la Situación; acá se recibe y no se adivina.
  bandeja: boolean = false,
): Arranque {
  if (bandeja) {
    return { via: 'bandeja', lanzador: join(raiz, 'bin', 'qm-tray') };
  }
  if (plataforma === 'linux') {
    return { via: 'indicador', lanzador: join(raiz, 'bin', 'qm-indicator') };
  }
  const cellar = /^(.*)\/Cellar\/quartermaster\/[^/]+\/libexec\/?$/.exec(raiz);
  if (cellar !== null) {
    const prefijo = cellar[1]!;
    return {
      via: 'brew',
      brew: join(prefijo, 'bin', 'brew'),
      lanzador: join(prefijo, 'opt', 'quartermaster', 'libexec', 'bin', 'qm-barra'),
    };
  }
  return { via: 'lanzador', lanzador: join(raiz, 'bin', 'qm-barra') };
}

/** Dónde queda anotado que ya se preguntó. Es config, no cache: no se borra sola. */
const RUTA_RESPUESTA = join(dirname(RUTA_CONFIG), 'barra-ofrecida.json');

/** Los tres agentes que pueden estar arrancando la barra: el propio y los de brew. */
const AGENTES = [
  'com.legios.quartermaster.barra.plist',
  'sh.brew.quartermaster.plist',
  'homebrew.mxcl.quartermaster.plist',
].map((f) => join(homedir(), 'Library', 'LaunchAgents', f));

function sale0(cmd: string, args: readonly string[]): boolean {
  return salida(cmd, args) === 0;
}

/** El código de salida, o -1 si no se pudo correr. Hay una bandera que usa el 2. */
function salida(cmd: string, args: readonly string[], ms = 4000): number {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: ms });
    return 0;
  } catch (e) {
    const n = (e as { status?: number }).status;
    return typeof n === 'number' ? n : -1;
  }
}

/** El proceso del item, por su ruta: el binario se llama distinto en cada plataforma. */
function corriendo(plataforma: string): boolean {
  const patron = plataforma === 'linux' ? 'quartermaster/bin/qm-indicator' : 'quartermaster/qm-barra';
  return sale0('pgrep', ['-f', patron]);
}

/**
 * ¿Acá la barra es la bandeja de Windows?
 *
 * Dos casos y los dos cuentan: `qm` nativo en Windows, y —el normal, porque es
 * como se instala el paquete de npm— `qm` adentro de WSL. En WSL
 * `process.platform` dice `linux`, y por eso no alcanza con mirar eso: el item
 * es un proceso de Windows en los dos.
 */
export function esBandeja(): boolean {
  if (process.platform === 'win32') return true;
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Lo que hay del lado de Windows, en UNA sola llamada.
 *
 * Son dos preguntas —¿está el acceso directo en Inicio? ¿hay una bandeja
 * corriendo?— y desde WSL cada una cuesta levantar un powershell.exe, que es
 * casi un segundo. Se contestan juntas, con las dos respuestas en el código de
 * salida: 1 el acceso directo, 2 la bandeja corriendo. Sólo corre en la primera
 * corrida de `qm`, cuando todavía puede haber algo que ofrecer.
 *
 * Si no se puede correr —interop apagada, PowerShell que no está— da 0, que
 * lleva a ofrecer. Y ofrecer sin interop no pasa, porque `debeOfrecer` pide
 * `interop` aparte.
 */
function estadoWindows(): { ok: boolean; arranque: boolean; viva: boolean } {
  const n = salida('powershell.exe', ['-NoProfile', '-Command', GUION_ESTADO], 15000);
  // `ok` es además la respuesta a «¿hay interoperabilidad?»: si powershell.exe
  // no se puede correr, no hay bandeja posible. Se saca de acá y no de un
  // `command -v` aparte por dos razones. Una es que ya está el proceso. La
  // otra es que ese `command -v` NO FUNCIONABA: `command` es un builtin del
  // shell, no un ejecutable, así que `execFileSync` fallaba siempre y la
  // interoperabilidad daba false hasta en una WSL donde andaba perfecto.
  if (n < 0) return { ok: false, arranque: false, viva: false };
  return { ok: true, arranque: (n & 1) !== 0, viva: (n & 2) !== 0 };
}

const GUION_ESTADO = [
  "$s = New-Object -ComObject WScript.Shell;",
  "$lnk = Join-Path $s.SpecialFolders('Startup') 'quartermaster.lnk';",
  "$n = 0;",
  'if (Test-Path $lnk) { $n += 1 };',
  '$p = @(Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" |',
  // El `-ne $PID` no es de adorno: el patrón que se busca está escrito
  // adentro de ESTE comando, así que la consulta se encuentra a sí misma y
  // contesta «hay una bandeja corriendo» con cero bandejas. Medido: 0 procesos
  // en Windows y `corriendo: true` acá.
  "  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*qm-tray.ps1*' });",
  'if ($p.Count) { $n += 2 };',
  'exit $n',
].join(' ');

/** El .desktop del arranque de sesión, donde XDG diga. */
const ARRANQUE_LINUX = join(
  process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'),
  'autostart', 'quartermaster.desktop',
);

/**
 * Ya hay una extensión del shell que muestre el item: la propia, o una de
 * AppIndicator —la de rgcjonas o la de Ubuntu—. `gnome-extensions` lista las
 * habilitadas; si no está el comando, no hay GNOME Shell.
 */
function hayHost(): boolean {
  try {
    const dichas = execFileSync('gnome-extensions', ['list', '--enabled'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    return dichas.split('\n').some((e) => e === EXTENSION || e.includes('appindicator'));
  } catch {
    return false;
  }
}

const EXTENSION = 'quartermaster@legios';

/** El paquete trae la extensión propia y hay un GNOME Shell donde ponerla. */
const puedeHospedar = (raiz: string): boolean =>
  existsSync(join(raiz, 'extension', EXTENSION)) && sale0('gnome-extensions', ['version']);

/** python3 con gi y el AppIndicator que el item importa al arrancar. */
const hayInterprete = (): boolean => sale0('python3', [
  '-c',
  "import gi;gi.require_version('AyatanaAppIndicator3','0.1');"
  + 'from gi.repository import AyatanaAppIndicator3,Gtk;import cairo',
]);

export function situacionActual(raiz: string, modoNormal: boolean): Situacion {
  const bandeja = esBandeja();
  const darwin = process.platform === 'darwin';
  // En WSL `process.platform` dice linux, pero ahí la barra es la bandeja: las
  // preguntas de GNOME no van, y las que sí van son las de Windows.
  const linux = process.platform === 'linux' && !bandeja;
  // Las preguntas baratas primero, y las que cuestan un proceso sólo si la
  // plataforma es la suya y todavía puede haber algo que ofrecer: en un `qm`
  // que ya preguntó, acá no corre nada.
  const comun = {
    plataforma: process.platform,
    terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ci: Boolean(process.env['CI']),
    modoNormal,
    yaPreguntado: existsSync(RUTA_RESPUESTA),
    hayBarra: existsSync(join(raiz, 'bin', bandeja ? 'qm-tray' : darwin ? 'qm-barra' : 'qm-indicator')),
  };
  const vale = comun.terminal && !comun.ci && comun.modoNormal && !comun.yaPreguntado && comun.hayBarra;
  // Una sola llamada a Windows, y sólo si todavía puede haber algo que ofrecer.
  const win = vale && bandeja ? estadoWindows() : { ok: false, arranque: false, viva: false };
  return {
    ...comun,
    bandeja,
    interop: win.ok,
    compilador: vale && darwin && sale0('xcode-select', ['-p']),
    sesionGrafica: linux && Boolean(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']),
    interprete: vale && linux && hayInterprete(),
    hostDelItem: vale && linux && hayHost(),
    puedeHospedar: vale && linux && puedeHospedar(raiz),
    arranqueInstalado: bandeja
      ? win.arranque
      : darwin
        ? AGENTES.some((a) => existsSync(a))
        : linux && existsSync(ARRANQUE_LINUX),
    corriendo: bandeja ? win.viva : vale && (darwin || linux) && corriendo(process.platform),
  };
}

function anotar(respuesta: 'si' | 'no'): void {
  try {
    mkdirSync(dirname(RUTA_RESPUESTA), { recursive: true });
    writeFileSync(RUTA_RESPUESTA, `${JSON.stringify({ respuesta, cuando: new Date().toISOString() })}\n`);
  } catch {
    // Sin poder anotarlo se vuelve a preguntar la próxima vez. Molesta, pero no
    // deja a nadie sin números.
  }
}

/** Lo que pasó al arrancar: alcanza para elegir la frase final sin adivinar. */
interface Arrancado {
  readonly pudo: boolean;
  /** La extensión quedó instalada pero GNOME la carga recién en la próxima sesión. */
  readonly pideVolverAEntrar: boolean;
}

/** Arranca la barra y que arranque sola al iniciar sesión. */
function arrancar(a: Arranque, s: Situacion): Arrancado {
  if (a.via === 'bandeja') {
    // Dos pasos, igual que en Linux y por lo mismo: el acceso directo en Inicio
    // es para la PRÓXIMA sesión, y quien acaba de contestar que sí la quiere
    // ver ahora. En macOS `launchd` arranca al registrar; un .lnk no arranca
    // nada.
    if (!existsSync(a.lanzador) || !sale0(a.lanzador, ['--instalar-arranque'])) {
      return { pudo: false, pideVolverAEntrar: false };
    }
    try {
      spawn(a.lanzador, [], { detached: true, stdio: 'ignore' }).unref();
      return { pudo: true, pideVolverAEntrar: false };
    } catch {
      return { pudo: false, pideVolverAEntrar: false };
    }
  }
  if (a.via === 'indicador') {
    // La extensión propia primero: es la que hace que un click abra el panel.
    // Sin ella el item cae al menú de GTK, que no sostiene el agarre y se cierra
    // apenas lo tocás. `--instalar-extension` sale 2 cuando quedó instalada y
    // GNOME la carga recién al volver a entrar; eso no es un fallo, es lo que
    // hay que decir.
    let pideVolverAEntrar = false;
    if (s.puedeHospedar) {
      const n = salida(a.lanzador, ['--instalar-extension'], 15000);
      if (n === 2) pideVolverAEntrar = true;
      else if (n !== 0 && !s.hostDelItem) return { pudo: false, pideVolverAEntrar: false };
    }
    // Dos pasos y no uno: el .desktop es para la PRÓXIMA sesión, y quien acaba
    // de contestar que sí quiere verlo ahora. `launchd` y `brew services`
    // arrancan al instalar; un .desktop de autostart no arranca nada.
    if (!existsSync(a.lanzador) || !sale0(a.lanzador, ['--instalar-arranque'])) {
      return { pudo: false, pideVolverAEntrar };
    }
    try {
      // Desprendido y sin heredar la terminal: si no, queda colgado del shell
      // y se muere al cerrarlo. La salida va a /dev/null acá y al journal en
      // los arranques de sesión, que es donde se la va a buscar.
      spawn(a.lanzador, [], { detached: true, stdio: 'ignore' }).unref();
      return { pudo: true, pideVolverAEntrar };
    } catch {
      return { pudo: false, pideVolverAEntrar };
    }
  }
  return { pudo: arrancarMac(a), pideVolverAEntrar: false };
}

function arrancarMac(a: Arranque): boolean {
  if (a.via === 'brew' && sale0(a.brew, ['services', 'start', 'quartermaster'])) return true;
  // `brew services` falla si la fórmula instalada es anterior al bloque
  // `service`: ahí va el lanzador por la ruta opt/, que sobrevive a un upgrade.
  return existsSync(a.lanzador) && sale0(a.lanzador, ['--instalar-arranque']);
}

/**
 * La pregunta, si corresponde. Nunca tira y nunca cambia el código de salida de
 * `qm`: es un ofrecimiento, no parte de la respuesta.
 */
export async function ofrecerBarra(raiz: string, modoNormal: boolean): Promise<void> {
  const s = situacionActual(raiz, modoNormal);
  if (!debeOfrecer(s)) return;

  const donde = s.bandeja
    ? 'la bandeja'
    : process.platform === 'linux' ? 'la barra de arriba' : 'la barra de menú';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let texto: string;
  try {
    texto = await rl.question(`¿Mostrar esto en ${donde}, y que arranque solo al iniciar sesión? [S/n] `);
  } catch {
    // Ctrl-D o ctrl-c: la pregunta se aborta y readline tira ABORT_ERR. Eso no
    // es un «no» —nadie contestó—, así que no se anota y se vuelve a ofrecer la
    // próxima vez. Lo que no puede pasar es que `qm` muera con un stack trace
    // después de haber mostrado bien los números.
    console.log();
    return;
  } finally {
    rl.close();
  }
  const a = comoArrancar(raiz, process.platform, s.bandeja);
  const comando = a.via === 'brew' ? 'brew services start quartermaster' : `${a.lanzador} --instalar-arranque`;
  const listo = s.bandeja
    ? ' listo: abajo a la derecha, al lado del reloj.'
    : process.platform === 'linux' ? ' listo: arriba, en la barra.' : ' listo: arriba a la derecha.';

  if (/^\s*n/i.test(texto)) {
    anotar('no');
    console.log(`Listo, no se vuelve a preguntar. Si cambiás de idea: ${comando}`);
    return;
  }
  anotar('si');
  const hecho = arrancar(a, s);
  if (!hecho.pudo) {
    console.log(`No pude arrancarla. A mano: ${comando}`);
    return;
  }
  // En macOS la primera vez compila bin/qm-barra.swift, que tarda unos
  // segundos. Se espera a verlo corriendo para no decir «listo» de algo que no
  // apareció — que es el bug que este programa existe para no cometer.
  // Y lo que se dice al final tiene que ser lo que se va a ver. GNOME no carga
  // una extensión recién instalada en Wayland: si ésta es la que va a mostrar
  // el item, hasta la próxima sesión no aparece nada, y decir «listo: arriba,
  // en la barra» ahí sería mentir sobre la única cosa que se vino a hacer.
  const vuelta = hecho.pideVolverAEntrar
    ? (s.hostDelItem
      ? ' listo: arriba, en la barra. El panel completo aparece cuando vuelvas a'
        + ' entrar: GNOME no carga extensiones nuevas en Wayland.'
      : ' listo, pero el item aparece cuando vuelvas a entrar: GNOME no carga'
        + ' extensiones nuevas en Wayland.')
    : listo;
  process.stdout.write(`arrancando ${donde}…`);
  // La bandeja se mira con menos vueltas a propósito: cada consulta cuesta un
  // powershell.exe —casi un segundo— así que sesenta serían un minuto de
  // procesos. Y no hace falta: acá no se compila nada, a diferencia de macOS,
  // donde la primera vez hay que esperar a swiftc.
  const vueltas = s.bandeja ? 12 : 60;
  const vivo = (): boolean => (s.bandeja ? estadoWindows().viva : corriendo(process.platform));
  for (let i = 0; i < vueltas; i += 1) {
    if (vivo()) {
      console.log(vuelta);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(` no la veo corriendo después de un minuto. Probá: ${comando}`);
}
