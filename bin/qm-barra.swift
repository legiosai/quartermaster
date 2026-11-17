// qm en la barra de menú de macOS.
//
// Es la contraparte de `bin/qm-indicator` (GNOME) para la otra mitad de las
// máquinas. Vale la misma regla que allá y que en el tablero web: DIBUJA y nada
// más. Le pide el JSON a `qm` por stdout y no sabe qué es una credencial, un
// llavero ni un endpoint.
//
// Las tres cosas que lo hacen algo más que un reloj son las mismas que en GNOME,
// con los mecanismos que da esta plataforma:
//
//   · Se entera solo. Vigila el .claude.json de cada perfil con
//     DispatchSource.makeFileSystemObjectSource, así que cuando Claude Code
//     refresca la cuota el número cambia en el acto. El sondeo de 5 min queda
//     de red de seguridad. Claude Code reescribe el archivo por rename, que
//     mata el descriptor: por eso el vigía se vuelve a armar solo.
//   · Avisa sin que lo mires. Notifica al cruzar 80 % y 95 %, y cuando la
//     proyección pasa a decir que tocás el techo ANTES del reinicio — que es el
//     momento útil, no cuando ya chocaste.
//   · No repite. Cada aviso se recuerda por (perfil, barra, reinicio, umbral),
//     así que una ventana avisa una vez y vuelve a avisar en la siguiente.
//
// Se compila sin Xcode: `swiftc` viene con las Command Line Tools, y AppKit
// alcanza para un NSStatusItem. `bin/qm-barra` lo compila si hace falta.

import AppKit
import Foundation

// Red de seguridad para Claude: ahí manda el vigía de archivos.
// Para Codex NO hay vigía —no deja nada en disco— así que este sondeo es lo
// único que mueve su número, y por eso la cadencia se adapta (ver `cadencia`).
let SEGUNDOS_SONDEO: TimeInterval = 300
// Coalescer escrituras: Claude Code reescribe .claude.json varias veces seguidas.
let DEBOUNCE: TimeInterval = 1.5
/// Cada cuánto mira el vigía, y a partir de qué atraso da la alarma. El plazo
/// son cuatro sondeos: con la cadencia en su techo, un calentado que no ocurrió
/// en veinte minutos no es lentitud, es que el lazo se cortó.
let VIGIA_SEGUNDOS: TimeInterval = 60
let VIGIA_PLAZO: TimeInterval = 20 * 60

/// Piso para cualquier cadencia que salga a la RED.
///
/// La primera versión bajaba a 20 s cuando una barra pasaba el 90 %, y como
/// además refrescaba todas las cuentas en cada vuelta daban ~360 pedidos por
/// hora, sostenidos mientras la barra siguiera alta. Claude Code pide la cuota
/// del orden de una vez por sesión. Un endpoint no documentado que además
/// puede desaparecer sin aviso no es lugar para eso, y la diferencia real es
/// chica: a 1,6 puntos por minuto, 60 s son 1,6 puntos de atraso.
///
/// La lectura del disco no tiene piso: es gratis y la dispara el vigía.
let MINIMO_RED: TimeInterval = 60
let UMBRALES = [80, 95]
let ANCHO_BARRA = 12
let VIEJO_SEGUNDOS = 6 * 3600

/// La raíz del repo. El binario compilado vive en ~/.cache, así que derivarla
/// de argv[0] daría ~/.cache y ahí no hay ningún bin/qm: el lanzador, que sí
/// sabe dónde está el repo, la pasa por entorno. Lo de argv[0] queda para
/// cuando alguien corre el binario a mano desde el repo.
let RAIZ: URL = {
    if let r = ProcessInfo.processInfo.environment["QM_RAIZ"], !r.isEmpty {
        return URL(fileURLWithPath: r)
    }
    return URL(fileURLWithPath: CommandLine.arguments[0])
        .resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent()
}()

/// `qm` al lado del repo; si no está, el que haya instalado `make instalar`.
func rutaQm() -> String {
    let candidato = RAIZ.appendingPathComponent("bin/qm").path
    if FileManager.default.isExecutableFile(atPath: candidato) { return candidato }
    return (NSHomeDirectory() as NSString).appendingPathComponent(".local/bin/qm")
}

// ── el log ───────────────────────────────────────────────────────────────
// Todo lo que la barra tiene para decir va a stderr, que launchd (o `brew
// services`) manda a un archivo. Antes ahí sólo quedaba dónde se dibujaba el
// item, sin hora, un renglón por minuto; lo que de verdad importa —un calentado
// que falla, una lectura que no vuelve, un aviso que no sale— se tiraba. Un
// calentado roto se veía igual que uno sano: la barra seguía mostrando el
// número viejo con su edad, y el archivo no decía por qué.
//
// Con hora, y con tope: el archivo lo abre launchd y nadie lo rota.

let LOG_MAXIMO_BYTES: off_t = 1_000_000
let colaLog = DispatchQueue(label: "quartermaster.log")
let horaLog: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = .current
    return f
}()

