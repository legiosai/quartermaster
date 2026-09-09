// H0 · preflight: ¿qué perfiles hay en esta máquina y sus credenciales
// AUTENTICAN? No alcanza con que el archivo exista: una credencial presente y
// vencida es exactamente el estado en el que otras herramientas se quedan
// mudas para siempre.
//
// En macOS esto puede abrir un prompt del llavero por perfil. Es esperado.

import { descubrirPerfiles } from '../core/perfiles.ts';
import { estadoCredencial } from '../adapters/credenciales.ts';
import { negrita, relleno, rojo, tenue, verde, amarillo, duracion } from '../render/barras.ts';

const perfiles = descubrirPerfiles();

if (perfiles.length === 0) {
  console.log('No se encontró ningún perfil de Claude Code en esta máquina.');
  process.exit(1);
}

console.log(negrita(`\nPerfiles de Claude Code · ${process.platform}\n`));

let usables = 0;
for (const p of perfiles) {
  const cred = estadoCredencial(p);
  const cuenta = p.cuenta?.email ?? tenue('sin cuenta');
  const plan = p.cuenta?.plan ? tenue(` ${p.cuenta.plan}`) : '';

  let veredicto: string;
  if (cred.error !== null) veredicto = rojo(`ilegible · ${cred.error}`);
  else if (!cred.presente) veredicto = tenue('sin credencial');
  else if (cred.vencida) veredicto = amarillo('VENCIDA · corré: claude auth login');
  else {
    usables += 1;
    const resta = cred.expiraEn ? tenue(` (${duracion(cred.expiraEn.getTime() - Date.now())})`) : '';
    veredicto = verde('vigente') + resta;
  }

  console.log(`  ${relleno(p.nombre, 18)} ${relleno(String(cuenta), 32)}${plan}`);
  console.log(`  ${relleno('', 18)} ${tenue(cred.ubicacion)}`);
  console.log(`  ${relleno('', 18)} ${veredicto}\n`);
}

console.log(`${usables} de ${perfiles.length} perfiles con credencial vigente.\n`);
process.exit(usables > 0 ? 0 : 1);
