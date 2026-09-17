// La resta que convierte dos contadores públicos en «¿alguien lo instaló?».
//
// Los dos contadores cuentan lo nuestro: los mirrors de npm bajan cada versión
// nueva y release.yml baja el instalador para el hash de winget. Si la resta se
// equivoca, el número dice que hay usuarios cuando lo que hay es una release.

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PISO, REPOS_CANAL, agregarAlHistorial, estaSemana, separarAdjuntos, separarClones, separarEstrellas, separarNpm, tipoAdjunto } from '../scripts/descargas.mjs';

describe('npm', () => {
  it('un día con publicación no cuenta como humano; uno sin publicación sí', () => {
    const r = separarNpm(
      [{ day: '2026-09-13', downloads: 180 }, { day: '2026-09-14', downloads: 777 }, { day: '2026-09-15', downloads: 3 }],
      ['2026-09-13T19:15:18.561Z', '2026-09-14T13:08:32.772Z', '2026-09-14T14:39:18.059Z'],
    );
    strictEqual(r.total, 960);
    strictEqual(r.enDiasSinPublicar, 3);
    // (180 + 777) / 3 publicaciones
    strictEqual(r.porPublicacion, 319);
    strictEqual(r.dias[1]!.humanas, null);
    strictEqual(r.dias[2]!.humanas, 3);
  });

  it('sin publicaciones no hay promedio por publicación, y no se divide por cero', () => {
    strictEqual(separarNpm([{ day: '2026-09-15', downloads: 2 }], []).porPublicacion, null);
  });
});

describe('adjuntos de las releases', () => {
  it('reconoce cada adjunto por el nombre y deja afuera los SHA', () => {
    strictEqual(tipoAdjunto('quartermaster-0.1.15-setup.exe'), 'exe');
    strictEqual(tipoAdjunto('quartermaster-0.1.15-win.zip'), 'zip');
    strictEqual(tipoAdjunto('quartermaster_0.1.15_all.deb'), 'deb');
    strictEqual(tipoAdjunto('quartermaster@legios.shell-extension.zip'), 'extension');
    strictEqual(tipoAdjunto('SHA256SUMS.txt'), null);
  });

  it('resta el piso de la automatización al exe y al zip, y cuenta enteros el .deb y la extensión', () => {
    const r = separarAdjuntos([{
      tag_name: 'v0.1.13',
      published_at: '2026-09-15T01:46:49Z',
      assets: [
        { name: 'quartermaster-0.1.13-setup.exe', download_count: 9 },
        { name: 'quartermaster-0.1.13-win.zip', download_count: 3 },
        { name: 'quartermaster_0.1.13_all.deb', download_count: 1 },
        { name: 'quartermaster@legios.shell-extension.zip', download_count: 1 },
        { name: 'SHA256SUMS.txt', download_count: 1 },
      ],
    }]);
    strictEqual(r.humanas, (9 - PISO.exe) + (3 - PISO.zip) + 1 + 1);
    strictEqual(r.porVersion[0]!.adjuntos['exe']?.netas, 5);
  });

  it('una release que bajó menos que el piso no da negativo', () => {
    const r = separarAdjuntos([{ tag_name: 'v0.1.15', published_at: null, assets: [{ name: 'quartermaster-0.1.15-setup.exe', download_count: 2 }] }]);
    strictEqual(r.humanas, 0);
  });
});

describe('historial y «esta semana»', () => {
  it('reemplaza la línea de hoy en vez de duplicarla', () => {
    const h = agregarAlHistorial([{ fecha: '2026-09-16', npm: 1, github: 1 }], '2026-09-16', 2, 3);
    deepStrictEqual(h, [{ fecha: '2026-09-16', npm: 2, github: 3 }]);
  });

  it('esta semana resta contra la línea de hace siete días o más', () => {
    const h = [
      { fecha: '2026-09-08', npm: 0, github: 2 },
      { fecha: '2026-09-09', npm: 1, github: 2 },
      { fecha: '2026-09-16', npm: 4, github: 7 },
    ];
    deepStrictEqual(estaSemana(h, '2026-09-16'), { desde: '2026-09-09', npm: 3, github: 5 });
  });

  it('con menos de una semana de historial, resta contra la primera línea', () => {
    const h = [{ fecha: '2026-09-15', npm: 0, github: 5 }, { fecha: '2026-09-16', npm: 1, github: 6 }];
    deepStrictEqual(estaSemana(h, '2026-09-16'), { desde: '2026-09-15', npm: 1, github: 1 });
  });
});

