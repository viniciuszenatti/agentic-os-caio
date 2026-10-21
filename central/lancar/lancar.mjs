/**
 * C3. Lançadores da Central: monta o argv de cada modo (local `--bg`,
 * nuvem `--cloud`, mensagem para a nuvem, parar), embrulha o prompt com as
 * instruções de marcar início e fim, monta o texto do modo `projects` e roda
 * o processo pelo `spawn` injetado, lendo id e URL da saída do `claude`.
 *
 * Regras (docs/arquitetura.md):
 * - nada passa por shell: o argv é montado aqui e vai para `spawn(cmd, args)`;
 * - o prompt vai como UM argumento;
 * - id do item `^[A-Za-z]+\d+$`; modelo, esforço e permissão de listas fechadas;
 *   repo dentro de `~/Projects`; `bypassPermissions` proibido.
 *
 * Saídas observadas da CLI (20/10/2026):
 * - `claude --cloud "<texto>"` num terminal imprime
 *     Created cloud session: <título>
 *     View: https://claude.ai/code/session_01X…?from=cli&m=0
 *     Resume with: claude --teleport session_01X…
 *   e EXIGE terminal interativo: sem TTY sai com
 *     "Error: --cloud requires an interactive terminal."
 *   Por isso `lancar()` aceita `spawnPty`: um executor com a mesma assinatura
 *   do `child_process.spawn`, mas que roda o comando dentro de um
 *   pseudo-terminal (ex.: node-pty, ou um helper Python `pty.spawn` recebendo
 *   o argv como lista, nunca como string de shell). Sem ele, o `--cloud` cai no
 *   `spawn` comum e volta `ok:false` com o motivo explicado.
 * - `claude -p "msg" --cloud <id> --output-format json` devolve
 *     {"ok":true,"session_id":"…","url":"…"} (só confirma a entrega).
 * - `claude --bg` imprime o id da sessão; formato exato não confirmado, então
 *   a leitura é tolerante (JSON, "id: …", UUID, `claude attach …`, linha única).
 */
import os from 'node:os';
import path from 'node:path';
import { pathDe, barrasNormais } from '../plataforma.mjs';

// Espelho das listas fechadas do C4 (central/config/papeis.mjs, item N3).
// Ficam aqui para o lançador validar sozinho; a integração (N7) pode passar a
// importar de lá.
export const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const PERMISSOES = ['default', 'acceptEdits', 'plan'];
export const ONDES = ['local', 'nuvem', 'projects'];

export const MARCADOR_PADRAO = 'central/planos/marcar.mjs';
export const RAIZES_PADRAO = ['~/Projects'];

