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
        if producto == "codex" {
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

func duracion(_ segundos: Int) -> String {
    if segundos < 0 { return "ya" }
    if segundos < 60 { return "\(segundos)s" }
    if segundos < 3600 { return "\(segundos / 60)m" }
    let h = segundos / 3600, m = (segundos % 3600) / 60
    if h < 24 { return m == 0 ? "\(h)h" : "\(h)h\(m)m" }
    return "\(h / 24)d\(h % 24)h"
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

    var nombre: String { alcance == nil ? clave : "\(clave) (\(alcance!))" }
    /// Una barra preocupa si el servidor lo dice, o si pasó el 80 %.
    var preocupa: Bool { severidad != "normal" || porcentaje >= 80 }
}

struct Proyeccion {
    let ritmo: Double
    let techo: Date
    let chocas: Bool
}

/// Lo que hay que decir de una cuenta arriba: la sesión de 5 h, la barra que
/// frena antes, y dos banderas que NO son lo mismo.
///
/// `viejo` califica al número —este 23 es de hace rato— así que viaja pegado a
/// él, como `~23`. `alerta` es del estado de la cuenta, y ese NO se escribe al
/// lado del número de la sesión: el aviso puede ser de la barra semanal, y un
/// `23!` diría que lo alarmante es la sesión, que es falso. La alerta la lleva
/// el color del medidor de la derecha, que es justamente el de esa barra.
/// Dos números por cuenta, cada uno SIEMPRE con el mismo significado:
/// el medidor es la semanal y el número es la sesión de 5 h.
///
/// Antes el medidor mostraba «la que frena antes», que a veces era la semanal y
/// a veces la sesión — y cuando era la sesión, dibujaba lo mismo que ya decía
/// el número al lado. Un encoding que cambia de significado según el dato no se
/// puede leer de un vistazo, que es lo único que hace la barra de menú.
struct Trozo {
    let nombre: String
    let producto: String
    let indice: Int
    /// La ventana corta: «¿puedo seguir ahora?». Va como número.
    let sesion: Int?
    let sesionAlerta: Bool
    /// La peor de las semanales: «¿llego al final?». Va como medidor.
    let semanal: Int?
    let semanalAlerta: Bool
    let viejo: Bool
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
    let ventanas: [Ventana]
    let edadSegundos: Int?
    let proyeccion: Proyeccion?
}

/// Las que vale la pena mostrar: el servidor manda barras que no aplican a la cuenta.
func paraMostrar(_ vs: [Ventana]) -> [Ventana] {
    vs.filter { $0.activa || $0.porcentaje > 0 || $0.severidad != "normal" }
}

/// La que hay que mirar: la activa gana, salvo que haya una más alta. Es lo
/// único que evita que un 75 % con aviso quede tapado por un 8 % más lindo.
func peor(_ vs: [Ventana]) -> Ventana? {
    guard !vs.isEmpty else { return nil }
    let activa = vs.sorted {
        $0.activa != $1.activa ? $0.activa : $0.porcentaje > $1.porcentaje
    }[0]
    let alta = vs.sorted { $0.porcentaje > $1.porcentaje }[0]
    return alta.porcentaje > activa.porcentaje ? alta : activa
}

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
    case ok([PerfilVista])
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
        let ventanas: [Ventana] = (cuota["ventanas"] as? [[String: Any]] ?? []).map { v in
            Ventana(clave: v["clave"] as? String ?? "?",
                    alcance: v["alcance"] as? String,
                    porcentaje: v["porcentaje"] as? Int ?? 0,
                    severidad: v["severidad"] as? String ?? "normal",
                    activa: v["activa"] as? Bool ?? false,
                    reinicia: fecha(v["reinicia"]),
                    grupo: v["grupo"] as? String)
        }
        var proy: Proyeccion? = nil
        if let pr = p["proyeccion"] as? [String: Any], (pr["estado"] as? String) == "sube",
           let techo = fecha(pr["techo"]) {
            proy = Proyeccion(ritmo: pr["ritmoPuntosPorHora"] as? Double ?? 0,
                              techo: techo,
                              chocas: pr["chocasAntesDelReinicio"] as? Bool ?? false)
        }
        return PerfilVista(
            producto: p["producto"] as? String ?? "claude",
            nombre: p["perfil"] as? String ?? "?",
            directorio: p["directorio"] as? String ?? "",
            cuenta: p["cuenta"] as? String,
            plan: p["plan"] as? String,
            credencial: p["credencial"] as? String ?? "?",
            hayNumero: hayNumero,
            frase: cuota["frase"] as? String,
            ventanas: ventanas,
            edadSegundos: cuota["edadSegundos"] as? Int,
            proyeccion: proy)
    }
    return .ok(perfiles)
}

