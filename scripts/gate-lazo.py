"""El calentado no puede dejar de ocurrir en silencio.

EL CASO. El 2026-09-15, con 0.1.13 recién publicada, el indicador de GNOME de
esta máquina dejó de preguntarle al endpoint a las 02:35 y estuvo SIETE HORAS Y
MEDIA sin escribir una sola línea. Medido, no supuesto: el proceso vivo,
`estado.json` reescrito hacía un minuto, `endpoint.json` e `historial.jsonl`
congelados a las 02:35, y el log al día —un `pedido` mandado a mano aparecía al
instante—. No fue la suspensión, que es el caso que el código ya contempla:
CLOCK_BOOTTIME y CLOCK_MONOTONIC daban lo mismo y la máquina llevaba 14 h de
uptime continuo. Forzar un `refrescar()`, que es lo que rearma el calentado, no
lo revivió en diez minutos con la cadencia en un techo de cinco.

Lo que mostraba mientras tanto, contra lo que decía el servidor:

    mostraba   main ~0/30% · teams ~0/29% · codex ~0/30%
    endpoint   main  7/31% · teams  10/30% · codex  0/30%

El `~` estaba —no mentía— pero un monitor que deja de monitorear sin decirlo es
exactamente el bug del que nació este repo.

LA FORMA, que es lo que se comprueba acá. El calentado se rearmaba desde UN solo
lugar: el final de `refrescar()`. Cualquier corte en esa cadena lo apagaba para
toda la vida del proceso, y había un estado —`calentando` en True sin
`calentando_desde`— que caía en un `else` que rearmaba sin anotar nada. Diez
vueltas del temporizador, cero líneas.

Se comprueban las tres defensas, manejando los callbacks a mano como se los
haría correr GLib, sin levantar interfaz:

  1. una bandera pegada SIN instante se trata como pegada: se anota y se suelta;
  2. el vigía, que no depende del calentado ni del sondeo, anota el atraso una
     vez y lo destraba;
  3. el sondeo periódico sobrevive a una excepción de `refrescar()`: la anota y
     devuelve True, porque un callback de GLib que no devuelve un valor
     verdadero se queda sin fuente y se lleva el lazo puesto.
"""

import importlib.machinery
import importlib.util
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parent.parent

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def cargar():
    spec = importlib.util.spec_from_loader(
        "qmi", importlib.machinery.SourceFileLoader("qmi", str(RAIZ / "bin/qm-indicator")))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


class RelojFalso:
    """GLib de mentira: no corre nada, anota qué se armó. El reloj avanza a mano."""

    def __init__(self):
        self.armados = []
        self.ahora = 10_000 * 1_000_000
        self.vivas = {}

    def avanzar(self, segundos):
        self.ahora += segundos * 1_000_000

    def get_monotonic_time(self):
        return self.ahora

    def timeout_add_seconds(self, seg, _fn):
        self.armados.append(seg)
        idc = len(self.armados)
        self.vivas[idc] = self.ahora + seg * 1_000_000
        return idc

    def timeout_add(self, _ms, _fn):
        return 1

    def source_remove(self, idc):
        self.vivas.pop(idc, None)
        return True


def banco(m):
    """Un Indicador sin interfaz, con el estado que se quiera."""
    ind = object.__new__(m.Indicador)
    ind.calentando = False
    ind.calentando_desde = None
    ind.reloj = None
    ind.proxima_lectura = None
    ind.piezas = []
    ind.minutos_al_techo = None
    ind._ultimo_calentado = None
    ind._vigia_avisado = False
    ind._fallo_calentado = None
    ind._motivos_calentado = set()
    ind.qm = "/bin/true"
    return ind


def correr(prueba):
    """Devuelve (renglones anotados, temporizadores armados)."""
    m = cargar()
    anotado = []
    m.registrar = lambda evento, **d: anotado.append(
        evento + ("" if not d else " " + " ".join(
            f"{k}={v}" for k, v in d.items() if v is not None)))
    reloj = RelojFalso()
    m.GLib = reloj
    prueba(m, banco(m), reloj)
    return anotado, reloj.armados