func registrar(_ texto: String) {
    let ahora = Date()
    colaLog.async {
        // Sólo se recorta un archivo de verdad: corriendo a mano, stderr es la
        // terminal y no hay nada que recortar.
        var st = stat()
        if fstat(STDERR_FILENO, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size > LOG_MAXIMO_BYTES {
            ftruncate(STDERR_FILENO, 0)
            lseek(STDERR_FILENO, 0, SEEK_SET)
            FileHandle.standardError.write(
                "\(horaLog.string(from: ahora)) [qm-barra] log recortado: pasaba de \(LOG_MAXIMO_BYTES) bytes\n"
                    .data(using: .utf8)!)
        }
        let una = texto.replacingOccurrences(of: "\n", with: " / ")
        FileHandle.standardError.write("\(horaLog.string(from: ahora)) [qm-barra] \(una)\n".data(using: .utf8)!)
    }
}

/// La paleta de estado, la misma del tablero y validada contra los dos fondos
/// que puede tener la barra. El color va en la MARCA, nunca en el texto: el
/// número se queda con el color de etiqueta del sistema, que se adapta solo.
enum Nivel {
    case ok, atento, aviso, critico
    var color: NSColor {
        switch self {
        case .ok:      return NSColor(srgbRed: 0.047, green: 0.639, blue: 0.047, alpha: 1)  // #0ca30c
        case .atento:  return NSColor(srgbRed: 0.980, green: 0.698, blue: 0.098, alpha: 1)  // #fab219
        case .aviso:   return NSColor(srgbRed: 0.925, green: 0.514, blue: 0.353, alpha: 1)  // #ec835a
        case .critico: return NSColor(srgbRed: 0.816, green: 0.231, blue: 0.231, alpha: 1)  // #d03b3b
        }
    }
}

/// El color con que se identifica cada cuenta.
///
/// Deliberadamente lejos de la paleta de estado: los colores de estado están
/// reservados y no pueden significar además «esta es la cuenta 2». Por eso acá
/// no hay ni verde ni ámbar ni rojo — azul, violeta y magenta no se confunden
/// con «vas bien» ni con «te frenaste».
func colorCuenta(_ i: Int) -> NSColor {
    let claro: [NSColor] = [
        NSColor(srgbRed: 0.165, green: 0.471, blue: 0.839, alpha: 1),  // #2a78d6
        NSColor(srgbRed: 0.290, green: 0.227, blue: 0.655, alpha: 1),  // #4a3aa7
        NSColor(srgbRed: 0.910, green: 0.482, blue: 0.643, alpha: 1),  // #e87ba4
    ]
    let oscuro: [NSColor] = [
        NSColor(srgbRed: 0.224, green: 0.529, blue: 0.898, alpha: 1),  // #3987e5
        NSColor(srgbRed: 0.565, green: 0.522, blue: 0.914, alpha: 1),  // #9085e9
        NSColor(srgbRed: 0.835, green: 0.318, blue: 0.506, alpha: 1),  // #d55181
    ]
    return NSColor(name: nil) { ap in
        let tabla = ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? oscuro : claro
        return tabla[i % tabla.count]
    }
}

/// La marca de cada producto, dibujada: SF Symbols no trae ni la de Claude ni
/// la de Codex. El asterisco es la forma de la de Claude; los chevrones, código.
func glifoProducto(_ producto: String, _ color: NSColor, _ lado: CGFloat) -> NSImage {
    NSImage(size: NSSize(width: lado, height: lado), flipped: false) { r in
        let c = NSPoint(x: r.midX, y: r.midY)
        let t = NSBezierPath()
        t.lineWidth = 1.3
        t.lineCapStyle = .round
        if producto == "opencode" {
            // Un rombo: ni asterisco ni chevrones, y se distingue de los dos a
            // 9 px, que es lo único que se le pide a un glifo de barra.
            let r0 = lado * 0.34
            t.move(to: NSPoint(x: c.x, y: c.y + r0))
            t.line(to: NSPoint(x: c.x + r0, y: c.y))
            t.line(to: NSPoint(x: c.x, y: c.y - r0))
            t.line(to: NSPoint(x: c.x - r0, y: c.y))
            t.close()
        } else if producto == "codex" {
            // Los chevrones necesitan aire en el medio: pegados, y con la punta
            // redondeada, a 10 px se fusionan y el glifo se lee como una «o».
            let a = lado * 0.30, hueco = lado * 0.20
            t.move(to: NSPoint(x: c.x - hueco, y: c.y + a))
            t.line(to: NSPoint(x: c.x - hueco - a * 0.85, y: c.y))
            t.line(to: NSPoint(x: c.x - hueco, y: c.y - a))
            t.move(to: NSPoint(x: c.x + hueco, y: c.y + a))
            t.line(to: NSPoint(x: c.x + hueco + a * 0.85, y: c.y))
            t.line(to: NSPoint(x: c.x + hueco, y: c.y - a))
        } else {
            let r0 = lado * 0.36
            for k in 0..<3 {
                let ang = Double(k) * Double.pi / 3
                t.move(to: NSPoint(x: c.x + r0 * CGFloat(cos(ang)), y: c.y + r0 * CGFloat(sin(ang))))
                t.line(to: NSPoint(x: c.x - r0 * CGFloat(cos(ang)), y: c.y - r0 * CGFloat(sin(ang))))
            }
        }
        color.setStroke()
        t.stroke()
        return true
    }
}

func nivelDe(_ pct: Int, preocupa: Bool) -> Nivel {
    if pct >= 95 { return .critico }
    if preocupa || pct >= 80 { return .aviso }
    if pct >= 60 { return .atento }
    return .ok
}

// ── formato ──────────────────────────────────────────────────────────────
/// `.claude-teams` -> `teams`; el perfil por defecto -> `main`.
func corto(_ nombre: String) -> String {
    var n = nombre
    if n.hasPrefix(".claude") { n.removeFirst(".claude".count) }
    while n.hasPrefix("-") { n.removeFirst() }
    return n.isEmpty ? "main" : n
}

/// La escalera de duración del proyecto.
///
/// El canon es `duracion()` en src/render/barras.ts —por donde pasa todo lo que
/// imprime el CLI— y está congelado en test/fixtures/duraciones.json.
/// `make gate-duraciones` corre las cuatro implementaciones y las compara.
///
/// Antes esta decía "ya", "1h" y "1d0h" donde el CLI decía "vencido", "1h00m" y
/// "1d". Eran dos convenciones conviviendo, y sobrevivieron porque nadie había
/// comparado una GUI contra el CLI.
func duracion(_ segundos: Int) -> String {
    if segundos < 0 { return "vencido" }
    let h = segundos / 3600, m = (segundos % 3600) / 60
    if h >= 24 { return h % 24 == 0 ? "\(h / 24)d" : "\(h / 24)d\(h % 24)h" }
    if h > 0 { return String(format: "%dh%02dm", h, m) }
    if m > 0 { return "\(m)m" }
    return "\(segundos)s"
}

func barraTexto(_ pct: Int) -> String {
    let llenos = max(0, min(ANCHO_BARRA, Int((Double(pct) / 100.0 * Double(ANCHO_BARRA)).rounded())))
    return String(repeating: "█", count: llenos) + String(repeating: "░", count: ANCHO_BARRA - llenos)
}

// ── el dato ──────────────────────────────────────────────────────────────
struct Ventana {
    let clave: String
    let alcance: String?
    let porcentaje: Int
    let severidad: String
    let activa: Bool
    let reinicia: Date?
    let grupo: String?
    /// Lo decide qm, no acá.
    let preocupa: Bool
    /// Cuándo se leyó ESTA barra, sólo cuando es de una lectura más vieja que
    /// la cuenta: desde `qm --statusline` la sesión y la semanal pueden ser de
    /// recién y el resto de la última lectura del endpoint. nil = la de la
    /// cuenta. Con valor por defecto para que el `Lider` no tenga que pasarlo.
    var medidoEn: Date? = nil

    var nombre: String { alcance == nil ? clave : "\(clave) (\(alcance!))" }

    /// Los segundos desde que se leyó esta barra: la suya si la trae, la de la
    /// cuenta si no.
    func edad(_ deLaCuenta: Int?) -> Int? {
        medidoEn.map { max(0, Int(-$0.timeIntervalSinceNow)) } ?? deLaCuenta
    }
}

struct Proyeccion {
    let ritmo: Double
    let techo: Date
    let chocas: Bool
}

/// El presupuesto diario, ya repartido por qm: cuánto se puede gastar por día
/// para que la ventana larga llegue justa al reinicio, y cuánto de eso queda
/// hoy. Cuál ventana se reparte lo decide el núcleo —la larga, nunca la de
/// 5 h—, así que acá no hay ni una división.
///
/// Es un enum y no un par de opcionales porque el caso «no se puede repartir»
/// tiene que producir una FRASE: un renglón en blanco es el bug que esta
/// herramienta existe para no cometer.
enum Presupuesto {
    /// `gastado` es lo que subió la barra desde `desde`, cuando se pudo medir;
    /// `cubreElDia` dice si ese `desde` es la medianoche o la hora a la que se
    /// prendió la máquina. La diferencia es la que separa «gastaste 12 % hoy»
    /// de «gastaste 12 % desde las 11:54», y no se puede borrar: llamar «hoy» a
    /// un tramo que empieza al mediodía es decir de menos con cara de exacto.
    /// `porDiaHoy` es el presupuesto fijado al arrancar la medición y `restante`
    /// la resta ya hecha por qm. Restar `gastado` de `porDia` —que es el de ahora
    /// en adelante y ya lo tiene descontado— contaba cada punto dos veces.
    case reparte(porDia: Double, porDiaHoy: Double, quedaHoy: Double,
                 gastado: Double?, restante: Double?, desde: Date?, cubreElDia: Bool)
    case no(String)

    /// Qué parte del presupuesto de HOY ya se gastó, en porcentaje de ese
    /// presupuesto: lo que llena el medidor de cada cuenta.
    ///
    /// La semanal contestaba «cuánto va del período», que en un medidor de
    /// 15 pt se mueve dos píxeles por día: a media semana estaba siempre por la
    /// mitad y no decía nada de la sesión de trabajo de hoy. El presupuesto
    /// diario sí: llega al tope cuando gastaste lo que te tocaba hoy.
    ///
    /// `nil` es «no se pudo medir» y deja la pista vacía, nunca un cero.
    var pctDiario: Int? {
        guard case let .reparte(_, porDiaHoy, _, gastado, _, _, _) = self, let g = gastado else { return nil }
        // Sin presupuesto —la ventana ya está en 100 %— cualquier gasto es de más.
        guard porDiaHoy > 0 else { return g > 0 ? 100 : 0 }
        return Int(max(0, min(100, (g / porDiaHoy * 100).rounded())))
    }
}

/// Lo que hay que decir de una cuenta arriba: la sesión de 5 h, la barra que
/// frena antes, y dos banderas que NO son lo mismo.
///
/// `viejo` califica al número —este 23 es de hace rato— así que viaja pegado a
/// él, como `~23`. `alerta` es del estado de la cuenta, y ese NO se escribe al
/// lado del número de la sesión: el aviso puede ser de la barra semanal, y un
/// `23!` diría que lo alarmante es la sesión, que es falso. La alerta la lleva
/// el color del medidor de la derecha, que es justamente el de esa barra.
/// Dos canales por cuenta, cada uno SIEMPRE con el mismo significado: el
/// medidor es la sesión de 5 h —la ventana que frena ahora— y el número es esa
/// misma sesión escrita, para poder leerla sin medir el alto a ojo.
///
/// Antes el medidor mostraba «la que frena antes», que a veces era la semanal y
/// a veces la sesión — y cuando era la sesión, dibujaba lo mismo que ya decía
/// el número al lado. Un encoding que cambia de significado según el dato no se
/// puede leer de un vistazo, que es lo único que hace la barra de menú.
struct Trozo {
    let nombre: String
    let producto: String
    let indice: Int
    /// La sesión de 5 h, si el plan la tiene.
    let sesion: Int?
    let sesionAlerta: Bool
    /// La peor de las semanales: «¿llego al final?». Ya no va como medidor —se
    /// movía dos píxeles por día, así que a media semana estaba siempre por la
    /// mitad— pero sigue contando para el aviso.
    let semanal: Int?
    let semanalAlerta: Bool
    /// La ventana corta: «¿puedo seguir ahora?». Va como medidor y como número.
    /// Es la sesión o, si el plan no tiene sesión —Codex Pro, medido el
    /// 2026-09-27: `sesion: null` y sólo `weekly_all`—, la semanal: ahí ES la
    /// que te frena ahora, y sin ella la cuenta quedaba sin número ni medidor.
    var corta: Int? { sesion ?? semanal }
    var cortaAlerta: Bool { sesion != nil ? sesionAlerta : semanalAlerta }
    /// Cuánto del presupuesto de HOY ya se gastó. No se dibuja: va en la
    /// descripción accesible, donde sí hay lugar para los tres números.
    let diario: Int?
    let viejo: Bool
    /// Lo que hace falta para decidir si se le pregunta al endpoint: el nombre
    /// completo del perfil —el que entiende `--cuentas`—, cuándo se reinicia
    /// cada ventana y cuándo se usó por última vez.
    let perfil: String
    let reiniciaSesion: Date?
    let reiniciaSemanal: Date?
    let ultimoUso: Date?
}

/// Cuánto hace que se usó una cuenta para contarla como «la que estás usando».
/// El mismo valor que `ACTIVA_SEGUNDOS` en bin/qm-indicator.
let ACTIVA_SEGUNDOS: TimeInterval = 600

/// A qué cuentas se les pregunta en el próximo calentado. Es la regla de
/// `_vale_preguntar` en bin/qm-indicator, y scripts/gate-calentado.py comprueba
/// que las dos sigan diciendo lo mismo.
///
/// La barra usaba sólo `tope >= 40`, y eso dejaba afuera los dos casos que más
/// importan, los dos medidos en GNOME el 2026-09-13:
///   · la cuenta cuya ventana YA se reinició: su número es de una ventana que
///     cerró, y «te liberaste» es el aviso más útil que da el programa;
///   · la cuenta que estás usando AHORA aunque vaya al 2 %: es la única cuyo
///     número se está moviendo.
/// Y le preguntaba cada minuto a una barra clavada en 100 %, que no puede subir.
func valePreguntar(_ t: Trozo, ahora: Date = Date()) -> Bool {
    for r in [t.reiniciaSesion, t.reiniciaSemanal] {
        if let r, r <= ahora { return true }
    }
    if let uso = t.ultimoUso {
        let hace = ahora.timeIntervalSince(uso)
        if hace >= 0 && hace <= ACTIVA_SEGUNDOS { return true }
    }
    let tope = max(t.sesion ?? 0, t.semanal ?? 0)
    return 40 <= tope && tope < 100
}

struct PerfilVista {
    /// claude | codex. Lo único que distingue una cuenta de otra.
    let producto: String
    let nombre: String
    let directorio: String
    let cuenta: String?
    let plan: String?
    let credencial: String
    let hayNumero: Bool
    let frase: String?
    /// Ya filtradas por qm: las que vale la pena mostrar.
    let mostrar: [Ventana]
    /// Las muestras recientes de la barra que frena, ya recortadas por qm.
    let historia: [(t: Double, pct: Int)]
    /// La que frena antes, la sesión y la semanal — resueltas por qm.
    let frena: Ventana?
    let sesion: Ventana?
    let semanal: Ventana?
    let edadSegundos: Int?
    let proyeccion: Proyeccion?
    let presupuesto: Presupuesto?
    /// La barra que reparte el presupuesto, como la nombra el menú («Semanal (Fable)»).
    let barraPresupuesto: String?
    /// Cuándo se usó por última vez, según qm. Existe también en --breve.
    let ultimoUso: Date?
    /// Va al final y no encabeza. Lo decide qm; acá sólo se dibuja.
    let dormida: Bool
    /// Por qué, en palabras. Prosa para mostrar, no para parsear.
    let porque: [String]
}

/// Quién frena primero en toda la máquina, ya resuelto por qm.
///
/// Antes esto se decidía acá adentro, recorriendo los perfiles y quedándose con
/// el `frena` de porcentaje más alto. Era la misma elección escrita seis veces
/// —una por pantalla— y las seis coincidían sólo por casualidad: el día que el
/// criterio cambió (una cuenta dormida en 100 % ya no encabeza), cinco se
/// quedaron con el criterio viejo. CONTRIBUTING.md: una regla que un renderer
/// reimplementa es un bug del CLI.
struct Lider {
    let perfil: String
    let ventana: Ventana
    /// true si NO quedaba ninguna despierta: el encabezado es lo único que hay.
    let dormida: Bool
}

// Las reglas del núcleo no se reimplementan acá: `qm` manda `mostrar`, `frena`,
// `sesion` y `semanal` ya resueltas. Este archivo dibuja y nada más.

let fechaISO: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func fecha(_ s: Any?) -> Date? {
    guard let t = s as? String else { return nil }
    return fechaISO.date(from: t) ?? ISO8601DateFormatter().date(from: t)
}

// ── leer a qm ────────────────────────────────────────────────────────────
enum Lectura {
    case ok([PerfilVista], Lider?)
    /// Silencio es el bug: si no hay número, hay una frase.
    case falla(String)
}

func leer() -> Lectura {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: rutaQm())
    // --breve no toca las transcripciones: ~150 ms en vez de un segundo.
    p.arguments = ["--json", "--breve"]
    let salida = Pipe(), errores = Pipe()
    p.standardOutput = salida
    p.standardError = errores
    do { try p.run() } catch {
        return .falla("no pude correr qm: \(error.localizedDescription)")
    }
    let datos = salida.fileHandleForReading.readDataToEndOfFile()
    let feo = String(data: errores.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    p.waitUntilExit()

    // 3 es «alguna barra pasó el umbral», no un error.
    if p.terminationStatus != 0 && p.terminationStatus != 3 && datos.isEmpty {
        let primera = feo.split(separator: "\n").first.map(String.init) ?? "sin detalle"
        return .falla("qm salió \(p.terminationStatus): \(primera)")
    }
    guard let raiz = (try? JSONSerialization.jsonObject(with: datos)) as? [String: Any],
          let crudos = raiz["perfiles"] as? [[String: Any]] else {
        return .falla("qm no devolvió JSON")
    }

    let perfiles: [PerfilVista] = crudos.map { p in
        let cuota = p["cuota"] as? [String: Any] ?? [:]
        let hayNumero = (cuota["estado"] as? String) == "ok"
        func aVentana(_ v: [String: Any]) -> Ventana {
            Ventana(clave: v["clave"] as? String ?? "?",
                    alcance: v["alcance"] as? String,
                    porcentaje: v["porcentaje"] as? Int ?? 0,
                    severidad: v["severidad"] as? String ?? "normal",
                    activa: v["activa"] as? Bool ?? false,
                    reinicia: fecha(v["reinicia"]),
                    grupo: v["grupo"] as? String,
                    preocupa: v["preocupa"] as? Bool ?? false,
                    medidoEn: fecha(v["medidoEn"]))
        }
        let mostrar = (cuota["mostrar"] as? [[String: Any]] ?? []).map(aVentana)
        let historia: [(t: Double, pct: Int)] = (cuota["historia"] as? [[String: Any]] ?? []).compactMap {
            guard let t = $0["t"] as? Double, let p = $0["porcentaje"] as? Int else { return nil }
            return (t, p)
        }
        let una = { (k: String) -> Ventana? in (cuota[k] as? [String: Any]).map(aVentana) }
        var proy: Proyeccion? = nil
        if let pr = p["proyeccion"] as? [String: Any], (pr["estado"] as? String) == "sube",
           let techo = fecha(pr["techo"]) {
            proy = Proyeccion(ritmo: pr["ritmoPuntosPorHora"] as? Double ?? 0,
                              techo: techo,
                              chocas: pr["chocasAntesDelReinicio"] as? Bool ?? false)
        }
        var pre: Presupuesto? = nil
        if let pp = p["presupuesto"] as? [String: Any] {
            if (pp["estado"] as? String) == "ok" {
                // `gastadoHoy` es sólo el día entero; `gastadoMedido` es lo que
                // se midió aunque arranque más tarde, y es lo que dibuja el
                // medidor: una máquina que se apaga de noche no tiene nunca el
                // día entero, y un medidor que no dibuja nunca no es honesto.
                let porDia = pp["porDia"] as? Double ?? 0
                pre = .reparte(porDia: porDia,
                               // Un qm anterior no manda los dos campos nuevos: ahí
                               // queda la cuenta vieja antes que ninguna.
                               porDiaHoy: pp["porDiaHoy"] as? Double ?? porDia,
                               quedaHoy: pp["quedaHoy"] as? Double ?? 0,
                               gastado: pp["gastadoMedido"] as? Double,
                               restante: pp["restanteMedido"] as? Double,
                               desde: fecha(pp["medidoDesde"]),
                               cubreElDia: pp["cubreElDia"] as? Bool ?? false)
            } else if let motivo = pp["motivo"] as? String {
                pre = .no(motivo)
            }
        }
        var barraPre: String? = nil
        if let pp = p["presupuesto"] as? [String: Any], (pp["estado"] as? String) == "ok" {
            if let clave = pp["clave"] as? String {
                barraPre = etiquetaDe(Ventana(clave: clave, alcance: pp["alcance"] as? String, porcentaje: 0,
                                              severidad: "normal", activa: false, reinicia: nil, grupo: nil,
                                              preocupa: false))
            } else {
                barraPre = pp["barra"] as? String
            }
        }
        return PerfilVista(
            producto: p["producto"] as? String ?? "claude",
            nombre: p["perfil"] as? String ?? "?",
            directorio: p["directorio"] as? String ?? "",
            cuenta: p["cuenta"] as? String,
            // planNombre es el que se dibuja; `plan` queda para un qm anterior.
            plan: (p["planNombre"] as? String) ?? (p["plan"] as? String),
            credencial: p["credencial"] as? String ?? "?",
            hayNumero: hayNumero,
            frase: cuota["frase"] as? String,
            mostrar: mostrar, historia: historia,
            frena: una("frena"), sesion: una("sesion"), semanal: una("semanal"),
            edadSegundos: cuota["edadSegundos"] as? Int,
            proyeccion: proy,
            presupuesto: pre,
            barraPresupuesto: barraPre,
            ultimoUso: fecha(p["ultimoUso"]),
            dormida: ((p["relevancia"] as? [String: Any])?["dormida"] as? Bool) ?? false,
            porque: ((p["relevancia"] as? [String: Any])?["porque"] as? [String]) ?? [])
    }

    var lider: Lider? = nil
    if let l = raiz["frenaPrimero"] as? [String: Any],
       let nombre = l["perfil"] as? String,
       let v = l["ventana"] as? [String: Any] {
        lider = Lider(perfil: nombre,
                      ventana: Ventana(clave: v["clave"] as? String ?? "?",
                                       alcance: v["alcance"] as? String,
                                       porcentaje: v["porcentaje"] as? Int ?? 0,
                                       severidad: v["severidad"] as? String ?? "normal",
                                       activa: v["activa"] as? Bool ?? false,
                                       reinicia: fecha(v["reinicia"]),
                                       grupo: v["grupo"] as? String,
                                       preocupa: v["preocupa"] as? Bool ?? false,
                                       medidoEn: fecha(v["medidoEn"])),
                      dormida: (l["dormida"] as? Bool) ?? false)
    }
    return .ok(perfiles, lider)
}

// ── avisos ───────────────────────────────────────────────────────────────
/// Sin bundle no hay UNUserNotificationCenter, y osascript sí anda: es la vía
// que no obliga a empaquetar una .app para decir una frase.
//
// Se va sola, como en GNOME y Windows (AVISO_MS de bin/qm-indicator): macOS lo
// muestra como el banner temporal de Script Editor, unos 5 s, y lo deja en el
// centro de notificaciones. No hay urgencia que lo clave. Si se queda en
// pantalla es porque el estilo de Script Editor está en «Persistente» o
// «Alertas» en Ajustes › Notificaciones; sin bundle no hay API para cerrarlo.
func notificar(titulo: String, cuerpo: String) {
    let limpio: (String) -> String = { $0.replacingOccurrences(of: "\"", with: "'") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(limpio(cuerpo))\" with title \"\(limpio(titulo))\""]
    registrar("aviso: \(titulo) — \(cuerpo)")
    // Si osascript no sale 0 el aviso no se vio, y es el único rastro de eso.
    p.terminationHandler = { t in
        if t.terminationStatus != 0 { registrar("el aviso no salió: osascript salió \(t.terminationStatus)") }
    }
    do { try p.run() } catch { registrar("el aviso no salió: no pude correr osascript: \(error.localizedDescription)") }
}


// ── el menú, dibujado ────────────────────────────────────────────────────
// Las mismas piezas que el panel de GNOME (bin/qm-indicator: VistaResumen,
// VistaCuenta y VistaSinCuota), con la letra y los colores del sistema. Una
// cuenta es una NSView y no un NSMenuItem con texto porque el menú es donde se
// contesta la pregunta completa —qué barra, cuánto, cuándo se reinicia, a qué
// ritmo— y eso pide una grilla, no un renglón.
//
// Las vistas son `isFlipped`: se recorren de arriba para abajo, como se lee el
// menú y como está escrito el panel de GNOME. Y cada una mide y dibuja con el
// MISMO recorrido: un alto calculado aparte de lo que se pinta es cómo los
// renglones terminan pisándose, que es lo que pasó acá con la curva.

let ANCHO_MENU: CGFloat = 340
let MARGEN_MENU: CGFloat = 16

func letra(_ px: CGFloat, _ peso: NSFont.Weight = .regular) -> NSFont {
    .systemFont(ofSize: px, weight: peso)
}

/// Cifras de ancho fijo: sin esto el porcentaje, pegado al borde derecho, baila
/// un punto cada vez que cambia un dígito.
func cifras(_ px: CGFloat, _ peso: NSFont.Weight = .regular) -> NSFont {
    .monospacedDigitSystemFont(ofSize: px, weight: peso)
}

func medida(_ t: String, _ f: NSFont, kern: CGFloat = 0) -> CGSize {
    var atr: [NSAttributedString.Key: Any] = [.font: f]
    if kern != 0 { atr[.kern] = kern }
    return NSAttributedString(string: t, attributes: atr).size()
}

/// Un renglón de texto con (x, y) en su esquina de arriba a la izquierda. Con
/// `ancho` se corta con puntos suspensivos: AppKit no recorta nada por su
/// cuenta, y un nombre largo se dibujaría por encima del porcentaje.
func escribir(_ t: String, _ x: CGFloat, _ y: CGFloat, _ f: NSFont, _ c: NSColor,
              derecha: CGFloat? = nil, ancho: CGFloat? = nil, kern: CGFloat = 0) {
    var atr: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: c]
    if kern != 0 { atr[.kern] = kern }
    if ancho != nil {
        let p = NSMutableParagraphStyle()
        p.lineBreakMode = .byTruncatingTail
        atr[.paragraphStyle] = p
    }
    let a = NSAttributedString(string: t, attributes: atr)
    let s = a.size()
    let w = ancho.map { min($0, s.width) } ?? s.width
    let x0 = derecha.map { $0 - w } ?? x
    if ancho != nil {
        a.draw(with: NSRect(x: x0, y: y, width: max(1, w + 1), height: ceil(s.height)),
               options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    } else {
        a.draw(at: NSPoint(x: x0, y: y))
    }
}

/// Un relleno que se mezcla con lo de abajo. `NSRect.fill()` COPIA: con un
/// color translúcido deja un agujero del color de la tinta, no un velo.
func rellenar(_ r: NSRect, _ c: NSColor) {
    c.setFill()
    NSBezierPath(rect: r).fill()
}

/// El nombre de una barra para leer: «Semanal (Fable)», no «weekly_scoped
/// (Fable)». Es `etiqueta_de` de bin/qm-indicator: las mismas dos que reconoce
/// el núcleo, y cualquier otra con el nombre que trae. La clave sigue en la
/// terminal, que es donde se la busca en un log.
func etiquetaDe(_ v: Ventana) -> String {
    let base: String
    if v.grupo == "session" || v.clave == "session" || v.clave == "five_hour" {
        base = "Sesión"
    } else if v.grupo == "weekly" || v.clave.hasPrefix("weekly") || v.clave == "seven_day" {
        base = "Semanal"
    } else {
        return v.nombre
    }
    if let a = v.alcance { return "\(base) (\(a))" }
    return base
}

let DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]

