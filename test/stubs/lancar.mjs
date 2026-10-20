// Dublê de central/lancar/lancar.mjs (contrato C3). Guarda as chamadas em `chamadas` para o teste conferir.
export const chamadas = { lancar: [], sessoes: 0 };
export const controle = { falharLancar: false, sessoes: [{ id: 'abc123', nome: 'plano-P1', cwd: '/tmp', status: 'running', esperando: null }] };
// como o real (C3 integrado): argvLocal/argvNuvem embrulham o prompt com opcoes.planoArquivo
export function argvLocal(item, papel, opcoes = {}) {
  return ['claude', '--bg', '--name', `plano-${item.id}`, '--model', item.modelo || papel?.modelo || 'claude-sonnet-5-5', '--effort', papel?.esforco || 'medium', '--permission-mode', papel?.permissao || 'default', embrulhar(item, opcoes)];
}
export function argvNuvem(item, opcoes = {}) { return ['claude', '--cloud', embrulhar(item, opcoes)]; }
export function textoProjects(plano, itens) { return `Plano: ${plano.titulo}\n` + itens.map((i) => `## ${i.titulo}\n${i.prompt}`).join('\n'); }
export function embrulhar(item, { planoArquivo }) { return `${item.prompt}\n[marcar em ${planoArquivo}]`; }
export async function lancar(argv, { spawn, cwd } = {}) {
  chamadas.lancar.push({ argv, cwd });
  if (controle.falharLancar) return { ok: false, saida: 'erro simulado' };
  if (argv[1] === '--cloud' && argv.length === 3) return { ok: true, saida: '', id: 'cse_1', url: 'https://claude.ai/code/cse_1' };
  return { ok: true, saida: '', id: 'bg1' };
}
export async function sessoes({ spawn }) { chamadas.sessoes++; return controle.sessoes; }
export function argvParar(id) { return ['claude', 'stop', id]; }
export function argvMensagemNuvem(id, texto) { return ['claude', '-p', texto, '--cloud', id, '--output-format', 'json']; }