def bandera_pegada(m, ind, _reloj):
    ind.calentando = True
    ind.calentando_desde = None
    for _ in range(10):
        m.Indicador.calentar(ind)


def vigia_con_atraso(m, ind, reloj):
    ind.calentando = True
    ind._ultimo_calentado = reloj.get_monotonic_time() - 1800 * 1_000_000
    # Con un temporizador armado y su fecha YA VENCIDA, que es el estado real de
    # un calentado parado: la guarda anti-hambre ve que cualquier fecha nueva es
    # «más lejos» y, sin forzar, no rearmaría nada. La defensa contra el hambre
    # apagaría a la defensa contra el silencio.
    ind.reloj = 99
    ind.proxima_lectura = reloj.get_monotonic_time() - 600 * 1_000_000
    for _ in range(3):
        m.Indicador._vigia(ind)


def hambre(m, ind, reloj):
    """El sondeo empatado con la cadencia: ¿llega a vencer el calentado?

    Es el caso REAL: `cadencia()` devuelve SEGUNDOS_SONDEO cuando no hay nada
    alto, y `refrescar()` —que corre cada SEGUNDOS_SONDEO— rearma el calentado
    en cada vuelta. Si rearmar ALEJA la fecha, el calentado no vence jamás.
    """
    ind.piezas = []                      # nada alto: cadencia() da el techo
    m.Indicador.programar_calentado(ind)  # como el arranque
    for _ in range(12):                  # doce sondeos = una hora
        reloj.avanzar(m.SEGUNDOS_SONDEO)
        m.Indicador.programar_calentado(ind)
    # ¿Quedó alguna fecha en el pasado? Ésa es la que habría disparado.
    ind.vencio = any(t <= reloj.ahora for t in reloj.vivas.values())


def sondeo_que_revienta(m, ind, _reloj):
    def revienta():
        raise RuntimeError("un refresco cualquiera que falla")
    ind.refrescar = revienta
    ind.devuelto = [m.Indicador._sondear(ind) for _ in range(3)]