// Los dos canales que no tienen contador —un tap de Homebrew y un bucket de
// scoop no reportan instalaciones a nadie— y que además son el CTA principal.
// Lo único que dejan es el git fetch del cliente, mezclado con los checkouts
// del CI. Separarlos es el mismo truco que con npm: mirar los días quietos.
describe('los canales sin contador', () => {
  it('un día con release no cuenta; uno sin release sí, y por únicos', () => {
    const r = separarClones(
      [
        { timestamp: '2026-09-14T00:00:00Z', count: 27, uniques: 13 }, // hubo release
        { timestamp: '2026-09-15T00:00:00Z', count: 51, uniques: 29 }, // hubo release
        { timestamp: '2026-09-12T00:00:00Z', count: 2, uniques: 2 },   // día quieto
      ],
      ['2026-09-14T13:08:32Z', '2026-09-15T14:33:38Z'],
    );
    strictEqual(r.total, 80);
    strictEqual(r.unicos, 44);
    // Sólo el día sin release, y por únicos: dos fetches de una misma máquina
    // son una persona, no dos.
    strictEqual(r.enDiasSinRelease, 2);
    strictEqual(r.dias[0]!.quietos, null);
    strictEqual(r.dias[2]!.quietos, 2);
  });

  it('cuenta los días quietos, porque sin ventana un cero no significa nada', () => {
    // Cortando una release por día no queda ningún día quieto. Ahí
    // enDiasSinRelease da 0 por falta de ventana, no por falta de gente, y las
    // dos cosas se leerían igual sin este contador.
    const r = separarClones(
      [{ timestamp: '2026-09-14T00:00:00Z', count: 27, uniques: 13 }],
      ['2026-09-14T13:08:32Z'],
    );
    strictEqual(r.enDiasSinRelease, 0);
    strictEqual(r.diasSinRelease, 0);
  });

  it('sin días, no rompe', () => {
    deepStrictEqual(separarClones(undefined, []), { total: 0, unicos: 0, enDiasSinRelease: 0, diasSinRelease: 0, dias: [] });
  });

  it('los dos repos de canal son los que sirven brew y scoop', () => {
    strictEqual(REPOS_CANAL.brew, 'legiosai/homebrew-tap');
    strictEqual(REPOS_CANAL.scoop, 'legiosai/scoop-bucket');
  });
});

// Una estrella es lo único del tablero que viene con una cuenta atrás: una
// descarga es una IP, y una IP puede ser un escáner.
describe('las estrellas', () => {
  it('las agrupa por día y las ordena', () => {
    const r = separarEstrellas([
      { starred_at: '2026-09-16T19:39:00Z' },
      { starred_at: '2026-09-16T13:10:00Z' },
      { starred_at: '2026-09-17T09:00:00Z' },
    ]);
    strictEqual(r.total, 3);
    deepStrictEqual(r.dias, [{ dia: '2026-09-16', estrellas: 2 }, { dia: '2026-09-17', estrellas: 1 }]);
  });

  it('sin la cabecera star+json no hay starred_at, y eso no cuenta como día', () => {
    const r = separarEstrellas([{ login: 'alguien' }]);
    strictEqual(r.total, 1);
    deepStrictEqual(r.dias, []);
  });

  it('sin estrellas, no rompe', () => {
    deepStrictEqual(separarEstrellas(undefined), { total: 0, dias: [] });
  });
});