const RE_ID = /^[A-Za-z]+\d+$/;
const RE_SESSAO_NUVEM = /^session_[A-Za-z0-9]+$/;
const RE_SESSAO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RE_NOME = /^[a-z0-9][a-z0-9-]{0,62}$/;
// caracteres que um shell ainda interpreta dentro de aspas duplas
const RE_INSEGURO_EM_ASPAS = /["`$\\\n\r\0]/;

const TIMEOUT_PADRAO = 120_000;

// ---------------------------------------------------------------- validação

function erro(msg) { return new Error(msg); }

export function validarId(id) {
  if (typeof id !== 'string' || !RE_ID.test(id)) {
    throw erro(`id inválido: ${JSON.stringify(id)} (use letras seguidas de dígitos, ex.: P1)`);
  }
  return id;
}

function deLista(valor, lista, rotulo) {
  if (valor === 'bypassPermissions') throw erro('permissão bypassPermissions é proibida pela Central');
  if (!lista.includes(valor)) {
    throw erro(`${rotulo} inválido: ${JSON.stringify(valor)} (aceitos: ${lista.join(', ')})`);
  }
  return valor;
}

function expandir(caminho, home, P) {
  if (caminho === '~') return home;
  if (caminho.startsWith('~/') || (P === path.win32 && caminho.startsWith('~\\'))) return P.join(home, caminho.slice(2));
  return caminho;
}

/**
 * Confere que `repo` fica dentro de uma das raízes (padrão `~/Projects`). Devolve o caminho absoluto.
 * `platform` escolhe as regras de caminho (no Windows: "\\", letra de unidade, sem diferenciar maiúscula).
 */
export function validarRepo(repo, { home = os.homedir(), raizes = RAIZES_PADRAO, platform = process.platform } = {}) {
  if (typeof repo !== 'string' || !repo.trim() || repo.includes('\0')) {
    throw erro('repo ausente ou inválido');
  }
  const P = pathDe(platform);
  const abs = P.resolve(expandir(repo.trim(), home, P));
  const igual = P === path.win32 ? (a) => a.toLowerCase() : (a) => a;
  for (const r of raizes) {
    const raiz = P.resolve(expandir(r, home, P));
    if (igual(abs) === igual(raiz) || igual(abs).startsWith(igual(raiz + P.sep))) return abs;
  }
  throw erro(`repo fora das pastas permitidas (${raizes.join(', ')}): ${repo}`);
}

function validarTexto(texto, rotulo) {
  if (typeof texto !== 'string' || !texto.trim()) throw erro(`${rotulo} vazio`);
  if (texto.includes('\0')) throw erro(`${rotulo} com caractere nulo`);
  // o texto vai como argumento posicional: começando com "-" a CLI o leria como opção
  if (texto.trimStart().startsWith('-')) throw erro(`${rotulo} não pode começar com "-"`);
  return texto;
}

function validarSessao(id, re = RE_SESSAO) {
  if (typeof id !== 'string' || !re.test(id)) throw erro(`id de sessão inválido: ${JSON.stringify(id)}`);
  return id;
}

/** Nome da sessão `--bg`: `<plano>-<id>` em minúsculas, só [a-z0-9-]. */
export function nomeDaSessao(item, planoArquivo) {
  validarId(item.id);
  const base = planoArquivo
    ? String(planoArquivo).replace(/^.*[\\/]/, '').replace(/\.md$/i, '') // basename com / ou \\ (Windows)
    : 'plano';
  const slug = base.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plano';
  const nome = `${slug.slice(0, 50).replace(/-+$/, '')}-${item.id.toLowerCase()}`;
  if (!RE_NOME.test(nome)) throw erro(`nome de sessão inválido: ${nome}`);
  return nome;
}

// ---------------------------------------------------------------- prompt

/**
 * O prompt como vai para a sessão.
 * - onde=local: primeira ação `node <marcador> iniciou "<plano>" <id>`, última `concluiu`.
 * - onde=nuvem|projects: a sessão não alcança a máquina, então o fim é marcado
 *   por commit + push na branch `plano/<id>` (a Central confere a branch/PR).
 */
export function embrulhar(item, { planoArquivo, marcador = MARCADOR_PADRAO, platform = process.platform } = {}) {
  validarId(item?.id);
  if (typeof item.prompt !== 'string' || !item.prompt.trim()) throw erro(`prompt vazio no item ${item.id}`);
  const onde = deLista(item.onde ?? 'local', ONDES, 'onde');

  if (onde === 'local') {
    if (typeof planoArquivo !== 'string' || !planoArquivo.trim()) {
      throw erro('planoArquivo é obrigatório para onde=local (o marcar.mjs precisa dele)');
    }
    // No Windows o caminho vem com "\\": vira "/" (o node aceita) para citar entre aspas sem escape de shell.
    planoArquivo = barrasNormais(planoArquivo, platform);
    marcador = barrasNormais(marcador, platform);
    if (RE_INSEGURO_EM_ASPAS.test(planoArquivo) || RE_INSEGURO_EM_ASPAS.test(marcador)) {
      throw erro('caminho do plano ou do marcador com caractere que o shell interpretaria');
    }
    const cmd = (evento) => `    node "${marcador}" ${evento} "${planoArquivo}" ${item.id}`;
    return [
      `[Central de Agentes] Você está executando o item ${item.id} do plano ${planoArquivo}.`,
      'Sua PRIMEIRA ação, antes de ler ou fazer qualquer outra coisa:',
      '',
      cmd('iniciou'),
      '',
      item.prompt.trim(),
      '',
      '[Central de Agentes] Sua ÚLTIMA ação, só quando todo o trabalho acima estiver terminado e verificado:',
      '',
      cmd('concluiu'),
      '',
      'Se você parar antes de terminar (dúvida, erro, decisão de quem pediu), NÃO rode esse comando:',
      'o painel precisa ver que a sessão parou.',
    ].join('\n');
  }

  const branch = `plano/${item.id}`;
  return [
    `[Central de Agentes] Você está executando o item ${item.id}${planoArquivo ? ` do plano ${path.basename(String(planoArquivo))}` : ''}, numa sessão na nuvem.`,
    `Trabalhe na branch \`${branch}\` (crie a partir da branch atual se não existir).`,
    '',
    item.prompt.trim(),
    '',
    '[Central de Agentes] Para terminar, só quando todo o trabalho acima estiver feito e verificado:',
    `faça commit de tudo e push na branch \`${branch}\` (git push -u origin ${branch}).`,
    'É esse push que mostra ao painel que o item foi concluído.',
    'Se você parar antes de terminar (dúvida, erro, decisão de quem pediu), NÃO faça o push final:',
    'deixe escrito na sessão o que falta.',
  ].join('\n');
}

// ---------------------------------------------------------------- argv

function resolverConfig(item, papel = {}) {
  return {
    modelo: deLista(item.modelo ?? papel.modelo, MODELOS, 'modelo'),
    esforco: deLista(item.esforco ?? papel.esforco, ESFORCOS, 'esforço'),
    permissao: deLista(item.permissao ?? papel.permissao, PERMISSOES, 'permissão'),
  };
}

/**
 * argv do lançamento local. `papel` dá o padrão; o item sobrescreve.
 * opcoes: { planoArquivo, marcador, home, raizes }.
 */
export function argvLocal(item, papel, opcoes = {}) {
  validarId(item?.id);
  validarRepo(item.repo, opcoes);
  const { modelo, esforco, permissao } = resolverConfig(item, papel);
  const nome = nomeDaSessao(item, opcoes.planoArquivo);
  const prompt = validarTexto(embrulhar({ ...item, onde: 'local' }, opcoes), 'prompt');
  return ['claude', '--bg', '--name', nome, '--model', modelo, '--effort', esforco,
    '--permission-mode', permissao, prompt];
}

/** argv do lançamento na nuvem. opcoes: { planoArquivo, home, raizes }. */
export function argvNuvem(item, opcoes = {}) {
  validarId(item?.id);
  validarRepo(item.repo, opcoes);
  const prompt = validarTexto(embrulhar({ ...item, onde: 'nuvem' }, opcoes), 'prompt');
  return ['claude', '--cloud', prompt];
}

export function argvParar(id) {
  return ['claude', 'stop', validarSessao(id)];
}

export function argvMensagemNuvem(id, texto) {
  return ['claude', '-p', validarTexto(texto, 'mensagem'), '--cloud', validarSessao(id, RE_SESSAO_NUVEM),
    '--output-format', 'json'];
}

// ---------------------------------------------------------------- texto do Projects

/** Critério de pronto: item.pronto, ou a linha "Pronto = …" do prompt, ou o padrão. */
export function criterioDePronto(item) {
  if (typeof item.pronto === 'string' && item.pronto.trim()) return item.pronto.trim();
  const m = /(?:^|[\s.])Pronto\s*[=:]\s*([^\n]+)/i.exec(item.prompt ?? '');
  if (m) return m[1].trim().replace(/\.$/, '');
  return `trabalho do prompt feito e verificado, com commit e push na branch plano/${item.id}`;
}

/**
 * Texto único para colar no coordenador do Claude Projects: objetivo do plano
 * e um bloco por item (título, repo, prompt, critério de pronto).
 */
export function textoProjects(plano, itens) {
  if (!Array.isArray(itens) || itens.length === 0) throw erro('nenhum item para o Projects');
  const titulo = plano?.titulo?.trim() || 'Plano sem título';
  const objetivo = plano?.objetivo?.trim() || titulo;
  const partes = [
    `# ${titulo}`,
    '',
    `Objetivo do plano: ${objetivo}`,
    '',
    `Você coordena ${itens.length} ${itens.length === 1 ? 'item' : 'itens'}. Abra uma sessão por item, no repo indicado.`,
    'Cada item trabalha na própria branch `plano/<id>` e termina com commit + push nela (é assim que a Central vê que acabou).',
  ];
  itens.forEach((item, i) => {
    validarId(item?.id);
    if (typeof item.prompt !== 'string' || !item.prompt.trim()) throw erro(`prompt vazio no item ${item.id}`);
    partes.push(
      '',
      '---',
      '',
      `## Item ${i + 1} de ${itens.length}: ${item.id} · ${item.titulo?.trim() || 'sem título'}`,
      '',
      `- Repo: ${item.repo ?? '(não informado)'}`,
      `- Branch: plano/${item.id}`,
      `- Critério de pronto: ${criterioDePronto(item)}`,
      ...(item.depende?.length ? [`- Só comece depois de: ${item.depende.join(', ')}`] : []),
      '',
      'Prompt:',
      '',
      item.prompt.trim(),
    );
  });
  return partes.join('\n') + '\n';
}

// ---------------------------------------------------------------- execução

const RE_ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/** Tira cores/controles de terminal e normaliza quebras (saída de PTY). */
export function limparSaida(texto) {
  return String(texto ?? '').replace(RE_ANSI, '').replace(/\r\n?/g, '\n');
}

function primeiraLinha(texto) {
  return limparSaida(texto).split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

function tentarJson(texto) {
  const t = texto.trim();
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try { return JSON.parse(t.slice(ini, fim + 1)); } catch { return null; }
}

/** Lê a saída do `claude --cloud`. */
export function lerSaidaNuvem(texto) {
  const s = limparSaida(texto);
  if (/--cloud requires an interactive terminal/i.test(s)) {
    return {
      ok: false,
      motivo: 'o claude --cloud exige terminal interativo: a Central precisa rodá-lo por um executor com pseudo-terminal (spawnPty)',
    };
  }
  const url = /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/.exec(s);
  const tele = /--teleport\s+(session_[A-Za-z0-9]+)/.exec(s);
  const solto = /\b(session_[A-Za-z0-9]{6,})\b/.exec(s);
  const id = url?.[1] ?? tele?.[1] ?? solto?.[1];
  if (!id) return { ok: false, motivo: `saída inesperada do claude --cloud: ${primeiraLinha(s) || '(vazia)'}` };
  const titulo = /Created cloud session:\s*(.+)/i.exec(s)?.[1]?.trim();
  return { ok: true, id, url: `https://claude.ai/code/${id}`, ...(titulo ? { titulo } : {}) };
}

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Lê a saída do `claude --bg` (formato não confirmado: leitura tolerante). */
export function lerSaidaBg(texto) {
  const s = limparSaida(texto);
  const json = tentarJson(s);
  const doJson = json && (json.id ?? json.session_id ?? json.sessionId);
  if (typeof doJson === 'string' && RE_SESSAO.test(doJson)) return { ok: true, id: doJson };

  const padroes = [
    /claude\s+(?:attach|logs|stop)\s+([A-Za-z0-9][A-Za-z0-9_-]*)/i,
    /\b(?:session\s*id|sess[aã]o|session|id)\b\s*[:=#]?\s*([A-Za-z0-9][A-Za-z0-9_-]{5,})/i,
  ];
  const uuid = RE_UUID.exec(s);
  if (uuid) return { ok: true, id: uuid[0] };
  for (const re of padroes) {
    const m = re.exec(s);
    if (m && !/^(started|iniciad|created|running)/i.test(m[1])) return { ok: true, id: m[1] };
  }
  const linhas = s.split('\n').map((l) => l.trim()).filter(Boolean);
  if (linhas.length === 1 && RE_SESSAO.test(linhas[0]) && linhas[0].length >= 6) {
    return { ok: true, id: linhas[0] };
  }
  return { ok: false, motivo: `saída inesperada do claude --bg: ${primeiraLinha(s) || '(vazia)'}` };
}

/** Lê a saída JSON do `claude -p … --cloud <id> --output-format json`. */
export function lerSaidaMensagem(texto) {
  const json = tentarJson(limparSaida(texto));
  if (!json) return { ok: false, motivo: `saída inesperada da mensagem: ${primeiraLinha(texto) || '(vazia)'}` };
  if (json.ok !== true) return { ok: false, motivo: json.error ?? json.erro ?? 'a CLI não confirmou a entrega' };
  return { ok: true, ...(json.session_id ? { id: json.session_id } : {}), ...(json.url ? { url: json.url } : {}) };
}

function tipoDoArgv(argv) {
  if (argv.includes('--bg')) return 'bg';
  if (argv.includes('-p') && argv.includes('--cloud')) return 'mensagem';
  if (argv.includes('--cloud')) return 'nuvem';
  return 'outro';
}

/** Roda o argv pelo spawn dado e junta stdout+stderr. Nunca rejeita. */
function rodar(spawn, argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let saida = '';
    let erroSaida = '';
    let fim = false;
    let filho;
    const terminar = (r) => { if (!fim) { fim = true; clearTimeout(relogio); resolve(r); } };
    const relogio = setTimeout(() => {
      try { filho?.kill?.('SIGTERM'); } catch { /* já saiu */ }
      terminar({ codigo: null, saida, erroSaida, falha: `o claude não terminou em ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    try {
      filho = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      terminar({ codigo: null, saida, erroSaida, falha: `não foi possível iniciar o claude: ${e.message}` });
      return;
    }
    filho.stdout?.on('data', (d) => { saida += d; });
    filho.stderr?.on('data', (d) => { erroSaida += d; });
    filho.on?.('error', (e) => terminar({ codigo: null, saida, erroSaida, falha: `não foi possível iniciar o claude: ${e.message}` }));
    filho.on?.('close', (codigo) => terminar({ codigo, saida, erroSaida }));
  });
}

function validarArgv(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'claude' || argv.length < 2) throw erro('argv inválido: precisa começar com "claude"');
  for (const a of argv) {
    if (typeof a !== 'string' || a.includes('\0')) throw erro('argv inválido: só textos, sem caractere nulo');
  }
  if (argv.includes('bypassPermissions') || argv.includes('--dangerously-skip-permissions')) {
    throw erro('permissão bypassPermissions é proibida pela Central');
  }
}

/**
 * Roda um argv montado acima. Devolve { ok, saida, id?, url?, motivo? }.
 * deps: { spawn, spawnPty?, cwd, home?, raizes?, timeoutMs? }
 * - `spawn`: assinatura de child_process.spawn (dublê nos testes);
 * - `spawnPty`: mesma assinatura, rodando num pseudo-terminal; usado no
 *   `--cloud` de criação (a CLI recusa sem TTY);
 * - `cwd`: o repo do item, validado dentro de ~/Projects.
 */
export async function lancar(argv, { spawn, spawnPty, cwd, home, raizes, platform, timeoutMs = TIMEOUT_PADRAO } = {}) {
  let dir;
  try {
    validarArgv(argv);
    if (typeof spawn !== 'function') throw erro('spawn não informado');
    dir = validarRepo(cwd, { home, raizes, ...(platform ? { platform } : {}) });
  } catch (e) {
    return { ok: false, saida: '', motivo: e.message };
  }
  const tipo = tipoDoArgv(argv);
  const executor = tipo === 'nuvem' && typeof spawnPty === 'function' ? spawnPty : spawn;
  const r = await rodar(executor, argv, { cwd: dir, timeoutMs });
  const saida = limparSaida(r.saida + (r.erroSaida ? (r.saida ? '\n' : '') + r.erroSaida : ''));

  if (r.falha) return { ok: false, saida, motivo: r.falha };

  let lido;
  if (tipo === 'nuvem') lido = lerSaidaNuvem(saida);
  else if (tipo === 'bg') lido = lerSaidaBg(r.saida || saida);
  else if (tipo === 'mensagem') lido = lerSaidaMensagem(r.saida || saida);
  else lido = { ok: true };

  // erro de TTY tem motivo próprio, mesmo com código de saída != 0
  if (!lido.ok && /terminal interativo/.test(lido.motivo)) return { ok: false, saida, motivo: lido.motivo };
  if (r.codigo !== 0) {
    return { ok: false, saida, motivo: `o claude saiu com código ${r.codigo}: ${primeiraLinha(r.erroSaida || r.saida) || '(sem saída)'}` };
  }
  return { saida, ...lido };
}

/**
 * Lista as sessões por `claude agents --json`.
 * Devolve Sessao[] { id, nome, cwd, status, esperando, motivoEspera }.
 * Lança Error com motivo em pt-BR se a CLI falhar ou a saída não for JSON.
 */
export async function sessoes({ spawn, timeoutMs = 15_000 } = {}) {
  if (typeof spawn !== 'function') throw erro('spawn não informado');
  const r = await rodar(spawn, ['claude', 'agents', '--json'], { cwd: undefined, timeoutMs });
  if (r.falha) throw erro(r.falha);
  if (r.codigo !== 0) throw erro(`claude agents saiu com código ${r.codigo}: ${primeiraLinha(r.erroSaida || r.saida)}`);
  let dados;
  try { dados = JSON.parse(limparSaida(r.saida).trim() || '[]'); } catch {
    throw erro(`saída inesperada do claude agents: ${primeiraLinha(r.saida) || '(vazia)'}`);
  }
  const lista = Array.isArray(dados) ? dados : (dados.agents ?? dados.sessions ?? dados.sessoes ?? []);
  if (!Array.isArray(lista)) throw erro('saída inesperada do claude agents: lista não encontrada');
  return lista.filter((s) => s && typeof s === 'object').map((s) => {
    const motivo = s.waitingFor ?? s.waiting_for ?? null;
    const status = String(s.status ?? s.state ?? 'desconhecido');
    return {
      id: String(s.id ?? s.sessionId ?? s.session_id ?? ''),
      nome: s.name ?? s.nome ?? null,
      cwd: s.cwd ?? s.directory ?? null,
      status,
      esperando: Boolean(motivo) || /^waiting$/i.test(status),
      motivoEspera: motivo ? String(motivo) : null,
    };
  });
}
