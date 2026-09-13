import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estadoCredencial, tokenDeAcceso, ubicacionCredencial } from '../src/adapters/credenciales.ts';
import { servicioLlavero, directorioPorDefecto } from '../src/core/perfiles.ts';
import type { Perfil } from '../src/core/tipos.ts';

// El módulo que toca secretos, por fin con tests.
//
// Es el único lugar del repo que lee un token, y no tenía ninguno. Lo que se
// comprueba acá es sobre todo lo que NO tiene que pasar: que `estadoCredencial`
// no devuelva el secreto ni por accidente, y que cada estado —vencida, ausente,
// ilegible— produzca una frase en vez de un silencio (SOUL.md).
//
// En Linux y Windows la credencial es un archivo, así que se puede armar uno.
// En macOS vive en el llavero: ahí estos tests comprueban la parte determinista
// —el nombre del servicio— y no intentan escribir en el llavero de nadie.

const esMac = process.platform === 'darwin';

function perfilCon(blob: unknown | null): { perfil: Perfil; raiz: string } {
  const raiz = mkdtempSync(join(tmpdir(), 'qm-cred-'));
  if (blob !== null) {
    const ruta = join(raiz, '.credentials.json');
    writeFileSync(ruta, JSON.stringify(blob), 'utf8');
    chmodSync(ruta, 0o600);
  }
  return { raiz, perfil: { directorio: raiz, nombre: '.claude', porDefecto: false, cuenta: null } };
}

const EN_UNA_HORA = Date.now() + 3_600_000;
const HACE_UNA_HORA = Date.now() - 3_600_000;

describe('credenciales · el estado que se muestra', () => {
  test('una credencial vigente se reporta presente, con su vencimiento y SIN el token', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const { perfil, raiz } = perfilCon({
      claudeAiOauth: { accessToken: 'sk-ant-secreto-que-no-tiene-que-salir', expiresAt: EN_UNA_HORA },
    });
    try {
      const e = estadoCredencial(perfil);
      assert.equal(e.presente, true);
      assert.equal(e.vencida, false);
      assert.equal(e.error, null);
      assert.ok(e.expiraEn instanceof Date);

      // Lo importante del archivo entero: el secreto no viaja en el estado.
      const serializado = JSON.stringify(e);
      assert.ok(!serializado.includes('secreto-que-no-tiene-que-salir'),
        'estadoCredencial no puede devolver el token ni adentro de otro campo');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('una credencial vencida se marca vencida, y sigue siendo "presente"', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const { perfil, raiz } = perfilCon({
      claudeAiOauth: { accessToken: 'sk-ant-vieja', expiresAt: HACE_UNA_HORA },
    });
    try {
      const e = estadoCredencial(perfil);
      assert.equal(e.presente, true, 'está, sólo que no sirve: son cosas distintas');
      assert.equal(e.vencida, true);
      assert.equal(e.error, null);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('el blob sin envoltorio claudeAiOauth también se entiende', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const { perfil, raiz } = perfilCon({ accessToken: 'sk-ant-plano', expiresAt: EN_UNA_HORA });
    try {
      assert.equal(estadoCredencial(perfil).presente, true);
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('sin archivo: ausente y sin error inventado (salvo en Windows, que no está verificado)', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const { perfil, raiz } = perfilCon(null);
    try {
      const e = estadoCredencial(perfil);
      assert.equal(e.presente, false);
      assert.equal(e.vencida, false);
      if (process.platform === 'win32') {
        // Decir «sin credencial» en Windows sería inventar un diagnóstico y
        // mandar al usuario a loguearse de nuevo: puede estar en DPAPI.
        assert.ok(e.error && e.error.includes('DPAPI'));
      } else {
        assert.equal(e.error, null);
      }
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('un archivo ilegible da una FRASE, no una excepción', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const raiz = mkdtempSync(join(tmpdir(), 'qm-cred-'));
    writeFileSync(join(raiz, '.credentials.json'), '{esto no es json', 'utf8');
    const perfil: Perfil = { directorio: raiz, nombre: '.claude', porDefecto: false, cuenta: null };
    try {
      const e = estadoCredencial(perfil);
      assert.equal(e.presente, false);
      assert.ok(e.error && e.error.length > 0, 'silencio es el bug: tiene que decir qué pasó');
      assert.ok(!e.error.includes('\n'), 'una línea, que es lo que entra en la pantalla');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('credenciales · el token, que es el otro camino', () => {
  test('devuelve el token sólo si está vigente', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const viva = perfilCon({ claudeAiOauth: { accessToken: 'sk-vive', expiresAt: EN_UNA_HORA } });
    const muerta = perfilCon({ claudeAiOauth: { accessToken: 'sk-muere', expiresAt: HACE_UNA_HORA } });
    const nada = perfilCon(null);
    try {
      assert.equal(tokenDeAcceso(viva.perfil), 'sk-vive');
      assert.equal(tokenDeAcceso(muerta.perfil), null, 'vencido es lo mismo que no tener');
      assert.equal(tokenDeAcceso(nada.perfil), null);
    } finally {
      for (const p of [viva, muerta, nada]) rmSync(p.raiz, { recursive: true, force: true });
    }
  });

  test('nunca refresca: leer el token no reescribe el archivo', {
    skip: esMac ? 'en macOS la credencial vive en el llavero' : false,
  }, () => {
    const { perfil, raiz } = perfilCon({
      claudeAiOauth: { accessToken: 'sk-vive', refreshToken: 'rt-no-tocar', expiresAt: EN_UNA_HORA },
    });
    const ruta = join(raiz, '.credentials.json');
    try {
      const antes = readFileSync(ruta, 'utf8');
      tokenDeAcceso(perfil);
      estadoCredencial(perfil);
      assert.equal(readFileSync(ruta, 'utf8'), antes,
        'SOUL.md, non-goal locked: quartermaster lee credenciales, no las escribe');
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('credenciales · dónde dice que está', () => {
  test('la ubicación es la del sistema, y se puede mostrar', () => {
    const { perfil, raiz } = perfilCon(null);
    try {
      const donde = ubicacionCredencial(perfil);
      if (esMac) {
        assert.equal(donde, servicioLlavero(raiz), 'en macOS es el servicio del llavero');
      } else {
        assert.ok(donde.endsWith('.credentials.json'));
      }
    } finally {
      rmSync(raiz, { recursive: true, force: true });
    }
  });

  // El hallazgo que hace posible el multi-perfil, y que no depende del SO para
  // comprobarse: el nombre del servicio del llavero es determinista.
  test('el servicio del llavero: el directorio por defecto no lleva sufijo, los demás sí', () => {
    assert.equal(servicioLlavero(directorioPorDefecto()), 'Claude Code-credentials');
    const otro = servicioLlavero('/Users/quien/.claude-teams');
    assert.match(otro, /^Claude Code-credentials-[0-9a-f]{8}$/);
    assert.equal(otro, servicioLlavero('/Users/quien/.claude-teams'), 'y es estable');
    assert.notEqual(otro, servicioLlavero('/Users/quien/.claude-personal'));
  });
});