// ── avisos ───────────────────────────────────────────────────────────────
/// Sin bundle no hay UNUserNotificationCenter, y osascript sí anda: es la vía
// que no obliga a empaquetar una .app para decir una frase.
func notificar(titulo: String, cuerpo: String) {
    let limpio: (String) -> String = { $0.replacingOccurrences(of: "\"", with: "'") }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(limpio(cuerpo))\" with title \"\(limpio(titulo))\""]
    try? p.run()
}


// ── el menú, dibujado ────────────────────────────────────────────────────
/// Una cuenta adentro del menú, dibujada con el mismo lenguaje que el item de
/// arriba: medidores de verdad, no bloques `█░` de una tipografía monoespaciada.
///
/// Es una NSView y no un NSMenuItem con texto porque el menú es donde se
/// contesta la pregunta completa —qué barra, cuánto, cuándo se reinicia, a qué
/// ritmo— y eso pide una grilla, no un renglón.
final class VistaCuenta: NSView {
    private let titulo: String
    private let sub: String
    private let icono: NSImage?
    private let barras: [(nombre: String, pct: Int, nivel: Nivel, activa: Bool, pie: String)]
    private let frase: String?
    private let ritmo: String?
    private let ritmoRojo: Bool

    private static let ANCHO: CGFloat = 340
    private static let MARGEN: CGFloat = 15
    // Un renglón de barra = nombre (14) + medidor (8) + pie (13). Si esta
    // cuenta no coincide con lo que dibuja draw(), los renglones se pisan.
    private static let ALTO_BARRA: CGFloat = 35

    init(_ p: PerfilVista, icono: NSImage?) {
        self.titulo = corto(p.nombre)
        var partes: [String] = []
        if let c = p.cuenta { partes.append(c) }
        if let pl = p.plan { partes.append(pl) }
        self.sub = partes.joined(separator: "  ·  ")
        self.icono = icono

        let visibles = paraMostrar(p.ventanas)
        let cual = peor(visibles)
        let chocas = p.proyeccion?.chocas ?? false
        self.barras = p.hayNumero ? visibles.map { v in
            var pie = v.reinicia.map { "reinicia en \(duracion(Int($0.timeIntervalSinceNow)))" } ?? ""
            if let e = p.edadSegundos, v.clave == cual?.clave {
                pie += pie.isEmpty ? "" : "   ·   "
                pie += "cache de hace \(duracion(e))" + (e >= VIEJO_SEGUNDOS ? " · viejo" : "")
            }
            return (v.nombre, v.porcentaje,
                    nivelDe(v.porcentaje, preocupa: v.preocupa || (chocas && v.clave == cual?.clave)),
                    v.activa, pie)
        } : []
        // Silencio es el bug: si no hay número, hay una frase.
        self.frase = p.hayNumero ? nil : (p.frase ?? "sin cuota")
        if let pr = p.proyeccion {
            self.ritmo = String(format: "%.1f pts/h · 100 %% en %@%@", pr.ritmo,
                                duracion(Int(pr.techo.timeIntervalSinceNow)),
                                pr.chocas ? " — antes del reinicio" : "")
            self.ritmoRojo = pr.chocas
        } else {
            self.ritmo = nil
            self.ritmoRojo = false
        }

        var alto = VistaCuenta.MARGEN + 16 + 15 + 6
        alto += CGFloat(barras.count) * VistaCuenta.ALTO_BARRA
        if frase != nil { alto += 34 }
        if ritmo != nil { alto += 16 }
        alto += 12
        super.init(frame: NSRect(x: 0, y: 0, width: VistaCuenta.ANCHO, height: alto))
    }

    required init?(coder: NSCoder) { nil }

    private func escribir(_ t: String, _ x: CGFloat, _ y: CGFloat, _ f: NSFont, _ c: NSColor,
                          derecha: CGFloat? = nil) {
        let a = NSAttributedString(string: t, attributes: [.font: f, .foregroundColor: c])
        a.draw(at: NSPoint(x: derecha == nil ? x : derecha! - a.size().width, y: y))
    }

