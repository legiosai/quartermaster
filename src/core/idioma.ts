// En qué idioma habla qm.
//
// El README y la landing están en inglés; hasta 0.1.21 todo lo que imprimía
// `qm` estaba en castellano («reinicia en», «podés gastar»). Quien llegaba por
// el README instalaba, corría `qm` y se encontraba con otro idioma.
//
// La regla es la de cualquier programa de terminal: lo decide el locale. Las
// frases quedan escritas en los dos idiomas EN EL LUGAR donde se usan —con
// `tr(es, en)`— y no en un catálogo de claves: quien revisa un cambio ve las
// dos versiones juntas, y una frase que cambia de sentido en una cambia en la
// otra en el mismo diff.
//
// Se evalúa en CADA llamada, sin cache. Cuesta leer cuatro variables de
// entorno, y a cambio el idioma lo puede fijar cualquiera que corra antes de
// imprimir: `--idioma=`, la regla de `--json` en qm.ts, o un test después de
// sus imports.

export type Idioma = 'es' | 'en';

/** El idioma pedido explícitamente con QM_IDIOMA, o null si no se pidió (o se pidió uno que no existe). */
export function idiomaPedido(env: NodeJS.ProcessEnv = process.env): Idioma | null {
  const v = env['QM_IDIOMA']?.trim().toLowerCase();
  return v === 'es' || v === 'en' ? v : null;
}

/**
 * QM_IDIOMA gana. Si no, el primero que no esté vacío de LC_ALL, LC_MESSAGES y
 * LANG, que es el orden de POSIX: `es*` es castellano y cualquier otra cosa
 * —incluidos C, POSIX y C.UTF-8— es inglés. Sin ninguna de las tres (lo normal
 * en Windows) decide el locale de Intl, que en Windows sale de la
 * configuración regional del sistema.
 */
export function idioma(env: NodeJS.ProcessEnv = process.env): Idioma {
  const pedido = idiomaPedido(env);
  if (pedido !== null) return pedido;
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[k]?.trim();
    if (v) return /^es([_.@-]|$)/i.test(v) ? 'es' : 'en';
  }
  let local = '';
  try {
    local = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    /* sin Intl no hay de dónde sacarlo: inglés */
  }
  return /^es([_-]|$)/i.test(local) ? 'es' : 'en';
}

/** La frase en el idioma de esta corrida. Las dos versiones van juntas en el lugar donde se usan. */
export function tr(es: string, en: string): string {
  return idioma() === 'es' ? es : en;
}
