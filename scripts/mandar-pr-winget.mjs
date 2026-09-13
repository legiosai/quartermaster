#!/usr/bin/env node
// El PR a microsoft/winget-pkgs, desde el fork de la ORGANIZACIÓN.
//
// Por qué no lo hace `wingetcreate submit`, que es la herramienta que Microsoft
// publica justo para esto: wingetcreate forkea a la cuenta del token y no tiene
// forma de decirle otra cosa (ver `wingetcreate submit --help`: hay --prtitle,
// --replace, --token, --no-open, y nada de fork). O sea que la rama de una
// release de Legios quedaba colgando de la cuenta personal de quien tuviera el
// token. La 0.1.6 salió así y hubo que rehacerla a mano.
//
// Lo que sí hacía wingetcreate y acá no se pierde: normalizar los manifests.
// No hace falta —`scripts/hacer-manifests.mjs` ya los emite con la forma del
// esquema, y se comprobó que los dos árboles son EQUIVALENTES cargándolos como
// YAML: mismas claves, mismos valores, distinto orden y un comentario de
// cabecera. Lo que valida `winget validate` es el contenido, y pasa con los
// nuestros: eso ya corría en el job antes de este cambio.
//
// Todo por la API, sin clonar: winget-pkgs son cientos de miles de archivos y
// un clone en cada release sería minutos de runner para tocar cuatro YAML.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN  = process.env.GITHUB_TOKEN;
const V      = process.env.V;
const DIR    = process.env.DIR;
const ARRIBA = process.env.UPSTREAM ?? 'microsoft/winget-pkgs';
const FORK   = process.env.FORK ?? 'legiosai/winget-pkgs';
const SECO   = process.argv.includes('--en-seco');

for (const [k, v] of Object.entries({ GITHUB_TOKEN: TOKEN, V, DIR })) {
  if (!v) { console.error(`falta ${k}`); process.exit(2); }
}

const [ORG] = FORK.split('/');
const RAMA  = `Legios.Quartermaster-${V}`;
const RUTA  = `manifests/l/Legios/Quartermaster/${V}`;

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`https://api.github.com/${ruta}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'quartermaster-release',
      ...(cuerpo ? { 'content-type': 'application/json' } : {}),
    },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { /* no era json */ }
  return { ok: r.ok, estado: r.status, datos, texto };
}

function morir(que, r) {
  console.error(`::error::winget: ${que} — HTTP ${r.estado}`);
  console.error(`::error::${(r.datos?.message ?? r.texto ?? '').slice(0, 300)}`);
  console.error(`::error::Los manifests quedaron en ${DIR} y se pueden mandar a mano.`);
  process.exit(1);
}

// ── que el token llegue, y que llegue a la ORG ────────────────────────
// Un classic con public_repo alcanza para forkear y abrir el PR, pero sólo
// entra a los repos de una organización si la org no restringe los classic
// (Settings → Third-party Access → Personal access tokens). Eso no se ve por
// API hasta que se intenta, así que se intenta ACÁ, antes de tocar nada de
// Microsoft, y con un mensaje que dice dónde mirar.
const yo = await api('GET', 'user');
if (!yo.ok) morir('el token no valida (¿venció?)', yo);
console.log(`· token de ${yo.datos.login}`);

const org = await api('GET', `orgs/${ORG}`);
if (!org.ok) {
  console.error(`::error::winget: el token no llega a la organización ${ORG}.`);
  console.error('::error::Un PAT classic entra a los repos de una org sólo si la org no los restringe:');
  console.error(`::error::https://github.com/organizations/${ORG}/settings/personal-access-tokens`);
  process.exit(1);
}

// ── el fork de la org ─────────────────────────────────────────────────
let fork = await api('GET', `repos/${FORK}`);
if (!fork.ok) {
  console.log(`· ${FORK} no existe: forkeando ${ARRIBA} a la organización`);
  const hecho = await api('POST', `repos/${ARRIBA}/forks`, {
    organization: ORG, default_branch_only: true,
  });
  if (!hecho.ok) morir(`no pude forkear ${ARRIBA} a ${ORG}`, hecho);
  for (let i = 0; i < 30 && !fork.ok; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    fork = await api('GET', `repos/${FORK}`);
  }
  if (!fork.ok) morir('el fork se pidió pero GitHub no terminó de copiarlo', fork);
}
if (!fork.datos.permissions?.push) {
  console.error(`::error::winget: el token no puede escribir en ${FORK}.`);
  console.error('::error::Tiene que ser un PAT CLASSIC con public_repo, y la org no puede restringirlo.');
  process.exit(1);
}
const base = fork.datos.default_branch;
console.log(`· fork: ${FORK} (rama base ${base})`);