/// El reinicio en hora de acá: «22:30» si es hoy, «jue 22:30» si no.
/// «reinicia en 3d1h» contesta cuánto falta; la hora contesta CUÁNDO, que es lo
/// que se usa para planear. Redondeada al minuto y no truncada: el servidor
/// informa 03:59:59.6, y eso son las 04:00.
func cuandoLocal(_ d: Date?, ahora: Date = Date()) -> String? {
    guard let d else { return nil }
    let c = d.addingTimeInterval(30)
    guard c >= ahora else { return nil }
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    let hora = f.string(from: c)
    let cal = Calendar.current
    if cal.isDate(c, inSameDayAs: ahora) { return hora }
    return "\(DIAS[cal.component(.weekday, from: c) - 1]) \(hora)"
}

/// «leída hace 24m», sólo cuando la barra trae su propia lectura: la de la
/// cuenta ya va arriba de la tarjeta, y repetirla en cada barra es ruido.
/// Pasada la hora de vieja, lo dice. Es `edad_de_barra` de bin/qm-indicator.
func edadDeBarra(_ v: Ventana) -> String? {
    guard v.medidoEn != nil, let e = v.edad(nil) else { return nil }
    return "leída hace \(duracion(e))" + (e >= VIEJO_SEGUNDOS ? " · vieja" : "")
}

/// Cada cuánto se lee la cuota de verdad: la mediana de los huecos entre
/// lecturas. La mediana y no el promedio: una sola pausa larga —la máquina
/// dormida— desplaza el promedio y no dice nada del ritmo normal.
func cadaCuanto(_ historia: [(t: Double, pct: Int)]) -> Int? {
    let ts = historia.map(\.t).sorted()
    let huecos = zip(ts, ts.dropFirst()).map { $1 - $0 }.filter { $0 > 0 }.sorted()
    guard !huecos.isEmpty else { return nil }
    return Int(huecos[huecos.count / 2] / 1000)
}

/// Lo que va entre acentos graves, en monoespaciada: `qm --refrescar` es un
/// comando para copiar. Sin cortes adentro: «qm --» en un renglón y
/// «statusline» en el otro ya no se puede copiar.
func conCodigo(_ texto: String, _ f: NSFont, _ c: NSColor) -> NSAttributedString {
    let partes = texto.components(separatedBy: "`")
    guard partes.count >= 3, partes.count % 2 == 1 else {
        return NSAttributedString(string: texto, attributes: [.font: f, .foregroundColor: c])
    }
    let mono = NSFont.monospacedSystemFont(ofSize: f.pointSize - 0.5, weight: .regular)
    let salida = NSMutableAttributedString()
    for (i, parte) in partes.enumerated() {
        if i % 2 == 1 {
            let pegado = parte.replacingOccurrences(of: " ", with: "\u{00A0}")
                .replacingOccurrences(of: "-", with: "-\u{2060}")
            salida.append(NSAttributedString(string: pegado, attributes: [.font: mono, .foregroundColor: c]))
        } else {
            salida.append(NSAttributedString(string: parte, attributes: [.font: f, .foregroundColor: c]))
        }
    }
    return salida
}

func altoDe(_ a: NSAttributedString, ancho: CGFloat) -> CGFloat {
    ceil(a.boundingRect(with: NSSize(width: ancho, height: 10_000), options: [.usesLineFragmentOrigin]).height)
}

/// Pista tenue y relleno con el color del estado. Un 0 % deja la pista sola: un
/// puntito de color diría que hay algo gastado.
func dibujarMedidor(_ x: CGFloat, _ y: CGFloat, _ ancho: CGFloat, _ alto: CGFloat, _ pct: Int, _ color: NSColor) {
    NSColor.labelColor.withAlphaComponent(0.13).setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: ancho, height: alto),
                 xRadius: alto / 2, yRadius: alto / 2).fill()
    guard pct > 0 else { return }
    let lleno = max(alto, ancho * CGFloat(min(100, pct)) / 100)
    color.setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: y, width: lleno, height: alto),
                 xRadius: alto / 2, yRadius: alto / 2).fill()
}

/// Un anillo que se llena desde arriba en el sentido del reloj. En una vista
/// invertida los ángulos crecen hacia abajo: -90 es arriba, y crecer es ir en
/// el sentido del reloj.
func dibujarAnillo(_ centro: NSPoint, _ radio: CGFloat, _ grosor: CGFloat, _ frac: CGFloat,
                   _ color: NSColor, _ pista: NSColor) {
    let fondo = NSBezierPath()
    fondo.appendArc(withCenter: centro, radius: radio, startAngle: 0, endAngle: 360)
    fondo.lineWidth = grosor
    pista.setStroke()
    fondo.stroke()
    let f = max(0, min(1, frac))
    guard f > 0 else { return }
    let arco = NSBezierPath()
    arco.appendArc(withCenter: centro, radius: radio, startAngle: -90, endAngle: -90 + 360 * f, clockwise: false)
    arco.lineWidth = grosor
    arco.lineCapStyle = .round
    color.setStroke()
    arco.stroke()
}

/// ↻, dibujada: el carácter sale de otra tipografía y otro grosor que el texto
/// de al lado. El círculo abierto arriba a la derecha, con la punta llena: a
/// este tamaño dos trazos finos no se leen como flecha.
func glifoReinicio(_ color: NSColor, _ x: CGFloat, _ y: CGFloat, _ lado: CGFloat) {
    let cx = x + lado / 2, cy = y + lado / 2 + 0.5, r = lado * 0.34
    let grados = { (rad: CGFloat) -> CGFloat in rad * 180 / CGFloat.pi }
    let arco = NSBezierPath()
    arco.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: r,
                   startAngle: grados(-CGFloat.pi / 2 + 1.35), endAngle: grados(3 * CGFloat.pi / 2 - 0.2),
                   clockwise: false)
    arco.lineWidth = 1.2
    arco.lineCapStyle = .round
    color.setStroke()
    arco.stroke()
    let h = lado * 0.36
    let tx = cx + 0.4, ty = cy - r
    let punta = NSBezierPath()
    punta.move(to: NSPoint(x: tx + h, y: ty))
    punta.line(to: NSPoint(x: tx - h * 0.25, y: ty - h * 0.75))
    punta.line(to: NSPoint(x: tx - h * 0.25, y: ty + h * 0.75))
    punta.close()
    color.setFill()
    punta.fill()
}

/// ↗: sube.
func glifoTendencia(_ color: NSColor, _ x: CGFloat, _ y: CGFloat, _ lado: CGFloat) {
    let a = lado * 0.2, b = lado * 0.8
    let p = NSBezierPath()
    p.lineWidth = 1.4
    p.lineCapStyle = .round
    p.lineJoinStyle = .round
    p.move(to: NSPoint(x: x + a, y: y + b))
    p.line(to: NSPoint(x: x + b, y: y + a))
    p.move(to: NSPoint(x: x + b - lado * 0.36, y: y + a))
    p.line(to: NSPoint(x: x + b, y: y + a))
    p.line(to: NSPoint(x: x + b, y: y + a + lado * 0.36))
    color.setStroke()
    p.stroke()
}

/// Una luna: la cuenta está, pero nadie la usa.
func glifoDormida(_ color: NSColor, _ x: CGFloat, _ y: CGFloat, _ lado: CGFloat) {
    let cx = x + lado / 2, cy = y + lado / 2, r = lado * 0.38
    let r2 = r * 0.85, ox = cx + r * 0.55, oy = cy - r * 0.45
    NSGraphicsContext.saveGraphicsState()
    let recorte = NSBezierPath(rect: NSRect(x: x - 1, y: y - 1, width: lado + 2, height: lado + 2))
    recorte.append(NSBezierPath(ovalIn: NSRect(x: ox - r2, y: oy - r2, width: 2 * r2, height: 2 * r2)))
    recorte.windingRule = .evenOdd
    recorte.addClip()
    color.setFill()
    NSBezierPath(ovalIn: NSRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)).fill()
    NSGraphicsContext.restoreGraphicsState()
}

/// La cabecera del menú: la respuesta de una línea. Es la misma pregunta que
/// contesta el héroe del tablero —qué me frena primero, en toda la máquina— y
/// va en una tarjeta teñida con el color del estado: es lo primero que se mira,
/// y el color dice si hace falta seguir leyendo antes de leer nada.
final class VistaResumen: NSView {
    private let cuenta: String
    private let barra: String
    private let pct: Int
    private let nivel: Nivel
    private let reinicia: Date?
    private let medidoEn: Date?
    static let ALTO: CGFloat = 86

    override var isFlipped: Bool { true }

