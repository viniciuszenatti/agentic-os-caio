// como os reais: fs é a API de promessas
// Dublê de central/config/papeis.mjs (contrato C4).
import path from 'node:path';
export const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSOES = ['default', 'acceptEdits', 'plan'];
export const ONDES = ['local', 'nuvem', 'projects'];
export const PADRAO = {
  orquestrador: { modelo: 'claude-opus-5-5', esforco: 'medium', onde: 'local', permissao: 'plan' },
  executor: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'acceptEdits' },
};
export function validarPapeis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['papéis precisa ser um objeto'];
  const erros = [];
  for (const [k, v] of Object.entries(obj)) if (!MODELOS.includes(v?.modelo)) erros.push(`${k}: modelo fora da lista`);
  return erros;
}
export async function lerPapeis(caminho, { fs }) {
  try { return JSON.parse(await fs.readFile(caminho, 'utf8')); } catch { return PADRAO; }
}
export async function gravarPapeis(caminho, obj, { fs }) {
  await fs.mkdir(path.dirname(caminho), { recursive: true });
  await fs.writeFile(caminho, JSON.stringify(obj));
}