    override func draw(_ dirtyRect: NSRect) {
        let m = VistaCuenta.MARGEN
        let der = bounds.width - m
        var y = bounds.height - m - 16

        // Cabecera: ícono, nombre y, debajo, cuenta y plan.
        if let ic = icono {
            ic.draw(in: NSRect(x: m, y: y + 1, width: 13, height: 13))
        }
        escribir(titulo, m + 19, y, .systemFont(ofSize: 13, weight: .semibold), .labelColor)
        y -= 15
        escribir(sub, m + 19, y, .systemFont(ofSize: 10.5), .tertiaryLabelColor)
        y -= 6

        if let f = frase {
            let a = NSAttributedString(string: f, attributes: [
                .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor,
            ])
            a.draw(with: NSRect(x: m, y: y - 26, width: der - m, height: 32),
                   options: [.usesLineFragmentOrigin])
            return
        }

        for b in barras {
            y -= 14
            let nombre = b.activa ? "\(b.nombre)  ▸" : b.nombre
            escribir(nombre, m, y, .systemFont(ofSize: 11, weight: b.activa ? .medium : .regular),
                     b.activa ? .labelColor : .secondaryLabelColor)
            escribir("\(b.pct)%", 0, y, .monospacedDigitSystemFont(ofSize: 11.5, weight: .semibold),
                     .labelColor, derecha: der)
            y -= 8
            // El medidor: pista tenue y relleno con el color del estado.
            let pista = NSRect(x: m, y: y, width: der - m, height: 4)
            NSColor.labelColor.withAlphaComponent(0.14).setFill()
            NSBezierPath(roundedRect: pista, xRadius: 2, yRadius: 2).fill()
            let ancho = max(4, (der - m) * CGFloat(min(100, max(0, b.pct))) / 100)
            b.nivel.color.setFill()
            NSBezierPath(roundedRect: NSRect(x: m, y: y, width: ancho, height: 4),
                         xRadius: 2, yRadius: 2).fill()
            y -= 13
            escribir(b.pie, m, y, .systemFont(ofSize: 10), .tertiaryLabelColor)
        }

        if let r = ritmo {
            y -= 16
            escribir(r, m, y, .systemFont(ofSize: 10.5, weight: ritmoRojo ? .medium : .regular),
                     ritmoRojo ? Nivel.critico.color : .tertiaryLabelColor)
        }
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
    /// Sin esto macOS le aplica App Nap —es una app sin ventanas— y los timers
    /// se corren minutos. Medido: un sondeo de 5 min que no disparó en 7.
    var actividad: NSObjectProtocol?
    /// Lo último que se vio, para decidir cada cuánto volver a mirar.
    var ultimas: [Trozo] = []
    var avisoBarraLlena = false

    func applicationDidFinishLaunching(_ n: Notification) {
        // Con autosaveName el sistema recuerda dónde lo dejó el usuario: en una
        // barra llena, cmd-arrastrar el item a un hueco es LA salida, y sin
        // esto se perdería en cada arranque.
        item.autosaveName = "quartermaster"
        item.button?.title = "qm…"
        item.menu = NSMenu()
        actividad = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "mirar la cuota a tiempo")
        refrescar()
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
        if alto >= 90 { segundos = 20 }
        else if alto >= 75 { segundos = 45 }
        else if alto >= 50 { segundos = 120 }
        if let m = minutosAlTecho, m <= 30 { segundos = min(segundos, 20) }
        else if let m = minutosAlTecho, m <= 90 { segundos = min(segundos, 60) }
        return segundos
    }

    var minutosAlTecho: Double? = nil