    init?(_ lider: Lider?, _ perfiles: [PerfilVista]) {
        guard let l = lider else { return nil }
        let p = perfiles.first(where: { $0.nombre == l.perfil })
        let v = l.ventana
        cuenta = corto(p?.nombre ?? l.perfil)
        barra = etiquetaDe(v)
        pct = v.porcentaje
        nivel = nivelDe(v.porcentaje, preocupa: v.preocupa || (p?.proyeccion?.chocas ?? false))
        reinicia = v.reinicia
        medidoEn = v.medidoEn
        super.init(frame: NSRect(x: 0, y: 0, width: ANCHO_MENU, height: VistaResumen.ALTO))
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let caja = NSRect(x: 10, y: 8, width: bounds.width - 20, height: bounds.height - 14)
        let tarjeta = NSBezierPath(roundedRect: caja.insetBy(dx: 0.5, dy: 0.5), xRadius: 10, yRadius: 10)
        let oscuro = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        nivel.color.withAlphaComponent(oscuro ? 0.13 : 0.08).setFill()
        tarjeta.fill()
        nivel.color.withAlphaComponent(0.30).setStroke()
        tarjeta.lineWidth = 1
        tarjeta.stroke()

        let lado: CGFloat = 46
        let izq = caja.minX + 12
        dibujarAnillo(NSPoint(x: izq + lado / 2, y: caja.midY), lado / 2 - 3, 5.5,
                      CGFloat(min(100, max(0, pct))) / 100, nivel.color, nivel.color.withAlphaComponent(0.22))

        let x = izq + lado + 13
        let der = caja.maxX - 12
        escribir("LO PRIMERO QUE TE FRENA", x, caja.minY + 9, letra(9, .semibold), .tertiaryLabelColor,
                 ancho: der - x, kern: 0.6)
        let cifra = "\(pct)%"
        let fCifra = cifras(22, .bold)
        let wCifra = medida(cifra, fCifra).width
        let yCifra = caja.minY + 20
        escribir(cifra, x, yCifra, fCifra, .labelColor)
        // El nombre va a la derecha de la cifra, sobre su misma línea de base.
        let fNombre = letra(12.5, .medium)
        escribir("\(cuenta) · \(barra)", x + wCifra + 7, yCifra + fCifra.ascender - fNombre.ascender,
                 fNombre, .secondaryLabelColor, ancho: der - (x + wCifra + 7))

        // Cuando ya te frenó, lo que importa no es cuándo «reinicia»: es cuándo
        // volvés a poder trabajar. Misma fecha, otra pregunta.
        var texto: String
        var urgente = false
        if let r = reinicia {
            let falta = Int(r.timeIntervalSinceNow)
            if pct >= 95 {
                texto = "libre en \(duracion(falta))"
                urgente = true
            } else {
                texto = falta < 0 ? "reinicio vencido" : "reinicia en \(duracion(falta))"
            }
            if falta >= 0, let hora = cuandoLocal(r) { texto += " · \(hora)" }
        } else {
            texto = "sin reinicio informado"
        }
        // La edad propia de la barra que encabeza: suele ser de una lectura más
        // vieja que su cuenta, porque lo que frena puede ser una barra que sólo
        // trae el endpoint.
        if let m = medidoEn { texto += " · leída hace \(duracion(max(0, Int(-m.timeIntervalSinceNow))))" }
        escribir(texto, x, caja.maxY - 23, letra(11, urgente ? .medium : .regular),
                 urgente ? nivel.color : .secondaryLabelColor, ancho: der - x)
    }
}

/// Una cuenta con número.
///
/// Arriba quién es: el nombre con su plan, el mail, y de cuándo es el número.
/// Después un renglón por barra —el nombre, cuánto falta para el reinicio y el
/// porcentaje, con el medidor abajo—, y pegada a la barra que frena, su curva,
/// que sigue punteada hasta el reinicio. Al pie, separado por una línea, lo que
/// se deduce de todo eso: hacia dónde vas y cuánto te toca hoy.
final class VistaCuenta: NSView {
    private struct Fila {
        let etiqueta: String
        let pct: Int
        let nivel: Nivel
        let frena: Bool
        let reinicio: String?
        let edad: String?
        let vieja: Bool
    }

    /// Hacia dónde va la barra que frena, en la forma en que se dibuja a
    /// continuación de la curva: la MISMA recta que dice el renglón del ritmo, y
    /// sólo cuando ese renglón existe, así el dibujo y la frase no se
    /// contradicen nunca. Es `_hacia_donde` de bin/qm-indicator.
    private struct Futuro {
        let fin: Double
        let pFin: Double
        /// Dónde toca el 100 %, si lo toca antes del final del dibujo.
        let techo: Double?
        let techoTxt: String?
        let reinicioTxt: String?
    }

    private let titulo: String
    private let icono: NSImage?
    private let cuenta: String?
    private let plan: String?
    private let leida: String?
    private let vieja: Bool
    private let cada: String?
    private let frase: String?
    private let filas: [Fila]
    private let historia: [(t: Double, pct: Int)]
    private let ritmo: String?
    private let ritmoRojo: Bool
    private let futuro: Futuro?
    /// Los renglones del presupuesto: dos con número, uno con el motivo, ninguno sin cuota.
    private let presupuesto: [String]
    /// La barra que reparte el presupuesto, pegada al primer renglón: la tarjeta
    /// muestra tres ventanas y el número reparte UNA.
    private let barraPresupuesto: String?
    private let hoy: Int?
    private let dormida: String?

    private static let ALTO_ROTULO: CGFloat = 17
    private static let ALTO_MEDIDOR: CGFloat = 5
    private static let ENTRE_BARRAS: CGFloat = 10
    private static let ALTO_EDAD: CGFloat = 14
    private static let ALTO_CURVA: CGFloat = 22
    private static let ALTO_EJE: CGFloat = 13
    private static let ALTO_RENGLON: CGFloat = 15

    override var isFlipped: Bool { true }

    init(_ p: PerfilVista, icono: NSImage?) {
        self.titulo = corto(p.nombre)
        self.icono = icono
        self.cuenta = p.cuenta
        self.plan = p.plan
        self.historia = p.historia
        // Silencio es el bug: si no hay número, hay una frase.
        self.frase = p.hayNumero ? nil : (p.frase ?? "sin cuota")

        let frena = p.frena
        let chocas = p.proyeccion?.chocas ?? false
        // Por clave Y alcance: dos semanales con alcance distinto comparten la
        // clave `weekly_scoped`, y marcar las dos es marcar ninguna.
        let esLaQueFrena = { (v: Ventana) -> Bool in
            guard let f = frena else { return false }
            return v.clave == f.clave && v.alcance == f.alcance
        }
        self.filas = p.hayNumero ? p.mostrar.map { v in
            let falta = v.reinicia.map { Int($0.timeIntervalSinceNow) }
            let edad = edadDeBarra(v)
            return Fila(etiqueta: etiquetaDe(v), pct: v.porcentaje,
                        nivel: nivelDe(v.porcentaje, preocupa: v.preocupa || (chocas && esLaQueFrena(v))),
                        frena: esLaQueFrena(v),
                        reinicio: falta.map { $0 < 0 ? "vencido" : duracion($0) },
                        edad: edad,
                        vieja: edad?.hasSuffix("· vieja") ?? false)
        } : []

        // Un techo en el pasado ya no proyecta nada: se leía «100 % en 0s».
        // Cuando ya tocaste el techo la pregunta es cuándo te liberás, y ésa la
        // contesta la cabecera.
        var ritmoTxt: String? = nil
        if let pr = p.proyeccion {
            let falta = Int(pr.techo.timeIntervalSinceNow)
            if falta > 0 {
                ritmoTxt = String(format: "%.1f pts/h · 100 %% en %@%@", pr.ritmo, duracion(falta),
                                  pr.chocas ? " — antes del reinicio" : "")
            }
        }
        self.ritmo = ritmoTxt
        self.ritmoRojo = chocas
        self.futuro = ritmoTxt == nil ? nil : VistaCuenta.haciaDonde(p)

        // De cuándo es el número y cada cuánto se lee: «¿este número de cuándo
        // es?» no se contesta con un porcentaje.
        let edad = p.hayNumero ? p.edadSegundos : nil
        let esVieja = (edad ?? 0) >= VIEJO_SEGUNDOS
        self.vieja = esVieja
        self.leida = edad.map { "leída hace \(duracion($0))" + (esVieja ? " · vieja" : "") }
        self.cada = p.hayNumero ? cadaCuanto(p.historia).map { "cada ~\(duracion($0))" } : nil

        // Por qué esta cuenta quedó al fondo. Lo decidió qm y lo escribió en
        // palabras; acá sólo se dibuja.
        self.dormida = p.dormida ? "dormida: " + p.porque.joined(separator: " · ") : nil
        self.hoy = p.presupuesto?.pctDiario
        if case .reparte? = p.presupuesto, p.hayNumero {
            self.barraPresupuesto = p.barraPresupuesto
        } else {
            self.barraPresupuesto = nil
        }

        // El ritmo dice hacia dónde vas; el presupuesto, a cuánto tendrías que
        // ir para que la cuota llegue al reinicio. Van pegados: son la misma
        // pregunta. Sólo en las cuentas CON número — las otras dibujan su frase
        // y vuelven antes de llegar hasta acá.
        if let pre = p.presupuesto, p.hayNumero {
            switch pre {
            case .reparte(_, let porDiaHoy, let quedaHoy, let gastado, let restante, let desde, let cubreElDia):
                // Las mismas tres ramas que `frasePresupuesto` en el núcleo.
                // «hoy te queda X %» se leía como una resta que no ocurría —era
                // el reparto de las horas que faltaban del día, y bajaba solo
                // con el reloj sin gastar nada—. Lo que se resta de verdad es lo
                // gastado, y si el historial no cubre la mañana se dice desde
                // qué hora se lo midió en vez de llamarlo «hoy».
                // En DOS renglones, como la bandeja y GNOME: en uno solo el menú
                // cortaba la frase justo en «te queda X %», que es el número que
                // se viene a buscar. Visto en una captura del menú de la barra.
                // `porDiaHoy` y `restante` vienen de qm: el presupuesto fijado al
                // arrancar la medición y la resta ya hecha. `porDia - g` contaba
                // dos veces lo gastado hoy; queda sólo para un qm anterior.
                let dia = String(format: "podés gastar %.1f %%/día", porDiaHoy)
                if let g = gastado, cubreElDia {
                    self.presupuesto = [dia, String(format: "gastaste %.1f %% hoy · te queda %.1f %%",
                                                    g, restante ?? max(0, porDiaHoy - g))]
                } else if let g = gastado, let d = desde {
                    let hhmm = DateFormatter()
                    hhmm.dateFormat = "HH:mm"
                    self.presupuesto = [dia, String(format: "gastaste %.1f %% desde las %@ · te queda %.1f %%",
                                                    g, hhmm.string(from: d), restante ?? max(0, porDiaHoy - g))]
                } else {
                    self.presupuesto = [dia, String(format: "de acá a medianoche te toca %.1f %%", quedaHoy)]
                }
            case .no(let motivo):
                self.presupuesto = ["presupuesto: \(motivo)"]
            }
        } else {
            self.presupuesto = []
        }

        super.init(frame: NSRect(x: 0, y: 0, width: ANCHO_MENU, height: 10))
        setFrameSize(NSSize(width: ANCHO_MENU, height: recorrer(dibujar: false)))
    }

    required init?(coder: NSCoder) { nil }

    private static func haciaDonde(_ p: PerfilVista) -> Futuro? {
        guard let pr = p.proyeccion, let frena = p.frena, p.historia.count >= 3 else { return nil }
        let ahora = Date().timeIntervalSince1970 * 1000
        let techo = pr.techo.timeIntervalSince1970 * 1000
        guard techo > ahora else { return nil }
        let t0 = p.historia[p.historia.count - 1].t
        let p0 = Double(frena.porcentaje)
        let reinicio: Double? = frena.reinicia.map { $0.timeIntervalSince1970 * 1000 }.flatMap { $0 > ahora ? $0 : nil }
        let fin: Double
        let pFin: Double
        if pr.chocas || reinicio == nil {
            fin = (reinicio ?? 0) > techo ? reinicio! : techo
            pFin = 100
        } else {
            fin = reinicio!
            pFin = min(100, p0 + pr.ritmo * (fin - t0) / 3_600_000)
        }
        guard fin > t0 else { return nil }
        return Futuro(fin: fin, pFin: pFin,
                      techo: (pFin >= 100 && techo < fin) ? techo : nil,
                      techoTxt: pFin >= 100 ? cuandoLocal(pr.techo) : nil,
                      reinicioTxt: reinicio == nil ? nil : cuandoLocal(frena.reinicia))
    }

    /// Con la proyección la curva lleva el doble de cosas: más alta, para que la
    /// pendiente del pasado no quede aplastada contra el piso.
    private var altoCurva: CGFloat { futuro == nil ? VistaCuenta.ALTO_CURVA : 30 }

    /// La curva va pegada a la barra que frena: es de ella.
    private func conCurva(_ b: Fila) -> Bool { b.frena && historia.count >= 3 }

    /// Si la serie no se movió, se dice en palabras en vez de dibujarlo: una
    /// curva plana se leía como un dibujo que no terminó de cargar.
    private func sinCambios() -> String? {
        let ps = historia.map(\.pct)
        guard let a = ps.min(), let b = ps.max(), a == b,
              let t0 = historia.map(\.t).min(), let t1 = historia.map(\.t).max() else { return nil }
        let horas = (t1 - t0) / 3_600_000
        return horas < 1 ? "sin cambios en la última hora"
            : String(format: "sin cambios en las últimas %.1f h", horas)
    }

    override func draw(_ dirtyRect: NSRect) {
        _ = recorrer(dibujar: true)
    }