// Ponerlo al día con Microsoft antes de ramificar. Sin esto el fork se queda
// donde quedó la release anterior y el PR arrastra la diferencia.
const aldia = await api('POST', `repos/${FORK}/merge-upstream`, { branch: base });
console.log(aldia.ok
  ? `· ${base} al día con ${ARRIBA}: ${aldia.datos.merge_type}`
  : `· no pude sincronizar ${base} (HTTP ${aldia.estado}); sigo igual`);

if (SECO) { console.log('· --en-seco: hasta acá llego'); process.exit(0); }

// ── la rama con los cuatro manifests ──────────────────────────────────
const ref = await api('GET', `repos/${FORK}/git/ref/heads/${base}`);
if (!ref.ok) morir(`no pude leer ${base} del fork`, ref);
const shaBase = ref.datos.object.sha;

const archivos = readdirSync(DIR).filter((f) => f.endsWith('.yaml')).sort();
if (archivos.length === 0) { console.error(`::error::no hay .yaml en ${DIR}`); process.exit(1); }

const arbol = [];
for (const f of archivos) {
  const blob = await api('POST', `repos/${FORK}/git/blobs`, {
    content: readFileSync(join(DIR, f)).toString('base64'), encoding: 'base64',
  });
  if (!blob.ok) morir(`no pude subir ${f}`, blob);
  arbol.push({ path: `${RUTA}/${f}`, mode: '100644', type: 'blob', sha: blob.datos.sha });
  console.log(`  · ${f}`);
}

const tree = await api('POST', `repos/${FORK}/git/trees`, { base_tree: shaBase, tree: arbol });
if (!tree.ok) morir('no pude armar el árbol', tree);

const commit = await api('POST', `repos/${FORK}/git/commits`, {
  message: `New package: Legios.Quartermaster version ${V}`,
  tree: tree.datos.sha, parents: [shaBase],
});
if (!commit.ok) morir('no pude armar el commit', commit);

// force: un rerun del job tiene que poder repetirse sin dejar la rama a medias.
let rama = await api('PATCH', `repos/${FORK}/git/refs/heads/${RAMA}`, { sha: commit.datos.sha, force: true });
if (!rama.ok) rama = await api('POST', `repos/${FORK}/git/refs`, { ref: `refs/heads/${RAMA}`, sha: commit.datos.sha });
if (!rama.ok) morir(`no pude dejar la rama ${RAMA}`, rama);
console.log(`· rama ${ORG}:${RAMA} en ${commit.datos.sha.slice(0, 10)}`);

// ── el PR ─────────────────────────────────────────────────────────────
// Si ya hay uno abierto con esta misma cabeza, el push de arriba ya lo
// actualizó: abrir otro sería ruido en el repo de otro.
const abiertos = await api('GET', `repos/${ARRIBA}/pulls?head=${ORG}:${RAMA}&state=open`);
if (abiertos.ok && abiertos.datos.length > 0) {
  console.log(`::notice::winget: el PR ya estaba abierto y se actualizó: ${abiertos.datos[0].html_url}`);
  process.exit(0);
}

const cuerpo = [
  '## 📖 Description',
  '',
  `New package: **Legios.Quartermaster** version ${V} — a CLI that reports how much`,
  'quota is left across every Claude Code profile on the machine, plus Codex and',
  'opencode. MIT, source at https://github.com/legiosai/quartermaster',
  '',
  'Two things worth flagging for the reviewer:',
  '',
  '- The installer declares `OpenJS.NodeJS.LTS` as a dependency. The package is a',
  '  Node CLI and does nothing without a Node ≥ 22.6 runtime.',
  '- Our installer is per-user and does **not** request elevation (`InstallerType:',
  '  inno`, `Scope: user`). The Node dependency\'s MSI does, so a machine without',
  '  Node will see one UAC prompt that is not ours.',
  '',
  '## ✅ Checklist',
  '',
  '- [ ] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)',
  '',
  '## 📦 Manifest Checklist',
  '',
  '- [x] This PR only modifies one (1) manifest',
  '- [x] Validated manifest locally with `winget validate --manifest <path>`',
  '- [ ] Tested manifest locally with `winget install --manifest <path>`',
].join('\n');

const pr = await api('POST', `repos/${ARRIBA}/pulls`, {
  title: `New package: Legios.Quartermaster version ${V}`,
  head: `${ORG}:${RAMA}`, base, body: cuerpo, maintainer_can_modify: true,
});
if (!pr.ok) morir('no pude abrir el PR', pr);
console.log(`::notice::winget: PR abierto — ${pr.datos.html_url}`);