    func programar() {
        reloj?.invalidate()
        let t = Timer(timeInterval: cadencia(), repeats: false) { _ in
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
            p.arguments = ["--calentar"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
            p.waitUntilExit()
            DispatchQueue.main.async { self.refrescar() }
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
            item.button?.attributedTitle = comoRenglones("qm ✕")
            item.button?.image = icono("exclamationmark.triangle.fill")
            agregar(menu, porque, activo: false)

        case .ok(let perfiles):
            vigilar(perfiles)
            // Por cuenta: la sesión (la ventana corta) y la barra que frena
            // antes. Son dos preguntas distintas —«¿puedo seguir ahora?» y
            // «¿llego al viernes?»— y el título tiene que contestar las dos.
            var piezas: [Trozo] = []
            var iCuenta = 0
            var peorPct = 0

            for p in perfiles {
                let visibles = paraMostrar(p.ventanas)

                // El menú lo dibuja VistaCuenta: acá sólo se junta lo que va
                // arriba, en el item.
                let fila = NSMenuItem()
                fila.view = VistaCuenta(p, icono: glifoProducto(p.producto, colorCuenta(iCuenta), 13))
                if p.hayNumero { iCuenta += 1 }
                menu.addItem(fila)
                menu.addItem(.separator())

                if p.hayNumero, let cual = peor(visibles) {
                    let viejo = (p.edadSegundos ?? 0) >= VIEJO_SEGUNDOS
                    // El `!` no es sólo severidad: también avisa que a este
                    // ritmo tocás el techo ANTES del reinicio.
                    let chocas = p.proyeccion?.chocas ?? false
                    let esLaProyectada = { (v: Ventana) in chocas && v.clave == cual.clave }

                    let ses = visibles.first { $0.grupo == "session" || $0.clave == "session" }
                    // Puede haber más de una semanal (weekly_all y
                    // weekly_scoped): manda la que frena antes de las dos.
                    let sem = visibles
                        .filter { $0.grupo == "weekly" || $0.clave.hasPrefix("weekly") || $0.clave == "seven_day" }
                        .max { ($0.activa ? 1 : 0, $0.porcentaje) < ($1.activa ? 1 : 0, $1.porcentaje) }
                        ?? visibles.filter { $0.clave != ses?.clave }.max { $0.porcentaje < $1.porcentaje }

                    piezas.append(Trozo(
                        nombre: corto(p.nombre), producto: p.producto, indice: piezas.count,
                        sesion: ses?.porcentaje,
                        sesionAlerta: ses.map { $0.preocupa || esLaProyectada($0) } ?? false,
                        semanal: sem?.porcentaje,
                        semanalAlerta: sem.map { $0.preocupa || esLaProyectada($0) } ?? false,
                        viejo: viejo))
                    peorPct = max(peorPct, cual.porcentaje)
                    revisarAvisos(p, visibles)
                }
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
                if self.tapadoPorLaMuesca(), i + 1 < caras.count { intentar(i + 1) }
                else { self.revisarSiSeVe() }
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
        // A stderr, siempre: es lo único que explica por qué no se ve nada.
        let pant = v.screen ?? NSScreen.main
        FileHandle.standardError.write(
            ("[qm-barra] titulo=\(item.button?.attributedTitle.string.replacingOccurrences(of: "\n", with: " / ") ?? "?") "
             + "ancho=\(v.frame.width) x=\(v.frame.minX)..\(v.frame.maxX) "
             + "muescaDerechaMinX=\(pant?.auxiliaryTopRightArea?.minX ?? -1) "
             + "pantalla=\(pant?.frame.width ?? -1) escondido=\(escondido)\n").data(using: .utf8)!)
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
        // El medidor queda para la que frena antes, que es la que no tiene
        // número y necesita alguna forma de verse.
        let par = ancho

        let fuente = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium)
        // El número de cada cuenta es el de la SESIÓN de 5 h: es el que
        // contesta «¿puedo seguir trabajando ahora?». La semanal se sigue
        // viendo —es la barra de la derecha, con su color— sin gastar dígitos.
        func texto(_ t: Trozo) -> NSAttributedString? {
            guard numeros, let s = t.sesion else { return nil }
            // El número es la sesión, así que lleva el estado DE LA SESIÓN. Se
            // tiñe recién cuando aprieta: si se pintara siempre, el color
            // dejaría de querer decir algo.
            let n = nivelDe(s, preocupa: t.sesionAlerta)
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
                // El medidor es SIEMPRE la semanal. Si la cuenta no informa
                // ninguna, queda la pista vacía: mejor un hueco honesto que
                // dibujar ahí otra cosa.
                barra(xb, t.semanal ?? 0,
                      t.semanal == nil ? NSColor.labelColor.withAlphaComponent(0.16)
                                       : nivelDe(t.semanal!, preocupa: t.semanalAlerta).color)
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
                let a = t.sesion.map { "sesión \($0) por ciento" } ?? "sin sesión"
                let b = t.semanal.map { "semana \($0) por ciento" } ?? "sin semanal"
                return "\(t.nombre): \(a), \(b)\(t.sesionAlerta || t.semanalAlerta ? ", con aviso" : "")"
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
        if let pr = p.proyeccion, pr.chocas, let cual = peor(visibles) {
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
        FileHandle.standardError.write("[qm-barra] capturado ancho=\(caja.width) alto=\(caja.height) filas=\(vistas.count)\n".data(using: .utf8)!)
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
