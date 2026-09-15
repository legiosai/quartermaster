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
import pathlib
import sys

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
    """GLib de mentira: no corre nada, anota qué se armó."""

    def __init__(self):
        self.armados = []

    def get_monotonic_time(self):
        return 10_000 * 1_000_000

    def timeout_add_seconds(self, seg, _fn):
        self.armados.append(seg)
        return len(self.armados)

    def timeout_add(self, _ms, _fn):
        return 1

    def source_remove(self, _id):
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
    for _ in range(3):
        m.Indicador._vigia(ind)


def sondeo_que_revienta(m, ind, _reloj):
    def revienta():
        raise RuntimeError("un refresco cualquiera que falla")
    ind.refrescar = revienta
    ind.devuelto = [m.Indicador._sondear(ind) for _ in range(3)]


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

    # 3 · el vigía arranca con reloj puesto
    fuente = (RAIZ / "bin/qm-indicator").read_text(encoding="utf-8")
    if "self._ultimo_calentado: int | None = GLib.get_monotonic_time()" not in fuente:
        fallas.append("`_ultimo_calentado` arranca en None: si el PRIMER calentado nunca "
                      "termina, el vigía no mira nunca y el silencio vuelve")
    swift = (RAIZ / "bin/qm-barra.swift").read_text(encoding="utf-8")
    if "if calentadoEn == nil { calentadoEn = Date() }" not in swift:
        fallas.append("la barra de macOS arma el vigía sin ponerle reloj: mismo agujero")
    if "$script:CalentadoEn = Get-Date" not in (RAIZ / "bin/qm-tray.ps1").read_text(encoding="utf-8"):
        fallas.append("la bandeja de Windows arma el vigía sin ponerle reloj: mismo agujero")

    # 4 · el sondeo que sobrevive a su propio error
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

    if fallas:
        for f in fallas:
            print(f"GATE ROJO: {f}", file=sys.stderr)
        return 1
    print("lazo: la bandera pegada se suelta y se anota, el vigía avisa una vez y rearma, "
          "y el sondeo sobrevive a su propio error")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