def vigia_de_macos() -> list[str]:
    """El vigía de la barra de macOS, EJECUTADO.

    Compilar no alcanza: lo que hay que comprobar es que con una lectura
    reciente se calle, que con una vieja avise UNA vez, y que rearme. Se le saca
    el cuerpo a `func vigia()` y se lo envuelve con lo que nombra —el reloj, la
    bandera, `registrar`, `duracion` y `programar`— igual que hace
    gate-duraciones con la escalera.
    """
    texto = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    i = texto.index("    func vigia() {")
    j = texto.index("\n    }\n", i) + len("\n    }\n")
    cuerpo = texto[i:j].replace("func vigia()", "func vigia()")
    # `duracion` de verdad, para que la frase sea la que se va a leer.
    dur_i = texto.index("func duracion(_ segundos: Int) -> String {")
    nivel, k = 0, dur_i
    while True:
        if texto[k] == "{":
            nivel += 1
        elif texto[k] == "}":
            nivel -= 1
            if nivel == 0:
                break
        k += 1
    duracion = texto[dur_i:k + 1]

    # Y `programar()`, que es donde vivía el hambre: rearmar no puede ALEJAR.
    prog_i = texto.index("    func programar(forzando: Bool = false) {")
    nivel, k = 0, prog_i
    while True:
        if texto[k] == "{":
            nivel += 1
        elif texto[k] == "}":
            nivel -= 1
            if nivel == 0:
                break
        k += 1
    programar = texto[prog_i:k + 1].replace("self.calentarCodex()", "calentados += 1")
    # Contar los rearmes DE VERDAD: el stub que los contaba ya no está, porque
    # ahora se ejecuta el `programar()` real —que es justo lo que hay que medir,
    # porque su guarda anti-hambre podía dejar al vigía sin rearmar nada.
    assert "rearmes" not in programar
    programar = programar.replace("        let cuanto = cadencia()",
                                  "        rearmes += 1\n        let cuanto = cadencia()", 1)

    guion = f"""import Foundation
{duracion}
let VIGIA_PLAZO: TimeInterval = 20 * 60
let SEGUNDOS_SONDEO: TimeInterval = 300
let MINIMO_RED: TimeInterval = 60
var anotado: [String] = []
func registrar(_ t: String) {{ anotado.append(t) }}
var rearmes = 0
var calentados = 0
class Barra {{
    var calentadoEn: Date?
    var vigiaAviso = false
    var reloj: Timer?
    var minutosAlTecho: Double? = nil
    func cadencia() -> TimeInterval {{ SEGUNDOS_SONDEO }}   // todo tranquilo
{programar}
{cuerpo}
}}
let b = Barra()

// 1 · el vigía
let v = Barra()
v.calentadoEn = Date()
v.vigia()
print("callado:\\(anotado.isEmpty)")
v.calentadoEn = Date().addingTimeInterval(-1800)
v.vigia(); v.vigia(); v.vigia()
print("avisos:\\(anotado.count)")
print("rearmes:\\(rearmes)")

// 2 · el hambre: refrescar() rearma en cada vuelta y no puede correr la fecha
b.programar()
let primera = b.reloj!.fireDate
for _ in 0..<12 {{ b.programar() }}
print("alejado:\\(b.reloj!.fireDate > primera)")

// 3 · y la guarda no puede dejar al vigía sin rearmar: con la fecha YA vencida,
// cualquier fecha nueva es «más lejos», y sin forzar no se rearmaría nada.
let c = Barra()
c.programar()
let vieja = c.reloj!.fireDate
c.reloj!.fireDate = Date().addingTimeInterval(-600)   // la fecha YA venció
c.calentadoEn = Date().addingTimeInterval(-1800)
c.vigiaAviso = false
c.vigia()
print("vigiaRearmo:\\(c.reloj!.fireDate > Date())")
_ = vieja
"""
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d) / "v.swift"
        f.write_text(guion, encoding="utf-8")
        r = subprocess.run(["swift", str(f)], capture_output=True, text=True,
                           encoding="utf-8", timeout=300)
    if r.returncode != 0:
        # Las últimas líneas, no la última: un error de Swift termina en la
        # línea del fuente y sin las de arriba no dice qué estuvo mal.
        cola = (r.stderr or "swift falló").strip().splitlines()
        errores = [l for l in cola if ": error:" in l] or cola[-4:]
        raise RuntimeError(" / ".join(errores[:3]))
    return r.stdout.strip().splitlines()


