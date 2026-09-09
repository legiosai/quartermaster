// Guarda de versión. Es .cjs a propósito: tiene que poder correr en el Node
// que el usuario tenga, incluso uno que no entienda TypeScript ni ESM moderno.
//
// Sin esto, en Node 20 todo comando de este repo muere con
//   node: bad option: --experimental-strip-types
// que no le dice a nadie qué hacer. Un error opaco es la misma clase de bug
// que un monitor mudo (ver SOUL.md).

var partes = process.versions.node.split('.').map(Number);
var mayor = partes[0] || 0;
var menor = partes[1] || 0;

if (mayor < 22 || (mayor === 22 && menor < 6)) {
  process.stderr.write(
    '\nquartermaster necesita Node >= 22.6 (tenés ' + process.versions.node + ').\n' +
      'Lee TypeScript directamente, sin paso de build, y eso recién existe desde 22.6.\n\n' +
      '  nvm install 22 && nvm use 22\n\n',
  );
  process.exit(1);
}
