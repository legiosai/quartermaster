import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servicioLlavero, directorioPorDefecto } from '../src/core/perfiles.ts';
import { barra, duracion, tokens } from '../src/render/barras.ts';

// El vector fijo es lo que hace que este archivo sirva de algo: si alguien
// "simplifica" el cálculo del servicio, el hash cambia y el test cae.
test('el servicio del llavero de un perfil no-default es sha256(ruta)[:8]', () => {
  assert.equal(servicioLlavero('/home/u/.claude-work'), 'Claude Code-credentials-9fa37e90');
});

test('el directorio por defecto usa el servicio sin sufijo', () => {
  assert.equal(servicioLlavero(directorioPorDefecto()), 'Claude Code-credentials');
});

test('un directorio que se llama .claude pero no es el default sí lleva sufijo', () => {
  // 99b1807e es sha256('/home/u/.claude')[:8]: mismo basename, otra ruta.
  const esperado =
    directorioPorDefecto() === '/home/u/.claude'
      ? 'Claude Code-credentials'
      : 'Claude Code-credentials-99b1807e';
  assert.equal(servicioLlavero('/home/u/.claude'), esperado);
});

test('la barra se recorta en vez de romperse', () => {
  const limpio = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(limpio(barra(2, 10)), '██████████');
  assert.equal(limpio(barra(-1, 10)), '░░░░░░░░░░');
  assert.equal(limpio(barra(0.5, 10)), '█████░░░░░');
});

test('los tokens se leen', () => {
  assert.equal(tokens(950), '950');
  assert.equal(tokens(15_796), '15,8k');
  assert.equal(tokens(3_327_487), '3,3M');
});

test('las duraciones se leen', () => {
  assert.equal(duracion(38 * 60_000), '38m');
  assert.equal(duracion(2 * 3600_000 + 14 * 60_000), '2h14m');
  assert.equal(duracion(-1), 'vencido');
});