def main() -> int:
    fallas = []

    # Que las defensas EXISTAN, antes de probarlas. Sin esto, una versión que no
    # las tiene sale por un traceback en vez de por un rojo que se pueda leer,
    # y un gate ilegible es medio gate.
    m = cargar()
    for nombre, para_que in (("_vigia", "mirar desde afuera que el calentado siga ocurriendo"),
                             ("_sondear", "que una excepción del refresco no se lleve la fuente")):
        if not hasattr(m.Indicador, nombre):
            fallas.append(f"no existe `Indicador.{nombre}`, que es lo que hace falta para {para_que}")
    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1

    # 1 · la bandera pegada sin instante
    anotado, _ = correr(bandera_pegada)
    if not any(l.startswith("calentar.colgado") for l in anotado):
        fallas.append("diez vueltas del temporizador con `calentando` pegada y sin instante "
                      "no anotaron un solo `calentar.colgado`: ése es el silencio de siete horas")
    if not any(l.startswith("calentar ") for l in anotado):
        fallas.append("después de soltar la bandera pegada el calentado no volvió a ocurrir")

    # 2 · el vigía
    anotado, armados = correr(vigia_con_atraso)
    parado = [l for l in anotado if l.startswith("calentar.parado")]
    if not parado:
        fallas.append("el vigía no anotó nada con el calentado parado media hora")
    elif len(parado) != 1:
        fallas.append(f"el vigía anotó {len(parado)} veces en tres vueltas: tiene que avisar "
                      "una vez por corte, si no el log no se puede leer")
    if not armados:
        fallas.append("el vigía anotó el atraso pero no rearmó el calentado")

    # 3 · el hambre: el sondeo empatado con la cadencia
    m2 = cargar()
    m2.registrar = lambda *a, **k: None
    reloj2 = RelojFalso()
    m2.GLib = reloj2
    ind2 = banco(m2)
    hambre(m2, ind2, reloj2)
    if not ind2.vencio:
        fallas.append("con el sondeo y la cadencia empatados, doce vueltas de una hora "
                      "no dejaron vencer NI UN calentado: cada refresco corría la fecha "
                      "más lejos y el calentado no ocurría nunca")

    # 4 · el vigía arranca con reloj puesto
    fuente = (RAIZ / "bin/qm-indicator").read_text(encoding="utf-8")
    if "self._ultimo_calentado: int | None = GLib.get_monotonic_time()" not in fuente:
        fallas.append("`_ultimo_calentado` arranca en None: si el PRIMER calentado nunca "
                      "termina, el vigía no mira nunca y el silencio vuelve")
    swift = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    if "if calentadoEn == nil { calentadoEn = Date() }" not in swift:
        fallas.append("la barra de macOS arma el vigía sin ponerle reloj: mismo agujero")
    if "$script:CalentadoEn = Get-Date" not in (RAIZ / "bin/qm-tray.ps1").read_text(encoding="utf-8"):
        fallas.append("la bandeja de Windows arma el vigía sin ponerle reloj: mismo agujero")

    # 5 · el sondeo que sobrevive a su propio error
    m = cargar()
    anotado = []
    m.registrar = lambda evento, **d: anotado.append(evento)
    reloj = RelojFalso()
    m.GLib = reloj
    ind = banco(m)
    sondeo_que_revienta(m, ind, reloj)
    if not all(ind.devuelto):
        fallas.append("un `refrescar()` que tira deja al sondeo devolviendo un valor falso: "
                      "GLib le saca la fuente y con ella se va el único rearme del calentado")
    if not any(l.startswith("sondeo.reventó") for l in anotado):
        fallas.append("el sondeo se tragó la excepción sin anotarla")

    # 5 · el vigía de macOS, ejecutado donde haya swiftc
    exigidos = {x for x in os.environ.get("QM_GATE_EXIGE", "").split(",") if x}
    salteado = ""
    if shutil.which("swift") is None:
        if "swift" in exigidos:
            fallas.append("falta swift y este job lo exige: el vigía de la barra de macOS "
                          "quedaría sólo compilado, no corrido")
        else:
            salteado = "  · salteado: el vigía de macOS (no hay swift en esta máquina)"
    else:
        try:
            dicho = dict(l.split(":", 1) for l in vigia_de_macos())
            if dicho.get("callado") != "true":
                fallas.append("el vigía de macOS avisa con una lectura RECIENTE: cría lobo")
            if dicho.get("avisos") != "1":
                fallas.append(f"el vigía de macOS avisó {dicho.get('avisos')} veces en tres "
                              "vueltas: tiene que ser una por corte")
            if dicho.get("rearmes") != "3":
                fallas.append(f"el vigía de macOS rearmó {dicho.get('rearmes')} veces y "
                              "tenían que ser 3: avisar sin rearmar no destraba nada")
            if dicho.get("vigiaRearmo") != "true":
                fallas.append("la guarda anti-hambre de macOS deja al vigía sin rearmar: "
                              "con la fecha ya vencida, la fecha nueva siempre es «más "
                              "lejos» y la defensa contra el hambre apaga a la del silencio")
            if dicho.get("alejado") != "false":
                fallas.append("en macOS, doce refrescos seguidos ALEJAN la fecha del "
                              "calentado: con el .claude.json reescribiéndose cada veinte "
                              "segundos, el calentado no vence nunca")
        except Exception as e:  # noqa: BLE001
            fallas.append(f"no pude correr el vigía de macOS: {e}")

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1
    print("lazo: la bandera pegada se suelta y se anota, el vigía avisa una vez y rearma, "
          "y el sondeo sobrevive a su propio error")
    if salteado:
        print(salteado)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