    /// El único lugar que sabe dónde va cada cosa. Sin `dibujar` sólo mide.
    private func recorrer(dibujar: Bool) -> CGFloat {
        let ix = MARGEN_MENU
        let ancho = ANCHO_MENU - 2 * MARGEN_MENU
        let der = ix + ancho
        let nx = ix + 20
        var y: CGFloat = 11

        // ── quién es ──
        let fLeida = letra(10.5, vieja ? .medium : .regular)
        let w1 = leida.map { medida($0, fLeida).width } ?? 0
        let hueco = der - nx - (leida != nil ? w1 + 10 : 0)
        let fTitulo = letra(13.5, .semibold)
        let wTitulo = min(medida(titulo, fTitulo).width, hueco)
        let fPlan = letra(10, .medium)
        var planArriba: CGFloat? = nil
        if let pl = plan {
            let wPlan = medida(pl, fPlan).width + 12
            let lugar = hueco - wTitulo - 8
            if lugar >= min(wPlan, 48) { planArriba = min(wPlan, lugar) }
        }
        if dibujar {
            icono?.draw(in: NSRect(x: ix, y: y + 2, width: 13, height: 13), from: .zero,
                        operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            escribir(titulo, nx, y, fTitulo, .labelColor, ancho: wTitulo)
            if let w = planArriba, let pl = plan {
                let cx = nx + wTitulo + 8
                NSColor.labelColor.withAlphaComponent(0.08).setFill()
                NSBezierPath(roundedRect: NSRect(x: cx, y: y + 1, width: w, height: 16), xRadius: 8, yRadius: 8).fill()
                escribir(pl, cx + 6, y + 2.5, fPlan, .secondaryLabelColor, ancho: w - 12)
            }
            if let l = leida {
                escribir(l, 0, y + 2, fLeida, vieja ? Nivel.aviso.color : .tertiaryLabelColor, derecha: der)
            }
        }
        y += 20

        let izquierda2 = [cuenta, planArriba == nil ? plan : nil].compactMap { $0 }.joined(separator: " · ")
        if !izquierda2.isEmpty || cada != nil {
            if dibujar {
                let f2 = letra(10.5)
                let w2 = cada.map { medida($0, f2).width } ?? 0
                if !izquierda2.isEmpty {
                    escribir(izquierda2, nx, y, letra(11), .tertiaryLabelColor,
                             ancho: der - nx - (cada != nil ? w2 + 10 : 0))
                }
                if let c = cada { escribir(c, 0, y, f2, .tertiaryLabelColor, derecha: der) }
            }
            y += 15
        }
        y += 10

        if let f = frase {
            let a = conCodigo(f, letra(11.5), .secondaryLabelColor)
            let alto = altoDe(a, ancho: ancho)
            if dibujar {
                a.draw(with: NSRect(x: ix, y: y, width: ancho, height: alto), options: [.usesLineFragmentOrigin])
            }
            return y + alto + 12
        }

        // ── las barras ──
        for b in filas {
            if dibujar {
                let color = b.nivel.color
                let cifra = "\(b.pct)%"
                let fCifra = cifras(12.5, .bold)
                let wCifra = medida(cifra, fCifra).width
                escribir(cifra, 0, y - 1, fCifra, .labelColor, derecha: der)
                var finRotulo = der - wCifra - 10
                if let r = b.reinicio {
                    let fR = cifras(10.5)
                    let xR = der - wCifra - 10 - medida(r, fR).width
                    escribir(r, xR, y + 0.5, fR, .tertiaryLabelColor)
                    glifoReinicio(.tertiaryLabelColor, xR - 12, y + 2.5, 9.5)
                    finRotulo = xR - 12 - 8
                }
                if b.frena {
                    // La que frena se marca en el margen, como en la terminal.
                    let t = NSBezierPath()
                    t.move(to: NSPoint(x: ix - 9, y: y + 4.5))
                    t.line(to: NSPoint(x: ix - 4.5, y: y + 8))
                    t.line(to: NSPoint(x: ix - 9, y: y + 11.5))
                    t.close()
                    color.setFill()
                    t.fill()
                }
                escribir(b.etiqueta, ix, y, letra(12, b.frena ? .semibold : .regular),
                         b.frena ? .labelColor : .secondaryLabelColor, ancho: max(40, finRotulo - ix))
                dibujarMedidor(ix, y + VistaCuenta.ALTO_ROTULO, ancho, VistaCuenta.ALTO_MEDIDOR, b.pct, color)
            }
            y += VistaCuenta.ALTO_ROTULO + VistaCuenta.ALTO_MEDIDOR
            let quieta = conCurva(b) ? sinCambios() : nil
            let pie = [b.edad, quieta].compactMap { $0 }.joined(separator: " · ")
            if !pie.isEmpty {
                if dibujar {
                    escribir(pie, ix, y + 3, letra(10), b.vieja ? Nivel.aviso.color : .tertiaryLabelColor, ancho: ancho)
                }
                y += VistaCuenta.ALTO_EDAD
            }
            if conCurva(b) && quieta == nil {
                y += 7
                if dibujar { dibujarCurva(NSRect(x: ix, y: y, width: ancho, height: altoCurva), b.nivel.color) }
                y += altoCurva + VistaCuenta.ALTO_EJE
            }
            y += VistaCuenta.ENTRE_BARRAS
        }

        // ── lo que se deduce ──
        let renglones = (ritmo != nil ? 1 : 0) + presupuesto.count + (dormida != nil ? 1 : 0)
        if renglones == 0 { return y - VistaCuenta.ENTRE_BARRAS + 12 }
        if dibujar { rellenar(NSRect(x: ix, y: y, width: ancho, height: 1), NSColor.labelColor.withAlphaComponent(0.10)) }
        y += 9
        let tx = ix + 19
        if let r = ritmo {
            if dibujar {
                let color: NSColor = ritmoRojo ? Nivel.critico.color : .tertiaryLabelColor
                glifoTendencia(color, ix + 1, y + 1.5, 11)
                escribir(r, tx, y, letra(11, ritmoRojo ? .medium : .regular), color, ancho: der - tx)
            }
            y += VistaCuenta.ALTO_RENGLON
        }
        if !presupuesto.isEmpty {
            if dibujar {
                // Al lado, un anillo con lo gastado de hoy: el mismo medidor que
                // tiene la cuenta en la barra de arriba, y que el menú nunca
                // explicaba.
                let medio = y + CGFloat(presupuesto.count) * VistaCuenta.ALTO_RENGLON / 2 - 1
                dibujarAnillo(NSPoint(x: ix + 6.5, y: medio), 5, 2.2, CGFloat(hoy ?? 0) / 100,
                              nivelDe(hoy ?? 0, preocupa: false).color, NSColor.labelColor.withAlphaComponent(0.15))
                for (i, r) in presupuesto.enumerated() {
                    let texto = (i == 0 && barraPresupuesto != nil) ? "\(r) · \(barraPresupuesto!)" : r
                    escribir(texto, tx, y + CGFloat(i) * VistaCuenta.ALTO_RENGLON, letra(11),
                             .secondaryLabelColor, ancho: der - tx)
                }
            }
            y += CGFloat(presupuesto.count) * VistaCuenta.ALTO_RENGLON
        }
        if let d = dormida {
            if dibujar {
                glifoDormida(.tertiaryLabelColor, ix + 1, y + 1.5, 11)
                escribir(d, tx, y, letra(10.5), .tertiaryLabelColor, ancho: der - tx)
            }
            y += VistaCuenta.ALTO_RENGLON
        }
        return y + 9
    }

    /// Las muestras recientes, dibujadas. El eje Y va del mínimo al máximo de
    /// la serie y no de 0 a 100: lo que interesa acá es la PENDIENTE, y a escala
    /// completa una subida de tres puntos se ve plana. Por eso abajo dice de
    /// cuánto a cuánto fue.
    private func dibujarCurva(_ caja: NSRect, _ color: NSColor) {
        let x0 = caja.minX, y0 = caja.minY, w = caja.width, h = caja.height
        let ts = historia.map(\.t), ps = historia.map { Double($0.pct) }
        guard let tMin = ts.min(), let tMax = ts.max(), tMax > tMin,
              let pMin = ps.min(), let pMaxSerie = ps.max() else { return }
        let fut = futuro
        let pMax = fut.map { max(pMaxSerie, $0.pFin) } ?? pMaxSerie
        let rango = max(1, pMax - pMin)
        let xFin = x0 + w - 3
        // Pasado y futuro en UNA escala de tiempo cuando entran: la recta sigue
        // derecha y la pendiente se compara a ojo. Una semanal con el reinicio a
        // días dejaría el pasado en un punto, así que ahí el pasado se queda con
        // un tercio y la raya de «ahora» avisa que la escala cambia.
        let xAhora: CGFloat
        if let f = fut {
            let pasado = tMax - tMin, porVenir = f.fin - tMax
            let parte = porVenir <= 2 * pasado ? pasado / (pasado + porVenir) : 0.34
            xAhora = x0 + (xFin - x0) * CGFloat(parte)
        } else {
            xAhora = xFin
        }
        let px = { (t: Double) -> CGFloat in
            if t <= tMax { return x0 + (xAhora - x0) * CGFloat((t - tMin) / (tMax - tMin)) }
            guard let f = fut else { return xFin }
            return xAhora + (xFin - xAhora) * CGFloat((t - tMax) / (f.fin - tMax))
        }
        let py = { (p: Double) -> CGFloat in y0 + 2 + (h - 4) * CGFloat(1 - (p - pMin) / rango) }

        if let f = fut {
            dibujarFuturo(f, px: px, py: py, caja: caja, color: color, desde: (ts[ts.count - 1], ps[ps.count - 1]))
        }

        let area = NSBezierPath()
        area.move(to: NSPoint(x: px(ts[0]), y: y0 + h))
        for (t, p) in zip(ts, ps) { area.line(to: NSPoint(x: px(t), y: py(p))) }
        area.line(to: NSPoint(x: px(ts[ts.count - 1]), y: y0 + h))
        area.close()
        // En una vista invertida, 90° va de arriba hacia abajo: tinta arriba,
        // nada abajo.
        NSGradient(starting: color.withAlphaComponent(0.30), ending: color.withAlphaComponent(0.02))?
            .draw(in: area, angle: 90)

        let linea = NSBezierPath()
        linea.lineWidth = 1.5
        linea.lineJoinStyle = .round
        linea.move(to: NSPoint(x: px(ts[0]), y: py(ps[0])))
        for (t, p) in zip(ts, ps).dropFirst() { linea.line(to: NSPoint(x: px(t), y: py(p))) }
        color.setStroke()
        linea.stroke()

        // El punto de ahora, que es el que se mira.
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: px(ts[ts.count - 1]) - 2.5, y: py(ps[ps.count - 1]) - 2.5,
                                    width: 5, height: 5)).fill()

        let horas = (tMax - tMin) / 3_600_000
        let desde = ps[0], hasta = ps[ps.count - 1]
        let rotulo = desde.rounded() != hasta.rounded()
            ? String(format: "%.0f → %.0f %%", desde, hasta)
            : String(format: "%.0f %%, sin cambios", hasta)
        let yEje = y0 + h + 2
        let fEje = cifras(9.5)
        guard let f = fut else {
            escribir(rotulo, x0, yEje, fEje, .tertiaryLabelColor)
            escribir(horas >= 1 ? String(format: "últimas %.1f h", horas) : "última hora",
                     0, yEje, fEje, .tertiaryLabelColor, derecha: x0 + w)
            return
        }

        // Con la proyección van tres rótulos: cuándo reinicia (al final), cuándo
        // toca el 100 % (debajo de ese punto) y de cuánto a cuánto fue (debajo
        // del pasado). Si no entran, se cae primero el del pasado, que es el
        // único que la curva ya dice sola.
        let critico = Nivel.critico.color
        let der: String
        let colorDer: NSColor
        if f.techo != nil {
            der = f.reinicioTxt.map { "reinicio \($0)" } ?? "reinicio"
            colorDer = .tertiaryLabelColor
        } else if f.pFin >= 100 {
            der = f.techoTxt.map { "100 % \($0)" } ?? "100 %"
            colorDer = critico
        } else {
            der = String(format: "~%.0f %% al reinicio", f.pFin) + (f.reinicioTxt.map { " · \($0)" } ?? "")
            colorDer = .tertiaryLabelColor
        }
        escribir(der, 0, yEje, fEje, colorDer, derecha: x0 + w)
        var libre = x0 + w - medida(der, fEje).width - 10
        if let techo = f.techo {
            let medio = f.techoTxt.map { "100 % \($0)" } ?? "100 %"
            let fMedio = cifras(9.5, .medium)
            let wMedio = medida(medio, fMedio).width
            let xm = max(x0, min(px(techo) - wMedio / 2, libre - wMedio))
            if xm + wMedio <= libre + 0.5 {
                escribir(medio, xm, yEje, fMedio, critico)
                libre = xm - 10
            }
        }
        if x0 + medida(rotulo, fEje).width <= libre {
            escribir(rotulo, x0, yEje, fEje, .tertiaryLabelColor)
        }
    }

    /// La recta punteada desde el último punto hasta el reinicio. Punteada porque
    /// no es un dato: es lo que pasa si seguís a este ritmo. Si toca el 100 %
    /// antes del reinicio, de ahí en adelante el tramo va en rojo y dice cuánto
    /// tiempo serías sin cuota.
    private func dibujarFuturo(_ f: Futuro, px: (Double) -> CGFloat, py: (Double) -> CGFloat,
                               caja: NSRect, color: NSColor, desde: (Double, Double)) {
        let x0 = caja.minX, y0 = caja.minY, w = caja.width, h = caja.height
        let xa = px(desde.0), ya = py(desde.1)
        let xt = px(f.techo ?? f.fin), yt = py(f.pFin)
        let xf = px(f.fin)
        let critico = Nivel.critico.color

        // «Ahora»: la raya que separa lo medido de lo supuesto.
        let ahora = NSBezierPath()
        ahora.lineWidth = 1
        ahora.setLineDash([1.5, 2.0], count: 2, phase: 0)
        ahora.move(to: NSPoint(x: xa.rounded() + 0.5, y: y0))
        ahora.line(to: NSPoint(x: xa.rounded() + 0.5, y: y0 + h))
        NSColor.tertiaryLabelColor.setStroke()
        ahora.stroke()

        if let techo = f.techo {
            // El tiempo sin cuota: del techo al reinicio.
            rellenar(NSRect(x: xt, y: y0, width: x0 + w - xt, height: h), critico.withAlphaComponent(0.13))
            let tope = NSBezierPath()
            tope.lineWidth = 2
            tope.move(to: NSPoint(x: xt + 2.6, y: yt))
            tope.line(to: NSPoint(x: xf, y: yt))
            critico.setStroke()
            tope.stroke()
            let texto = "sin cuota \(duracion(Int((f.fin - techo) / 1000)))"
            let fT = letra(9.5, .medium)
            let tam = medida(texto, fT)
            if x0 + w - xt >= tam.width + 10 {
                escribir(texto, xt + (x0 + w - xt - tam.width) / 2, y0 + 3 + (h - 3 - tam.height) / 2, fT, critico)
            }
        }

        // Debajo de la recta, el mismo degradé que el pasado pero más tenue.
        let bajo = NSBezierPath()
        bajo.move(to: NSPoint(x: xa, y: y0 + h))
        bajo.line(to: NSPoint(x: xa, y: ya))
        bajo.line(to: NSPoint(x: xt, y: yt))
        bajo.line(to: NSPoint(x: xt, y: y0 + h))
        bajo.close()
        NSGradient(starting: color.withAlphaComponent(0.14), ending: color.withAlphaComponent(0))?
            .draw(in: bajo, angle: 90)

        // La recta termina en el borde del punto hueco y no en su centro.
        let radio: CGFloat = 2.6
        let largo = hypot(xt - xa, yt - ya)
        if largo > radio + 1 {
            let k = (largo - radio) / largo
            let recta = NSBezierPath()
            recta.lineWidth = 1.5
            recta.lineCapStyle = .round
            recta.setLineDash([3.0, 3.0], count: 2, phase: 0)
            recta.move(to: NSPoint(x: xa, y: ya))
            recta.line(to: NSPoint(x: xa + (xt - xa) * k, y: ya + (yt - ya) * k))
            color.setStroke()
            recta.stroke()
        }

        // Donde termina la recta: un punto hueco, porque no es una lectura.
        let punto = NSBezierPath(ovalIn: NSRect(x: xt - radio, y: yt - radio, width: 2 * radio, height: 2 * radio))
        punto.lineWidth = 1.4
        (f.pFin >= 100 ? critico : color).setStroke()
        punto.stroke()
    }
}

