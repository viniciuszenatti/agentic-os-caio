// Dublê de central/planos/plano.mjs (contrato C1). Lê só o essencial do formato de bloco.
export function lerPlano(texto) {
  const titulo = (texto.match(/^#\s+(.+)$/m) || [])[1] || '';
  const itens = [];
  for (const m of texto.matchAll(/```prompt ([^\n]*)\n([\s\S]*?)```/g)) {
    const kv = Object.fromEntries([...m[1].matchAll(/(\w+)=("[^"]*"|\S*)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]));
    const lista = (v) => (v ? v.split(',').filter(Boolean) : []);
    itens.push({ id: kv.id, titulo: `Item ${kv.id}`, prompt: m[2].trim(), repo: kv.repo, papel: kv.papel || 'executor', area: kv.area || null,
      onde: kv.onde || 'local', modelo: kv.modelo || null, esforco: kv.esforco || null, permissao: null,
      depende: lista(kv.depende), conflita: lista(kv.conflita), porta: kv.porta || null, custo: null, exclusivo: null });
  }
  return { titulo, itens, erros: itens.length ? [] : ['nenhum bloco de prompt neste documento'] };
}
export function conferir(plano, { papeis, repoExiste }) {
  const erros = [];
  for (const i of plano.itens) {
    if (!repoExiste(i.repo)) erros.push(`${i.id}: repo não existe (${i.repo})`);
    if (!papeis[i.papel]) erros.push(`${i.id}: papel desconhecido (${i.papel})`);
  }
  return erros;
}
