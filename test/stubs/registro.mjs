// como os reais: fs é a API de promessas
// Dublê de central/planos/registro.mjs (contrato C2).
import path from 'node:path';
export async function ler(caminho, { fs }) {
  try { return JSON.parse(await fs.readFile(caminho, 'utf8')); }
  catch { return { plano: null, estado: 'proposto', aprovadoEm: null, itens: {} }; }
}
export async function gravar(caminho, registro, { fs }) {
  await fs.mkdir(path.dirname(caminho), { recursive: true });
  await fs.writeFile(caminho + '.tmp', JSON.stringify(registro));
  await fs.rename(caminho + '.tmp', caminho);
}
function estadoDe(r) {
  if (!r) return null;
  if (r.concluidoEm) return 'concluido';
  if (r.falhouEm) return 'falhou';
  if (r.entregueEm) return 'entregue-projects';
  if (r.iniciadoEm) return 'iniciado';
  if (r.disparadoEm) return 'disparado';
  return null;
}
export function estadoDosItens(plano, registro, { agora }) {
  const out = {};
  for (const i of plano.itens) {
    const e = estadoDe(registro?.itens?.[i.id]);
    if (e) { out[i.id] = e; continue; }
    const deps = i.depende.every((d) => estadoDe(registro?.itens?.[d]) === 'concluido');
    out[i.id] = deps ? 'pronto' : 'bloqueado';
  }
  return out;
}
const CAMPO = { disparou: 'disparadoEm', iniciou: 'iniciadoEm', concluiu: 'concluidoEm', falhou: 'falhouEm', 'entregou-projects': 'entregueEm' };
export function marcar(registro, id, evento, dados, { agora }) {
  const itens = { ...registro.itens, [id]: { ...(registro.itens?.[id] || {}), ...dados, [CAMPO[evento]]: agora } };
  return { ...registro, itens };
}
export function progresso(plano, registro) {
  const total = plano.itens.length;
  const concluidos = plano.itens.filter((i) => estadoDe(registro?.itens?.[i.id]) === 'concluido').length;
  return { concluidos, total, pct: total ? Math.round((concluidos / total) * 100) : 0 };
}
