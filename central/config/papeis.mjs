// Papéis configuráveis da Central (docs/arquitetura.md, contrato C4).
//
// Formato de papeis.json: { [papel]: { modelo, esforco, onde, permissao } }
// O schema é fechado: só os papéis de PADRAO, só as quatro chaves, e cada valor
// vem de uma lista fechada. Nenhum texto livre chega à linha de comando.
// O fs entra por injeção ({ fs } com readFile/writeFile/rename/unlink no formato
// de node:fs/promises).

export const MODELOS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
export const ESFORCOS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const PERMISSOES = Object.freeze(['default', 'acceptEdits', 'plan']);
export const ONDES = Object.freeze(['local', 'nuvem', 'projects']);

const CAMPOS = Object.freeze({ modelo: MODELOS, esforco: ESFORCOS, onde: ONDES, permissao: PERMISSOES });

function congelar(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') congelar(v);
  return Object.freeze(obj);
}

export const PADRAO = congelar({
  orquestrador: { modelo: 'claude-opus-5-5', esforco: 'medium', onde: 'local', permissao: 'plan' },
  lider: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'default' },
  executor: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'acceptEdits' },
  verificador: { modelo: 'claude-sonnet-5-5', esforco: 'low', onde: 'nuvem', permissao: 'default' },
  rapido: { modelo: 'claude-haiku-5-5', esforco: 'low', onde: 'local', permissao: 'default' },
});

export const PAPEIS = Object.freeze(Object.keys(PADRAO));

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Devolve a lista de erros (vazia = ok). */
export function validarPapeis(obj) {
  const erros = [];
  if (!ehObjeto(obj)) return ['papéis: precisa ser um objeto'];
  for (const papel of Object.keys(obj)) {
    if (!PAPEIS.includes(papel)) erros.push(`papel desconhecido: "${papel}"`);
  }
  for (const papel of PAPEIS) {
    const cfg = obj[papel];
    if (cfg === undefined) { erros.push(`papel "${papel}" ausente`); continue; }
    if (!ehObjeto(cfg)) { erros.push(`papel "${papel}": precisa ser um objeto`); continue; }
    for (const chave of Object.keys(cfg)) {
      if (!(chave in CAMPOS)) erros.push(`papel "${papel}": chave desconhecida "${chave}"`);
    }
    for (const [campo, lista] of Object.entries(CAMPOS)) {
      const v = cfg[campo];
      if (v === undefined) erros.push(`papel "${papel}": falta "${campo}"`);
      else if (!lista.includes(v)) erros.push(`papel "${papel}": ${campo} "${v}" não é aceito (use ${lista.join(', ')})`);
    }
  }
  return erros;
}

function copiaPadrao() {
  return JSON.parse(JSON.stringify(PADRAO));
}

/** Lê papeis.json. Arquivo ausente → cópia do PADRAO. Arquivo inválido → erro. */
export async function lerPapeis(caminho, { fs }) {
  let texto;
  try {
    texto = await fs.readFile(caminho, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return copiaPadrao();
    throw e;
  }
  let obj;
  try {
    obj = JSON.parse(texto);
  } catch {
    throw new Error(`papéis: ${caminho} não é JSON válido`);
  }
  const erros = validarPapeis(obj);
  if (erros.length) throw new Error(`papéis inválidos: ${erros.join('; ')}`);
  return obj;
}

let contadorTmp = 0;

/** Grava papeis.json de forma atômica (tmp + rename). Recusa objeto inválido. */
export async function gravarPapeis(caminho, obj, { fs }) {
  const erros = validarPapeis(obj);
  if (erros.length) throw new Error(`papéis inválidos: ${erros.join('; ')}`);
  const limpo = {};
  for (const papel of PAPEIS) {
    const { modelo, esforco, onde, permissao } = obj[papel];
    limpo[papel] = { modelo, esforco, onde, permissao };
  }
  const tmp = `${caminho}.${process.pid}.${++contadorTmp}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(limpo, null, 2) + '\n', 'utf8');
  try {
    await fs.rename(tmp, caminho);
  } catch (e) {
    try { await fs.unlink?.(tmp); } catch { /* nada a limpar */ }
    throw e;
  }
  return limpo;
}