/// Las cuentas que todavía no tienen número de cuota, juntas: cada una ocupaba
/// una tarjeta entera para decir la misma frase. Juntas además se leen mejor:
/// no son tres misterios distintos, es un hecho con varios nombres.
final class VistaSinCuota: NSView {
    private var grupos: [(frase: String, nombres: [String])] = []

    override var isFlipped: Bool { true }

    init(_ cuentas: [(nombre: String, frase: String)]) {
        super.init(frame: NSRect(x: 0, y: 0, width: ANCHO_MENU, height: 10))
        // Agrupadas por frase y en el orden en que aparecieron: dos cuentas
        // pueden estar calladas por motivos distintos, y ahí la frase importa.
        for c in cuentas {
            if let i = grupos.firstIndex(where: { $0.frase == c.frase }) {
                grupos[i].nombres.append(c.nombre)
            } else {
                grupos.append((frase: c.frase, nombres: [c.nombre]))
            }
        }
        setFrameSize(NSSize(width: ANCHO_MENU, height: recorrer(dibujar: false)))
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        _ = recorrer(dibujar: true)
    }

    private func recorrer(dibujar: Bool) -> CGFloat {
        let ix = MARGEN_MENU, ancho = ANCHO_MENU - 2 * MARGEN_MENU
        var y: CGFloat = 11
        if dibujar {
            escribir("SIN NÚMERO DE CUOTA", ix, y, letra(9, .semibold), .tertiaryLabelColor, kern: 0.6)
        }
        y += 18
        for g in grupos {
            if dibujar {
                escribir(g.nombres.joined(separator: " · "), ix, y, letra(12, .medium), .secondaryLabelColor,
                         ancho: ancho)
            }
            y += 17
            let a = conCodigo(g.frase, letra(10.5), .tertiaryLabelColor)
            let alto = altoDe(a, ancho: ancho)
            if dibujar {
                a.draw(with: NSRect(x: ix, y: y, width: ancho, height: alto), options: [.usesLineFragmentOrigin])
            }
            y += alto + 9
        }
        return y + 2
    }
}

// ── la barra ─────────────────────────────────────────────────────────────
final class Barra: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var vigias: [DispatchSourceFileSystemObject] = []
    var vigilando: Set<String> = []
    /// Los avisos ya dados. **Se persisten**: eran de memoria nomás, así que
    /// cada arranque volvía a notificar todo lo que ya estaba cruzado — y
    /// arrancar pasa seguido (reinstalar, actualizar, reiniciar sesión). Un
    /// aviso marca un cruce; repetirlo en cada arranque es ruido y enseña a
    /// ignorarlos, que es lo contrario de lo que tienen que hacer.
    var avisados: Set<String> = Barra.leerAvisados()

    static var rutaAvisados: String {
        let base = ProcessInfo.processInfo.environment["XDG_CACHE_HOME"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".cache")
        return (base as NSString).appendingPathComponent("quartermaster/avisados.json")
    }

    static func leerAvisados() -> Set<String> {
        guard let d = FileManager.default.contents(atPath: rutaAvisados),
              let a = try? JSONDecoder().decode([String].self, from: d) else { return [] }
        return Set(a)
    }

    func guardarAvisados() {
        // Las claves llevan el minuto de reinicio, así que envejecen solas; se
        // recorta igual para que el archivo no crezca para siempre.
        let recorte = Array(avisados.suffix(300))
        let url = URL(fileURLWithPath: Barra.rutaAvisados)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? JSONEncoder().encode(recorte).write(to: url)
    }
    var pendiente: DispatchWorkItem?
    var reloj: Timer?
    /// Cuándo terminó el último calentado, y si el vigía ya avisó de este corte.
    /// Es lo que mira `vigia`: la pregunta no es «¿está armado el timer?» —eso
    /// se puede creer y estar equivocado— sino «¿cuándo fue la última vez que
    /// de verdad le preguntamos al servidor?».
    var calentadoEn: Date?
    var vigiaAviso = false
    var relojVigia: Timer?
    /// Sin esto macOS le aplica App Nap —es una app sin ventanas— y los timers
    /// se corren minutos. Medido: un sondeo de 5 min que no disparó en 7.
    var actividad: NSObjectProtocol?
    /// Lo último que se vio, para decidir cada cuánto volver a mirar.
    var ultimas: [Trozo] = []
    var avisoBarraLlena = false
    /// Lo último que se anotó de cada cosa, para anotar CAMBIOS y no repetir:
    /// la posición se revisa en cada redibujo —un renglón por minuto, igual en
    /// cada vuelta— y un calentado roto falla en cada sondeo.
    var ultimaPosicion: [String: String] = [:]
    var ultimaFalla: String?
    var ultimoCalentado: String?
    /// Los motivos por cuenta ya anotados en esta corrida («.claude: sin credencial»).
    var motivosCalentado: Set<String> = []
    /// `perfil|barra` -> [minuto de reinicio, porcentaje] de la última vuelta.
    /// Persistido: es lo que permite notar que una ventana se dio vuelta.
    var previos: [String: [Int]] = Barra.leerPrevios()

    static var rutaPrevios: String {
        (Barra.rutaAvisados as NSString).deletingLastPathComponent + "/previos.json"
    }
    static func leerPrevios() -> [String: [Int]] {
        guard let d = FileManager.default.contents(atPath: rutaPrevios),
              let m = try? JSONDecoder().decode([String: [Int]].self, from: d) else { return [:] }
        return m
    }
    func guardarPrevios() {
        let url = URL(fileURLWithPath: Barra.rutaPrevios)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? JSONEncoder().encode(previos).write(to: url)
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        // Con autosaveName el sistema recuerda dónde lo dejó el usuario: en una
        // barra llena, cmd-arrastrar el item a un hueco es LA salida, y sin
        // esto se perdería en cada arranque.
        item.autosaveName = "quartermaster"
        // El renglón que separa una corrida de otra en el log: sin esto no se
        // sabe si dos líneas son del mismo proceso ni desde cuándo corre.
        registrar("arranca · qm=\(rutaQm()) · pid \(ProcessInfo.processInfo.processIdentifier)")
        item.button?.title = "qm…"
        item.menu = NSMenu()
        actividad = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "mirar la cuota a tiempo")
        refrescar()
        armarVigia()
        calentarCodex()
    }

    /// Cada cuánto volver a preguntar por Codex.
    ///
    /// Un intervalo fijo de 5 minutos es inservible para una barra que sube
    /// 1,6 puntos por minuto: se llega al 100 % dos veces adentro de una sola
    /// espera. La cadencia sale de lo que ya sabemos —cuán alto está y cuánto
    /// falta para el techo según la proyección—, que es exactamente para lo que
    /// existe la proyección.
    func cadencia() -> TimeInterval {
        let alto = ultimas.map { max($0.sesion ?? 0, $0.semanal ?? 0) }.max() ?? 0
        var segundos: TimeInterval = SEGUNDOS_SONDEO
        if alto >= 90 { segundos = MINIMO_RED }
        else if alto >= 75 { segundos = 120 }
        else if alto >= 50 { segundos = 240 }
        if let m = minutosAlTecho, m <= 30 { segundos = min(segundos, MINIMO_RED) }
        else if let m = minutosAlTecho, m <= 90 { segundos = min(segundos, 120) }
        return max(MINIMO_RED, segundos)
    }

    var minutosAlTecho: Double? = nil

    /// Agenda el próximo calentado, y NUNCA lo aleja.
    ///
    /// Esto se llama al final del armado del menú, y el menú se arma en cada
    /// `refrescar()` — que acá lo dispara el vigía de archivos, y Claude Code
    /// reescribe su .claude.json cada veinte segundos. Rearmar siempre
    /// significaba correr la fecha del calentado con cada escritura ajena:
    /// el calentado no llegaba a vencer nunca.
    ///
    /// Del lado de GNOME, que tiene la misma forma con el sondeo periódico en
    /// vez del vigía de archivos, pasó de verdad: medido el 2026-09-15, un solo
    /// calentado al arrancar y siete horas y media sin ninguno, con la bandera
    /// libre y un temporizador armado todo el tiempo —armado y reiniciado, que
    /// es distinto de disparado—.
    ///
    /// La regla es simple: una fecha más lejos que la que ya hay no reemplaza a
    /// nada. Apretar la cadencia sigue andando, porque ésa siempre es más cerca.
    func programar(forzando: Bool = false) {
        let cuanto = cadencia()
        let cuando = Date().addingTimeInterval(cuanto)
        // `forzando` es para el vigía: cuando el calentado está parado, la fecha
        // agendada YA VENCIÓ, así que cualquier fecha nueva es «más lejos» y la
        // guarda la rechazaría. La defensa contra el hambre desactivaba a la
        // defensa contra el silencio.
        if let r = reloj, r.isValid {
            if !forzando, cuando >= r.fireDate { return }
            // Forzando también tiene un límite: sólo reemplaza un reloj cuya
            // fecha YA PASÓ. El vigía corre cada minuto y, una vez que avisó,
            // llamaba a esto con `forzando` en cada vuelta: cada llamada
            // invalidaba el Timer de cinco minutos recién armado y ponía otro
            // de cinco minutos. Un reloj que se reemplaza cada 60 s con uno de
            // 300 s no dispara nunca. Medido el 2026-09-16: «lo rearmo» a las
            // 13:57 del día anterior, y desde ahí veinte horas sin un solo
            // calentado, con el proceso vivo, el token vigente desde las 09:32
            // y el vigía «rearmando» en silencio cada minuto. La defensa
            // contra el silencio se había vuelto la causa del silencio.
            if forzando, r.fireDate > Date() { return }
        }
        reloj?.invalidate()
        let t = Timer(timeInterval: cuanto, repeats: false) { _ in
            // Codex primero: su número no está en ningún disco hasta que
            // alguien lo pide, y el refresco de abajo lee del cache.
            self.calentarCodex()
        }
        // Sin tolerancia y en modo común: si no, el sistema los agrupa y los
        // corre, que es la mitad de lo que pasó acá.
        t.tolerance = 0
        RunLoop.main.add(t, forMode: .common)
        reloj = t
    }

    /// Que el calentado no pueda dejar de ocurrir en silencio.
    ///
    /// `programar()` arma un Timer de UNA sola vez, y el único lugar que lo
    /// vuelve a armar es el final del armado del menú. Cualquier corte en esa
    /// cadena apaga el calentado para toda la vida del proceso y sin ruido.
    ///
    /// Pasó del lado de GNOME, que tiene la misma forma: el 2026-09-15, con
    /// 0.1.13, el indicador de Linux dejó de preguntarle al endpoint y estuvo
    /// siete horas y media sin escribir una línea, con el proceso vivo y el
    /// item redibujándose. Acá no se esperó a que pasara.
    ///
    /// Esto mira desde afuera, se repite solo y no depende del calentado: si
    /// pasó el plazo sin una lectura, lo ANOTA una vez y lo rearma.
    func armarVigia() {
        // Con la hora de arranque y no en nil: si el PRIMER calentado nunca
        // termina, un vigía que espera a tener una marca no mira nunca.
        if calentadoEn == nil { calentadoEn = Date() }
        relojVigia?.invalidate()
        let t = Timer(timeInterval: VIGIA_SEGUNDOS, repeats: true) { [weak self] _ in
            self?.vigia()
        }
        t.tolerance = 0
        RunLoop.main.add(t, forMode: .common)
        relojVigia = t
    }

    func vigia() {
        guard let desde = calentadoEn else { return }
        let atraso = Date().timeIntervalSince(desde)
        guard atraso > VIGIA_PLAZO else {
            vigiaAviso = false
            return
        }
        // Una vez por corte, no una por minuto: el log tiene que poder leerse.
        if !vigiaAviso {
            registrar("el calentado no ocurre hace \(duracion(Int(atraso))): lo rearmo")
            vigiaAviso = true
        }
        programar(forzando: true)
    }

    /// Refresca las dos puntas —el endpoint de cada perfil de Claude y el de
    /// Codex— y deja los números en el cache de qm, para que las lecturas de la
    /// barra —que son `--breve`— sigan tardando milisegundos y encuentren algo
    /// reciente. Si falla, no pasa nada: se sigue mostrando lo viejo, con su
    /// edad a la vista.
    ///
    /// Para Claude hace falta porque Claude Code refresca su propio cache
    /// cuando quiere: medido, 83 minutos sin tocarlo mientras reescribía el
    /// archivo cada 20 s, con la sesión 11 puntos abajo de la realidad.
    func calentarCodex() {
        DispatchQueue.global(qos: .utility).async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: rutaQm())
            // Sólo las cuentas que tienen algo nuevo para contar (ver
            // valePreguntar). Van con el nombre COMPLETO del perfil: mandaba el
            // corto que muestra el item, y `--cuentas` no lo reconocía.
            let vale = self.ultimas.filter { valePreguntar($0) }.map(\.perfil)
            p.arguments = vale.isEmpty || vale.count == self.ultimas.count
                ? ["--calentar"]
                : ["--calentar", "--cuentas=" + vale.joined(separator: ",")]
            // stdout no dice nada; stderr es el porqué de cada cuenta que no se
            // calentó, y antes iba a /dev/null junto con el código de salida.
            let errores = Pipe()
            p.standardOutput = FileHandle.nullDevice
            p.standardError = errores
            // Dos cosas distintas, y mezclarlas daba un log que mentía:
            //   · el calentado FALLÓ: salió distinto de 0, ninguna cuenta volvió.
            //     Se anota cuando empieza y cuando vuelve a andar.
            //   · una cuenta no se calentó (sin credencial, token vencido) aunque
            //     otras sí. Cada motivo se anota una vez y no tiene «volvió»: los
            //     calentados alternan entre todas las cuentas y sólo las que se
            //     mueven, así que que un motivo no aparezca NO dice que se arregló.
            var fallo: String?
            var motivos: [String] = []
            do {
                try p.run()
                let dicho = String(data: errores.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                p.waitUntilExit()
                motivos = dicho.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                if p.terminationStatus != 0 {
                    fallo = "calentado (\(p.arguments?.joined(separator: " ") ?? "")) falló: salió \(p.terminationStatus)"
                }
            } catch {
                fallo = "calentado falló: no pude correr qm: \(error.localizedDescription)"
            }
            DispatchQueue.main.async {
                if let fallo {
                    if fallo != self.ultimoCalentado { registrar(fallo) }
                    self.ultimoCalentado = fallo
                } else if self.ultimoCalentado != nil {
                    registrar("calentado volvió a andar")
                    self.ultimoCalentado = nil
                }
                for m in motivos where !self.motivosCalentado.contains(m) {
                    self.motivosCalentado.insert(m)
                    registrar(m)
                }
                self.calentadoEn = Date()
                self.vigiaAviso = false
                self.refrescar()
            }
        }
    }

    // Vigilancia de archivos ----------------------------------------------
    /// Un vigía por .claude.json: es donde aparece la cuota nueva. El perfil
    /// por defecto lo guarda al lado del directorio y los demás adentro, así
    /// que se prueban las dos formas.
    func vigilar(_ perfiles: [PerfilVista]) {
        var rutas: Set<String> = []
        for p in perfiles where !p.directorio.isEmpty {
            rutas.insert((p.directorio as NSString).appendingPathComponent(".claude.json"))
            rutas.insert(p.directorio + ".json")
        }
        for ruta in rutas where !vigilando.contains(ruta) {
            armar(ruta)
        }
    }

    func armar(_ ruta: String) {
        let fd = open(ruta, O_EVTONLY)
        guard fd >= 0 else { return }
        vigilando.insert(ruta)
        let v = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename], queue: .main)
        v.setEventHandler { [weak self] in
            guard let self else { return }
            let evento = v.data
            self.pedirRefresco()
            // Claude Code reescribe por rename: el descriptor viejo ya no mira
            // nada. Sin re-armar, el vigía se muere después del primer cambio.
            if evento.contains(.delete) || evento.contains(.rename) {
                v.cancel()
                self.vigilando.remove(ruta)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.armar(ruta) }
            }
        }
        v.setCancelHandler { close(fd) }
        v.resume()
        vigias.append(v)
    }

    func pedirRefresco() {
        pendiente?.cancel()
        let t = DispatchWorkItem { [weak self] in self?.refrescar() }
        pendiente = t
        DispatchQueue.main.asyncAfter(deadline: .now() + DEBOUNCE, execute: t)
    }

    // Datos y dibujo -------------------------------------------------------
    @objc func refrescar() {
        DispatchQueue.global(qos: .utility).async {
            let r = leer()
            DispatchQueue.main.async { self.pintar(r) }
        }
    }

    func pintar(_ lectura: Lectura) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        switch lectura {
        case .falla(let porque):
            // En el menú ya se veía; en el log no, así que una lectura que falló
            // y se recuperó sola no dejaba rastro de haber pasado.
            if porque != ultimaFalla { registrar("lectura de qm falló: \(porque)") }
            ultimaFalla = porque
            item.button?.attributedTitle = comoRenglones("qm ✕")
            item.button?.image = icono("exclamationmark.triangle.fill")
            agregar(menu, porque, activo: false)

        case .ok(let perfiles, let lider):
            if ultimaFalla != nil { registrar("lectura de qm volvió a andar") }
            ultimaFalla = nil
            vigilar(perfiles)
            // Por cuenta: la sesión (la ventana corta) y la barra que frena
            // antes. Son dos preguntas distintas —«¿puedo seguir ahora?» y
            // «¿llego al viernes?»— y el título tiene que contestar las dos.
            var piezas: [Trozo] = []
            var iCuenta = 0
            var peorPct = 0

            if let resumen = VistaResumen(lider, perfiles) {
                let fila = NSMenuItem()
                fila.view = resumen
                menu.addItem(fila)
                menu.addItem(.separator())
            }

            // Las cuentas sin número van juntas al final, en una sola vista: cada
            // una ocupaba una tarjeta entera para decir la misma frase.
            var calladas: [(nombre: String, frase: String)] = []
            for p in perfiles {
                let visibles = p.mostrar

                // El menú lo dibuja VistaCuenta: acá sólo se junta lo que va
                // arriba, en el item.
                if p.hayNumero {
                    let fila = NSMenuItem()
                    fila.view = VistaCuenta(p, icono: glifoProducto(p.producto, colorCuenta(iCuenta), 13))
                    iCuenta += 1
                    menu.addItem(fila)
                    menu.addItem(.separator())
                } else {
                    calladas.append((nombre: corto(p.nombre), frase: p.frase ?? "sin cuota"))
                }

                if p.hayNumero, let cual = p.frena {
                    // La edad de lo que se DIBUJA —la sesión y la semanal—, no la
                    // de la cuenta: con la statusline encima, la cuenta puede ser
                    // de recién y una de las dos venir de una lectura de ayer.
                    let viejo = [p.sesion, p.semanal].compactMap { $0?.edad(p.edadSegundos) }
                        .max().map { $0 >= VIEJO_SEGUNDOS } ?? ((p.edadSegundos ?? 0) >= VIEJO_SEGUNDOS)
                    // El `!` no es sólo severidad: también avisa que a este
                    // ritmo tocás el techo ANTES del reinicio.
                    let chocas = p.proyeccion?.chocas ?? false
                    // Una cuenta dormida no alarma: el «!» avisa de algo que te
                    // va a frenar, y una cuenta que nadie usa no frena nada.
                    let esLaProyectada = { (v: Ventana) in !p.dormida && chocas && v.clave == cual.clave }

                    let ses = p.sesion
                    let sem = p.semanal

                    piezas.append(Trozo(
                        nombre: corto(p.nombre), producto: p.producto, indice: piezas.count,
                        sesion: ses?.porcentaje,
                        sesionAlerta: ses.map { !p.dormida && ($0.preocupa || esLaProyectada($0)) } ?? false,
                        semanal: sem?.porcentaje,
                        semanalAlerta: sem.map { !p.dormida && ($0.preocupa || esLaProyectada($0)) } ?? false,
                        diario: p.presupuesto?.pctDiario,
                        viejo: viejo,
                        perfil: p.nombre,
                        reiniciaSesion: ses?.reinicia,
                        reiniciaSemanal: sem?.reinicia,
                        ultimoUso: p.ultimoUso))
                    // El color del ícono sigue a lo que te frena DE VERDAD: una
                    // cuenta dormida en 100 % dejaba la barra de menú en rojo
                    // permanente por una cuenta que nadie usa.
                    if !p.dormida { peorPct = max(peorPct, cual.porcentaje) }
                    if !p.dormida {
                        revisarAvisos(p, visibles)
                        revisarLiberadas(p, visibles)
                    }
                }
            }

            if !calladas.isEmpty {
                let fila = NSMenuItem()
                fila.view = VistaSinCuota(calladas)
                menu.addItem(fila)
                menu.addItem(.separator())
            }

            ultimas = piezas
            minutosAlTecho = perfiles.compactMap { p -> Double? in
                guard let pr = p.proyeccion, pr.chocas else { return nil }
                return pr.techo.timeIntervalSinceNow / 60
            }.min()
            item.button?.imagePosition = piezas.isEmpty ? .noImage : .imageOnly
            item.button?.attributedTitle = NSAttributedString(string: "")
            // El número de la sesión es lo que se viene a mirar, así que es lo
            // ÚLTIMO que se cae. Antes la escalera lo tiraba primero y el item
            // quedaba mudo justo en la parte que importa; la identidad se
            // recupera del orden y del menú, el número no se recupera de nada.
            probarCaras(piezas.isEmpty ? []
                        : [(true, true), (false, true), (true, false)], piezas)
        }

        if let i = CommandLine.arguments.firstIndex(of: "--captura"),
           i + 1 < CommandLine.arguments.count {
            let ruta = CommandLine.arguments[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self.capturar(ruta)
                NSApp.terminate(nil)
            }
        }

        menu.addItem(.separator())
        agregar(menu, "Abrir el tablero…", accion: #selector(abrirTablero))
        agregar(menu, "Refrescar ahora", accion: #selector(refrescar))
        agregar(menu, "Salir", accion: #selector(salir))
        item.menu = menu

        // Recién acá se sabe cómo viene la mano, así que recién acá se puede
        // decidir cada cuánto volver a mirar. Programarlo en el arranque —con
        // `ultimas` todavía vacío— dejaba la cadencia clavada en 5 minutos, que
        // fue exactamente el bug: Codex llegó al 100 % adentro de una espera.
        programar()
    }

    func comoRenglones(_ texto: String) -> NSAttributedString {
        NSAttributedString(string: texto, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .regular),
            .foregroundColor: NSColor.labelColor,
        ])
    }

    /// La barra de menú de una Mac con muesca tiene mucho menos lugar del que
    /// aparenta: los items se acomodan de derecha a izquierda y el sistema
    /// esconde —sin decir nada, y con `isVisible` en true— al que caería abajo
    /// de la muesca. Medido acá: quedaban ~137 puntos, y el item con glifos,
    /// medidores y números pedía 158.
    ///
    /// Por eso la cara no se elige, se mide: entero, después sin glifos, y
    /// recién al final sin números.
    func probarCaras(_ caras: [(glifos: Bool, numeros: Bool)], _ piezas: [Trozo]) {
        guard let boton = item.button, !caras.isEmpty else { return }
        func intentar(_ i: Int) {
            boton.image = medidores(piezas, glifos: caras[i].glifos, numeros: caras[i].numeros)
            DispatchQueue.main.async {
                if !self.tapadoPorLaMuesca() { self.revisarSiSeVe(); return }
                if i + 1 < caras.count { intentar(i + 1); return }
                // Ninguna entró. Antes se quedaba en la última —la que no tiene
                // números— y el item terminaba mudo justo en la parte que se
                // viene a mirar, aunque igual estuviera tapado. Si va a estar
                // tapado de todos modos, que esté tapada la versión completa:
                // en cuanto el usuario lo cmd-arrastra a un hueco, está todo.
                boton.image = self.medidores(piezas, glifos: caras[0].glifos, numeros: caras[0].numeros)
                self.revisarSiSeVe()
            }
        }
        intentar(0)
    }
    /// El sistema esconde un item que no entra en la barra —y deja `isVisible`
    /// en true igual, así que no se entera nadie. Un número que no se ve es el
    /// mismo bug que el silencio, así que se avisa una vez.
    func revisarSiSeVe() {
        guard let v = item.button?.window else { return }
        // Antes esto miraba `minX < 0`, y estaba mal: en una pantalla ubicada a
        // la izquierda de la principal las coordenadas globales SON negativas y
        // el item se ve perfecto. Lo que importa es si cae fuera de su propia
        // pantalla, o abajo de la muesca.
        let suya = v.screen ?? NSScreen.main
        let afuera = suya.map { v.frame.minX < $0.frame.minX || v.frame.maxX > $0.frame.maxX } ?? false
        let escondido = afuera || tapadoPorLaMuesca()
        // Al log, porque es lo único que explica por qué no se ve nada. Pero
        // sólo cuando CAMBIA, y por pantalla: con tres monitores esto se
        // revisaba en cada redibujo y dejaba el mismo renglón una vez por minuto.
        let pant = v.screen ?? NSScreen.main
        let linea = "posición: ancho=\(v.frame.width) x=\(v.frame.minX)..\(v.frame.maxX) "
            + "muescaDerechaMinX=\(pant?.auxiliaryTopRightArea?.minX ?? -1) "
            + "pantalla=\(pant?.frame.width ?? -1) escondido=\(escondido)"
        let clave = "\(pant?.frame.width ?? -1)x\(pant?.frame.height ?? -1)"
        if ultimaPosicion[clave] != linea {
            ultimaPosicion[clave] = linea
            registrar(linea)
        }
        // Una sola vez por corrida. Antes se re-armaba al volver a entrar, así
        // que un item que oscila entre visible y tapado avisaba en cada vuelta.
        if escondido, !avisoBarraLlena {
            avisoBarraLlena = true
            notificar(titulo: "quartermaster",
                      cuerpo: "el número está, pero macOS no tiene lugar en la barra: "
                            + "cmd-arrastrá el item a un hueco, o mirá el tablero con qm-web")
        }
    }

    func tapadoPorLaMuesca() -> Bool {
        guard let ventana = item.button?.window else { return false }
        let pantalla = ventana.screen ?? NSScreen.main
        guard let pantalla, pantalla.safeAreaInsets.top > 0,
              let derecha = pantalla.auxiliaryTopRightArea else { return false }
        return ventana.frame.minX < derecha.minX
    }

    @discardableResult
    func agregar(_ menu: NSMenu, _ titulo: String, accion: Selector? = nil, activo: Bool = true) -> NSMenuItem {
        let it = NSMenuItem(title: titulo, action: accion, keyEquivalent: "")
        it.target = self
        it.isEnabled = activo && accion != nil
        menu.addItem(it)
        return it
    }

    /// El item de la barra, dibujado.
    ///
    /// Un medidor vertical por cuenta, en el orden del menú, lleno hasta la
    /// barra que la frena antes y pintado por severidad. Es lo que hace que
    /// tres cuentas entren en el ancho de una palabra, y además es la forma en
    /// que se leen las cosas en una barra de menú de macOS: una marca chica y
    /// callada, no un renglón de texto.
    ///
    /// Adentro de cada medidor, una muesca más clara marca dónde va la sesión:
    /// así el mismo dibujo contesta «¿puedo seguir ahora?» y «¿llego al final
    /// de la semana?» sin ocupar el doble.
    func medidores(_ piezas: [Trozo], glifos: Bool, numeros: Bool) -> NSImage {
        let alto: CGFloat = 22, altoBarra: CGFloat = 15
        let ancho: CGFloat = 3, entreGrupos: CGFloat = 5
        let ladoGlifo: CGFloat = glifos ? 9 : 0, aireGlifo: CGFloat = glifos ? 2 : 0
        let aireNumero: CGFloat = 3
        // Un solo medidor por cuenta, no dos. Con el glifo adentro, el par no
        // entraba (158 pt contra los ~137 que deja la muesca) y la escalera
        // terminaba tirando los números — justo lo que hay que mostrar. Y la
        // barra de sesión pasó a ser redundante: el número YA es la sesión.
        // El medidor queda para la sesión, que es la que frena ahora: en la
        // bandeja de Windows no hay número al lado y es lo único que se ve.
        let par = ancho

        let fuente = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium)
        // El número de cada cuenta es el de su ventana CORTA —la sesión de
        // 5 h, o la semanal si el plan no tiene sesión—: es el que contesta
        // «¿puedo seguir trabajando ahora?». El resto se lee en el panel, que
        // es donde hay lugar.
        func texto(_ t: Trozo) -> NSAttributedString? {
            guard numeros, let s = t.corta else { return nil }
            // El número es la ventana corta, así que lleva SU estado. Se tiñe
            // recién cuando aprieta: si se pintara siempre, el color dejaría
            // de querer decir algo.
            let n = nivelDe(s, preocupa: t.cortaAlerta)
            let color: NSColor = (n == .aviso || n == .critico) ? n.color : .labelColor
            return NSAttributedString(string: "\(t.viejo ? "~" : "")\(s)", attributes: [
                .font: fuente, .foregroundColor: color,
            ])
        }

        var anchos: [CGFloat] = []
        for t in piezas {
            let n = texto(t)
            anchos.append(ladoGlifo + aireGlifo + par + (n == nil ? 0 : aireNumero + ceil(n!.size().width)))
        }
        let total = anchos.reduce(0, +) + CGFloat(max(0, piezas.count - 1)) * entreGrupos

        let img = NSImage(size: NSSize(width: max(total, 4), height: alto), flipped: false) { _ in
            let base = (alto - altoBarra) / 2
            let radio = ancho / 2

            func barra(_ x: CGFloat, _ pct: Int, _ color: NSColor) {
                let pista = NSRect(x: x, y: base, width: ancho, height: altoBarra)
                NSColor.labelColor.withAlphaComponent(0.16).setFill()
                NSBezierPath(roundedRect: pista, xRadius: radio, yRadius: radio).fill()
                let h = max(ancho, altoBarra * CGFloat(min(100, max(0, pct))) / 100)
                color.setFill()
                NSBezierPath(roundedRect: NSRect(x: x, y: base, width: ancho, height: h),
                             xRadius: radio, yRadius: radio).fill()
            }

            var x: CGFloat = 0
            for (i, t) in piezas.enumerated() {
                // El glifo dice QUÉ suscripción es: la forma, el producto; el
                // color, cuál de ellas. La identidad va acá y nunca en los
                // medidores, que están reservados para el estado.
                if glifos {
                    glifoProducto(t.producto, colorCuenta(t.indice), ladoGlifo)
                        .draw(in: NSRect(x: x, y: (alto - ladoGlifo) / 2, width: ladoGlifo, height: ladoGlifo))
                }
                let xb = x + ladoGlifo + aireGlifo
                // El medidor es la ventana CORTA: la que te frena AHORA, la
                // única que se mueve dentro del rato que estás mirando la
                // barra. Con sesión de 5 h es la sesión —la semanal se mueve
                // dos píxeles por día—; sin sesión, la semanal es la corta.
                barra(xb, t.corta ?? 0,
                      t.corta == nil ? NSColor.labelColor.withAlphaComponent(0.16)
                                     : nivelDe(t.corta!, preocupa: t.cortaAlerta).color)
                if let n = texto(t) {
                    n.draw(at: NSPoint(x: xb + par + aireNumero, y: (alto - n.size().height) / 2))
                }
                x += anchos[i] + entreGrupos
            }
            return true
        }
        img.isTemplate = false
        img.accessibilityDescription = piezas
            .map { t in
                let d = t.diario.map { "hoy \($0) por ciento del día" } ?? "el día todavía no se puede medir"
                let a = t.sesion.map { "sesión \($0) por ciento" } ?? "sin sesión"
                let b = t.semanal.map { "semana \($0) por ciento" } ?? "sin semanal"
                return "\(t.nombre): \(d), \(a), \(b)\(t.sesionAlerta || t.semanalAlerta ? ", con aviso" : "")"
            }
            .joined(separator: "; ")
        return img
    }

    /// El ícono de cada cuenta. SF Symbols no trae ni el de Claude ni el de
    /// Codex, así que se usan los dos que más se les parecen y que además se
    /// distinguen de un vistazo: el asterisco —que es la forma de la marca de
    /// Claude— y los chevrones de código para Codex.
    func iconoProducto(_ producto: String) -> NSImage? {
        let simbolo = producto == "codex" ? "chevron.left.forwardslash.chevron.right" : "asterisk"
        guard let img = NSImage(systemSymbolName: simbolo, accessibilityDescription: producto) else { return nil }
        img.isTemplate = true
        img.size = NSSize(width: 13, height: 13)
        return img
    }

    func icono(_ nombre: String) -> NSImage? {
        let img = NSImage(systemSymbolName: nombre, accessibilityDescription: "quartermaster")
        img?.isTemplate = true
        return img
    }

    // Avisos ---------------------------------------------------------------
    /// El aviso que faltaba: **cuándo volvés a poder trabajar**.
    ///
    /// Todo lo demás avisa que te estás quedando sin cuota. Nada avisaba lo
    /// contrario, y es la mitad útil de la pregunta: si te frenaste, lo que
    /// querés saber es cuándo se liberó, y hasta ahora eso había que ir a
    /// mirarlo. Se dispara cuando una barra que estaba apretada cambia de
    /// ventana —cambia su minuto de reinicio— y vuelve abajo.
    func revisarLiberadas(_ p: PerfilVista, _ visibles: [Ventana]) {
        for v in visibles {
            let clave = "\(p.nombre)|\(v.nombre)"
            let minuto = v.reinicia.map { Int($0.timeIntervalSince1970 / 60) } ?? 0
            defer { previos[clave] = [minuto, v.porcentaje] }
            guard let antes = previos[clave], antes.count == 2 else { continue }
            let (minutoAntes, pctAntes) = (antes[0], antes[1])
            // Ventana nueva, y en la anterior estabas contra el techo.
            if minuto != minutoAntes, pctAntes >= 80, v.porcentaje < pctAntes {
                notificar(titulo: "quartermaster · \(corto(p.nombre))",
                          cuerpo: "\(v.nombre) se reinició: estabas \(pctAntes) % y ahora vas \(v.porcentaje) %")
            }
        }
        guardarPrevios()
    }

    func revisarAvisos(_ p: PerfilVista, _ visibles: [Ventana]) {
        for v in visibles {
            // La clave incluye el reinicio: una ventana avisa una vez, y la
            // siguiente ventana vuelve a avisar.
            let ventana = v.reinicia.map { String(Int($0.timeIntervalSince1970 / 60)) } ?? "sin-reinicio"
            for u in UMBRALES where v.porcentaje >= u {
                let clave = "\(p.nombre)|\(v.nombre)|\(ventana)|\(u)"
                if avisados.insert(clave).inserted {
                    guardarAvisados()
                    notificar(titulo: "quartermaster · \(corto(p.nombre))",
                              cuerpo: "\(v.nombre) al \(v.porcentaje) %"
                                      + (v.reinicia.map { " · reinicia en \(duracion(Int($0.timeIntervalSinceNow)))" } ?? ""))
                }
            }
        }
        // El aviso que de verdad sirve: enterarte ANTES de chocar, no después.
        if let pr = p.proyeccion, pr.chocas, let cual = p.frena {
            let ventana = cual.reinicia.map { String(Int($0.timeIntervalSince1970 / 60)) } ?? "sin-reinicio"
            let clave = "\(p.nombre)|\(cual.nombre)|\(ventana)|choque"
            if avisados.insert(clave).inserted {
                guardarAvisados()
                notificar(titulo: "quartermaster · \(corto(p.nombre))",
                          cuerpo: "vas a tocar el techo de \(cual.nombre) en "
                                  + "\(duracion(Int(pr.techo.timeIntervalSinceNow))), antes del reinicio")
            }
        }
    }

    /// El item se dibuja a sí mismo en un PNG.
    ///
    /// Existe porque `screencapture` no sirve para verlo: con varias pantallas
    /// la barra de menú se muda a la que tenga el foco, y encima el sistema
    /// puede esconder el item sin avisar. Esto renderiza el botón tal cual
    /// quedó, sobre los dos fondos que puede tocarle, y no depende de qué
    /// pantalla esté mirando nadie. Diseñar a ciegas fue el error.
    func capturar(_ ruta: String) {
        guard let boton = item.button else { return }
        let escala: CGFloat = 4
        let caja = boton.bounds
        for (sufijo, fondo, apariencia) in [
            ("-oscuro", NSColor(white: 0.07, alpha: 1), NSAppearance(named: .darkAqua)),
            ("-claro", NSColor(white: 0.96, alpha: 1), NSAppearance(named: .aqua)),
        ] {
            boton.appearance = apariencia
            boton.layoutSubtreeIfNeeded()
            guard let rep = boton.bitmapImageRepForCachingDisplay(in: caja) else { continue }
            boton.cacheDisplay(in: caja, to: rep)

            let ancho = Int(caja.width * escala), alto = Int(caja.height * escala)
            guard let lienzo = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: ancho, pixelsHigh: alto,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: lienzo)
            fondo.setFill()
            NSRect(x: 0, y: 0, width: ancho, height: alto).fill()
            NSImage(size: caja.size, flipped: false) { r in rep.draw(in: r); return true }
                .draw(in: NSRect(x: 0, y: 0, width: ancho, height: alto))
            NSGraphicsContext.restoreGraphicsState()

            let destino = ruta.replacingOccurrences(of: ".png", with: "\(sufijo).png")
            try? lienzo.representation(using: .png, properties: [:])?
                .write(to: URL(fileURLWithPath: destino))
        }
        // Y el menú, que es donde se contesta la pregunta entera. Mismo motivo:
        // no hay forma de mirarlo con screencapture.
        let vistas = (item.menu?.items ?? []).compactMap { $0.view }
        if !vistas.isEmpty {
            let ancho = vistas.map(\.frame.width).max() ?? 340
            let altoTotal = vistas.map(\.frame.height).reduce(0, +) + CGFloat(vistas.count - 1)
            for (sufijo, fondo, apariencia) in [
                ("-menu-oscuro", NSColor(white: 0.13, alpha: 1), NSAppearance(named: .darkAqua)),
                ("-menu-claro", NSColor(white: 0.98, alpha: 1), NSAppearance(named: .aqua)),
            ] {
                guard let lienzo = NSBitmapImageRep(
                    bitmapDataPlanes: nil, pixelsWide: Int(ancho * escala), pixelsHigh: Int(altoTotal * escala),
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: lienzo)
                NSGraphicsContext.current?.cgContext.scaleBy(x: escala, y: escala)
                fondo.setFill()
                NSRect(x: 0, y: 0, width: ancho, height: altoTotal).fill()
                var y = altoTotal
                for v in vistas {
                    v.appearance = apariencia
                    y -= v.frame.height
                    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
                    v.cacheDisplay(in: v.bounds, to: rep)
                    NSImage(size: v.bounds.size, flipped: false) { r in rep.draw(in: r); return true }
                        .draw(in: NSRect(x: 0, y: y, width: v.frame.width, height: v.frame.height))
                    y -= 1
                    NSColor.labelColor.withAlphaComponent(0.10).setFill()
                    NSRect(x: 0, y: y, width: ancho, height: 1).fill()
                }
                NSGraphicsContext.restoreGraphicsState()
                try? lienzo.representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: ruta.replacingOccurrences(of: ".png", with: "\(sufijo).png")))
            }
        }
        registrar("capturado ancho=\(caja.width) alto=\(caja.height) filas=\(vistas.count)")
    }

    // Acciones -------------------------------------------------------------
    @objc func abrirTablero() {
        // Si el tablero ya está levantado, esto sólo abre el navegador; si no,
        // qm-web lo levanta y lo abre él.
        let url = URL(string: "http://127.0.0.1:7391/")!
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        p.arguments = ["-s", "-o", "/dev/null", "-m", "1", url.absoluteString]
        try? p.run()
        p.waitUntilExit()
        if p.terminationStatus == 0 {
            NSWorkspace.shared.open(url)
        } else {
            let w = Process()
            w.executableURL = URL(fileURLWithPath: RAIZ.appendingPathComponent("bin/qm-web").path)
            try? w.run()
        }
    }

    @objc func salir() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let barra = Barra()
app.delegate = barra
// .accessory: vive en la barra de menú y no aparece en el Dock ni en cmd-tab.
app.setActivationPolicy(.accessory)
app.run()
