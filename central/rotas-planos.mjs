// Rotas da Central: planos, papéis, score, escala, sessões, líderes e sugestões dos verificadores.
// Tudo que toca o mundo (fs, spawn, relógio, módulos dos outros itens) entra por injeção,
// para o server.mjs mudar pouco e os testes rodarem com dublês.
//
// Módulos esperados (contratos C1–C4), injetados em `mod`:
//   plano    { lerPlano, conferir }                                   central/planos/plano.mjs
//   registro { ler, gravar, estadoDosItens, marcar, progresso }       central/planos/registro.mjs
//   lancar   { argvLocal, argvNuvem, textoProjects, embrulhar, lancar, sessoes, argvParar, argvMensagemNuvem }
//   papeis   { PADRAO, MODELOS, ESFORCOS, PERMISSOES, ONDES, validarPapeis, lerPapeis, gravarPapeis }
//   score    { PESOS_PADRAO, validarPesos, calcular, tendencia }
//   escala   { ESCALA_PADRAO, validarEscala, calcularEscala }
// Módulo ausente (ainda não integrado) não derruba a Central: a rota responde 503 dizendo qual falta.
import path from 'node:path';

export const CAMINHOS_MODULOS = {
  plano: './planos/plano.mjs',
  registro: './planos/registro.mjs',
  lancar: './lancar/lancar.mjs',
  papeis: './config/papeis.mjs',
  score: './score/score.mjs',
  escala: './score/escala.mjs',
};

// Importa cada módulo do contrato; o que não existir vira null (a rota que precisa dele responde 503).
export async function carregarModulos(base = new URL('./', import.meta.url)) {
  const mod = {};
  for (const [k, rel] of Object.entries(CAMINHOS_MODULOS)) {
    try { mod[k] = await import(new URL(rel, base).href); } catch { mod[k] = null; }
  }
  return mod;
}

const ARQ_PLANO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;
const ID_ITEM = /^[A-Za-z]+\d+$/;
const ID_SESSAO = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const ACOES = new Set(['aprovar-plano', 'descartar-plano', 'parar-sessao', 'mensagem-sessao', 'concluir-projects', 'salvar-papeis', 'salvar-pesos', 'remover-sessao', 'abrir-terminal', 'tentar-de-novo']);
const CACHE_SESSOES_MS = 5_000;

const ok = (corpo, code = 200) => ({ code, corpo });
const erro = (code, msg, extra = {}) => ({ code, corpo: { erro: msg, ...extra } });
const comoLista = (r) => (Array.isArray(r) ? r.map(String) : r ? [String(r)] : []);

class Falta extends Error {
  constructor(nome) { super(`módulo ${nome} ainda não está instalado (${CAMINHOS_MODULOS[nome]})`); this.code = 503; }
}

/**
 * @param {object} o
 * @param {object} o.mod      módulos do contrato (ver topo); chave ausente/null = 503
 * @param {object} o.fs       node:fs (ou dublê com a mesma API síncrona)
 * @param {Function} o.spawn  child_process.spawn (ou dublê)
 * @param {Function} [o.agora] () => ms
 * @param {object} o.dirs     { planos, dados, home }
 *   planos:    pasta dos planos .md e dos registros <plano>.registro.json (ao lado, como o marcar.mjs)
 *   dados:     pasta de papeis.json, score-pesos.json, score.jsonl, score-fontes.json, escala-*.json(l)
 *   home:      expande o "~" do repo dos itens
 */
export function criarRotasPlanos({ mod = {}, fs, spawn, spawnPty, agora = () => Date.now(), dirs, marcador, raizes = ['~/Projects'], terminal = 'konsole', argvTerminal }) {
  // terminal que abre já dentro da sessão (claude attach <nome>); o server.mjs passa o do sistema (plataforma.mjs → comandoTerminal)
  const terminalDe = argvTerminal ?? ((nome) => ({ cmd: terminal, args: ['-e', 'claude', 'attach', nome] }));
  const precisa = (nome) => { if (!mod[nome]) throw new Falta(nome); return mod[nome]; };
  const dado = (n) => path.join(dirs.dados, n);
  // registro.mjs e papeis.mjs usam a API de promessas do fs (await fs.readFile)
  const fsp = fs.promises ?? fs;
  // "~/x" (ou "~\\x" no Windows) → <home>/x com o separador do sistema
  const expandir = (repo) => (typeof repo === 'string' && /^~([\\/]|$)/.test(repo) ? path.join(dirs.home, repo.slice(2)) : repo);

  // ---------- leitura ----------
  function lerJsonOuNada(arq) {
    try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; }
  }
  function lerJsonl(arq, n = 400) {
    let txt = ''; try { txt = fs.readFileSync(arq, 'utf8'); } catch { return []; }
    const out = [];
    for (const l of txt.split('\n').filter(Boolean).slice(-n)) { try { out.push(JSON.parse(l)); } catch {} }
    return out;
  }
  function gravarJsonAtomico(arq, obj) {
    fs.mkdirSync(path.dirname(arq), { recursive: true });
    const tmp = path.join(path.dirname(arq), `.${path.basename(arq)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, arq);
  }
  function arquivoValido(arquivo) {
    if (typeof arquivo !== 'string' || !ARQ_PLANO.test(arquivo)) return null;
    const abs = path.join(dirs.planos, arquivo);
    try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
    return abs;
  }
  // mesmo lugar que o marcar.mjs usa: ao lado do plano, <plano>.registro.json
  const caminhoRegistro = (arquivo) => path.join(dirs.planos, arquivo.replace(/\.md$/, '.registro.json'));

  async function papeisAtuais() {
    const P = precisa('papeis');
    try { return (await P.lerPapeis(dado('papeis.json'), { fs: fsp })) ?? P.PADRAO; } catch { return P.PADRAO; }
  }
  async function carregar(arquivo) {
    const abs = arquivoValido(arquivo);
    if (!abs) return { falha: erro(404, 'plano não encontrado') };
    const P = precisa('plano'), R = precisa('registro');
    const plano = P.lerPlano(fs.readFileSync(abs, 'utf8'), { papeis: await papeisAtuais() });
    const regArq = caminhoRegistro(arquivo);
    const reg = await R.ler(regArq, { fs: fsp });
    return { abs, plano, reg, regArq };
  }
  async function errosDo(plano) {
    const papeis = await papeisAtuais();
    const repoExiste = (repo) => { try { return fs.statSync(expandir(repo)).isDirectory(); } catch { return false; } };
    return [...comoLista(plano.erros), ...comoLista(precisa('plano').conferir(plano, { papeis, repoExiste }))];
  }

  async function listarPlanos() {
    let nomes = [];
    try { nomes = fs.readdirSync(dirs.planos).filter((f) => ARQ_PLANO.test(f)).sort().reverse(); } catch {}
    const R = precisa('registro');
    const out = [];
    for (const arquivo of nomes.slice(0, 100)) {
      try {
        const { plano, reg } = await carregar(arquivo);
        out.push({ arquivo, titulo: plano.titulo || arquivo, estado: reg?.estado || 'proposto', progresso: R.progresso(plano, reg) });
      } catch (e) {
        if (e instanceof Falta) throw e;
        out.push({ arquivo, titulo: arquivo, estado: 'erro', progresso: { concluidos: 0, total: 0, pct: 0 }, erro: e.message });
      }
    }
    return out;
  }

  async function verPlano(arquivo) {
    const c = await carregar(arquivo);
    if (c.falha) return c.falha;
    const R = precisa('registro');
    return ok({
      arquivo,
      plano: c.plano,
      registro: c.reg,
      estados: R.estadoDosItens(c.plano, c.reg, { agora: agora() }),
      progresso: R.progresso(c.plano, c.reg),
      erros: await errosDo(c.plano),
      nuvem: await nuvemPorItem(c.plano),
    });
  }

  // Trava da nuvem: o claude --cloud só devolve código em repo com o app do Claude no GitHub.
  // Quem tem o app fica em central/nuvem-repos.json ({ "comApp": ["seu-usuario/*", "org/repo"] }); sem arquivo, nenhum repo.
  const NUVEM_PADRAO = { comApp: [] };
  async function repoGithub(repoAbs) {
    const r = await rodarCurto('git', ['-C', repoAbs, 'remote', 'get-url', 'origin'], repoAbs);
    if (r.codigo !== 0) return null;
    const m = r.saida.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  }
  async function nuvemPermitida(repoAbs) {
    const cfg = lerJsonOuNada(dado('nuvem-repos.json')) ?? NUVEM_PADRAO;
    const lista = Array.isArray(cfg.comApp) ? cfg.comApp : [];
    const gh = await repoGithub(repoAbs);
    if (!gh) return { ok: false, motivo: 'o repo não tem remote no GitHub' };
    const [dono] = gh.split('/');
    const ok = lista.some((x) => x === gh || x === `${dono}/*`);
    return ok ? { ok: true, repo: gh } : { ok: false, repo: gh, motivo: `${gh} não tem o app do Claude no GitHub; o dono instala em github.com/apps/claude (e entra em nuvem-repos.json)` };
  }
  async function nuvemPorItem(plano) {
    const out = {};
    const cache = new Map();
    for (const it of plano.itens || []) {
      const abs = expandir(it.repo);
      if (!cache.has(abs)) cache.set(abs, await nuvemPermitida(abs).catch(() => ({ ok: false, motivo: 'não consegui ler o remote' })));
      out[it.id] = cache.get(abs);
    }
    return out;
  }

  async function verPapeis() {
    const P = precisa('papeis');
    return ok({ papeis: await papeisAtuais(), listas: { modelos: P.MODELOS, esforcos: P.ESFORCOS, permissoes: P.PERMISSOES, ondes: P.ONDES } });
  }

  // score/escala: pesos editáveis (padrão do módulo se o arquivo não existe), fontes já coletadas pelos verificadores,
  // histórico .jsonl. Sem fonte nenhuma, toda dimensão sai "sem dado" — nunca nota inventada.
  function verScore() {
    const S = precisa('score');
    const pesos = lerJsonOuNada(dado('score-pesos.json')) ?? S.PESOS_PADRAO;
    const fontes = lerJsonOuNada(dado('score-fontes.json')) ?? {};
    const historico = lerJsonl(dado('score.jsonl'));
    return ok({ atual: S.calcular(fontes, pesos), pesos, tendencia: S.tendencia(historico), historico: historico.slice(-30) });
  }
  function verEscala() {
    const E = precisa('escala');
    const pesos = lerJsonOuNada(dado('escala-pesos.json')) ?? E.ESCALA_PADRAO;
    const fontes = lerJsonOuNada(dado('escala-fontes.json')) ?? {};
    const historico = lerJsonl(dado('escala.jsonl'));
    const tend = mod.score?.tendencia ? mod.score.tendencia(historico) : null;
    return ok({ atual: E.calcularEscala(fontes, pesos), pesos, tendencia: tend, historico: historico.slice(-30) });
  }

  // ---------- sessões: `claude agents --json`, cache de 5 s, uma execução por vez ----------
  let cacheSessoes = { em: 0, dado: null };
  let sessoesEmVoo = null;
  function verSessoes() {
    const L = precisa('lancar');
    if (cacheSessoes.dado && agora() - cacheSessoes.em < CACHE_SESSOES_MS) return Promise.resolve(cacheSessoes.dado);
    if (sessoesEmVoo) return sessoesEmVoo;
    sessoesEmVoo = (async () => {
      try {
        const lista = await L.sessoes({ spawn });
        cacheSessoes = { em: agora(), dado: { em: agora(), sessoes: Array.isArray(lista) ? lista : [] } };
      } catch (e) {
        // falha não fica em cache: a próxima leitura tenta de novo
        return { em: agora(), sessoes: cacheSessoes.dado?.sessoes ?? [], erro: `claude agents falhou: ${e.message}` };
      } finally { sessoesEmVoo = null; }
      return cacheSessoes.dado;
    })();
    return sessoesEmVoo;
  }
  const esquecerSessoes = () => { cacheSessoes = { em: 0, dado: null }; };

  // ---------- disparo ----------
  // roda um comando de leitura (git) e devolve { codigo, saida }
  function rodarCurto(cmd, args, cwd) {
    return new Promise((fim) => {
      let saida = '';
      let p;
      try { p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return fim({ codigo: -1, saida: e.message }); }
      p.stdout?.on('data', (d) => { saida += d; });
      p.stderr?.on('data', (d) => { saida += d; });
      p.on('error', (e) => fim({ codigo: -1, saida: e.message }));
      p.on('close', (codigo) => fim({ codigo, saida: saida.trim() }));
    });
  }
  // Nuvem roda na branch atual, que precisa estar limpa e com push (docs/arquitetura.md).
  async function conferirPush(repo) {
    const st = await rodarCurto('git', ['-C', repo, 'status', '--porcelain'], repo);
    if (st.codigo !== 0) return `git status falhou: ${st.saida.slice(0, 200)}`;
    if (st.saida) return 'a branch tem mudanças sem commit';
    const up = await rodarCurto('git', ['-C', repo, 'rev-parse', '--abbrev-ref', '@{u}'], repo);
    if (up.codigo !== 0) return 'a branch não tem push (sem upstream)';
    const atras = await rodarCurto('git', ['-C', repo, 'rev-list', '--count', '@{u}..HEAD'], repo);
    if (atras.codigo === 0 && Number(atras.saida) > 0) return `a branch tem ${atras.saida} commit(s) sem push`;
    return null;
  }

  const emAprovacao = new Set();
  async function aprovarPlano(corpo) {
    const arquivo = corpo?.arquivo;
    const escolhas = corpo?.onde ?? {};
    if (typeof escolhas !== 'object' || Array.isArray(escolhas)) return erro(400, 'onde precisa ser um objeto { id: local|nuvem|projects }');
    if (emAprovacao.has(arquivo)) return erro(409, 'esse plano já está sendo aprovado');
    emAprovacao.add(arquivo);
    try { return await aprovarTravado(arquivo, escolhas); } finally { emAprovacao.delete(arquivo); }
  }
  async function aprovarTravado(arquivo, escolhas) {
    const c = await carregar(arquivo);
    if (c.falha) return c.falha;
    const P = precisa('papeis'), R = precisa('registro'), L = precisa('lancar');
    const { plano, regArq } = c;
    let reg = c.reg;
    if (reg?.estado === 'descartado' || reg?.estado === 'encerrado') return erro(409, `plano está ${reg.estado}`);
    const erros = await errosDo(plano);
    if (erros.length) return erro(409, 'o plano tem erros; corrija antes de aprovar', { erros });

    const ids = new Set((plano.itens || []).map((i) => i.id));
    const ondes = new Set(P.ONDES);
    for (const [id, v] of Object.entries(escolhas)) {
      if (!ID_ITEM.test(id) || !ids.has(id)) return erro(400, `item desconhecido: ${String(id).slice(0, 20)}`);
      if (!ondes.has(v)) return erro(400, `onde inválido para ${id}: ${String(v).slice(0, 20)}`);
    }

    {
      const papeis = await papeisAtuais();
      const t = agora();
      reg = { ...reg, plano: reg?.plano ?? arquivo, estado: 'aprovado', aprovadoEm: reg?.aprovadoEm ?? t, itens: { ...(reg?.itens || {}) } };
      // a escolha do card vale sobre o padrão do item/papel
      const ondeDe = (item) => escolhas[item.id] ?? reg.itens[item.id]?.onde ?? item.onde ?? papeis?.[item.papel]?.onde ?? 'local';
      for (const item of plano.itens || []) reg.itens[item.id] = { ...(reg.itens[item.id] || {}), onde: ondeDe(item) };

      const estados = R.estadoDosItens(plano, reg, { agora: t });
      const prontos = (plano.itens || []).filter((i) => estados[i.id] === 'pronto');
      const disparados = [];
      const paraProjects = [];
      for (const item0 of prontos) {
        const onde = reg.itens[item0.id].onde;
        const item = { ...item0, onde };
        if (onde === 'projects') { paraProjects.push(item); continue; }
        const repo = expandir(item.repo);
        try {
          if (onde === 'nuvem') {
            const app = await nuvemPermitida(repo);
            if (!app.ok) {
              reg = R.marcar(reg, item.id, 'falhou', { onde, motivo: app.motivo }, { agora: agora() });
              disparados.push({ id: item.id, onde, ok: false, motivo: app.motivo });
              continue;
            }
            const motivo = await conferirPush(repo);
            if (motivo) {
              reg = R.marcar(reg, item.id, 'falhou', { onde, motivo }, { agora: agora() });
              disparados.push({ id: item.id, onde, ok: false, motivo });
              continue;
            }
          }
          const opcoes = { planoArquivo: c.abs, ...(marcador ? { marcador } : {}), home: dirs.home, raizes };
          const argv = onde === 'nuvem' ? L.argvNuvem(item, opcoes) : L.argvLocal(item, papeis?.[item.papel], opcoes);
          const iNome = argv.indexOf('--name');
          const nome = iNome >= 0 ? argv[iNome + 1] : null;
          const r = await L.lancar(argv, { spawn, spawnPty, cwd: repo, home: dirs.home, raizes });
          if (r?.ok) {
            reg = R.marcar(reg, item.id, 'disparou', { onde, sessao: r.id ?? null, nome, url: r.url ?? null }, { agora: agora() });
            disparados.push({ id: item.id, onde, ok: true, sessao: r.id ?? null, nome, url: r.url ?? null });
          } else {
            const motivo = r?.motivo || r?.saida || 'lançamento falhou';
            reg = R.marcar(reg, item.id, 'falhou', { onde, motivo: String(motivo).slice(0, 500) }, { agora: agora() });
            disparados.push({ id: item.id, onde, ok: false, motivo: String(motivo).slice(0, 500) });
          }
        } catch (e) {
          reg = R.marcar(reg, item.id, 'falhou', { onde, motivo: e.message }, { agora: agora() });
          disparados.push({ id: item.id, onde, ok: false, motivo: e.message });
        }
      }
      let projectsTexto;
      if (paraProjects.length) {
        projectsTexto = L.textoProjects(plano, paraProjects);
        for (const item of paraProjects) {
          reg = R.marcar(reg, item.id, 'entregou-projects', { onde: 'projects' }, { agora: agora() });
          disparados.push({ id: item.id, onde: 'projects', ok: true });
        }
      }
      await R.gravar(regArq, reg, { fs: fsp });
      esquecerSessoes();
      return ok(projectsTexto === undefined ? { disparados } : { disparados, projectsTexto });
    }
  }

  async function descartarPlano(corpo) {
    const c = await carregar(corpo?.arquivo);
    if (c.falha) return c.falha;
    const est = c.reg?.estado || 'proposto';
    if (est !== 'proposto') return erro(409, `só descarto plano proposto; este está ${est}`);
    const reg = { ...c.reg, plano: c.reg?.plano ?? corpo.arquivo, estado: 'descartado' };
    await precisa('registro').gravar(c.regArq, reg, { fs: fsp });
    return ok({ ok: true, estado: 'descartado' });
  }

  async function pararSessao(corpo) {
    const id = corpo?.id;
    if (typeof id !== 'string' || !ID_SESSAO.test(id)) return erro(400, 'id de sessão inválido');
    const L = precisa('lancar');
    const r = await L.lancar(L.argvParar(id), { spawn });
    esquecerSessoes();
    return r?.ok ? ok({ ok: true, id }) : erro(502, `claude stop falhou: ${String(r?.motivo || r?.saida || '').slice(0, 300)}`);
  }

  // claude rm: tira a sessão da lista; a conversa fica guardada e pode ser retomada (claude --resume)
  async function removerSessao(corpo) {
    const id = corpo?.id;
    if (typeof id !== 'string' || !ID_SESSAO.test(id)) return erro(400, 'id de sessão inválido');
    const r = await rodarCurto('claude', ['rm', id], dirs.home);
    esquecerSessoes();
    return r.codigo === 0 ? ok({ ok: true, id }) : erro(502, `claude rm falhou: ${r.saida.slice(0, 300)}`);
  }
  // abre um terminal (konsole) já dentro da sessão: claude attach <nome>, sem shell
  const RE_NOME_SESSAO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
  async function abrirTerminal(corpo) {
    const nome = corpo?.nome;
    if (typeof nome !== 'string' || !RE_NOME_SESSAO.test(nome)) return erro(400, 'nome de sessão inválido');
    try {
      const { cmd, args } = terminalDe(nome);
      const filho = spawn(cmd, args, { cwd: dirs.home, detached: true, stdio: 'ignore' });
      filho.on?.('error', () => {});
      filho.unref?.();
    } catch (e) { return erro(502, `não abri o terminal: ${e.message}`); }
    return ok({ ok: true, nome });
  }

  // Item que falhou (pasta não confiável, claude fora do ar…): reabre e dispara já, se as dependências deixarem.
  async function tentarDeNovo(corpo) {
    const arquivo = corpo?.arquivo, id = corpo?.id;
    if (typeof id !== 'string' || !ID_ITEM.test(id)) return erro(400, 'id de item inválido');
    if (emAprovacao.has(arquivo)) return erro(409, 'o plano está sendo disparado agora; tente em seguida');
    const c = await carregar(arquivo);
    if (c.falha) return c.falha;
    const R = precisa('registro');
    let reg;
    try { reg = R.marcar(c.reg, id, 'reabriu', {}, { agora: agora() }); } catch (e) { return erro(409, e.message); }
    await R.gravar(c.regArq, reg, { fs: fsp });
    const r = await aprovarPlano({ arquivo, onde: {} });
    const disparado = r.code === 200 ? (r.corpo.disparados || []).find((d) => d.id === id) : null;
    return ok({ ok: true, id, disparado: disparado ?? null, aviso: disparado ? null : 'reaberto; dispara quando as dependências concluírem' });
  }

  async function mensagemSessao(corpo) {
    const id = corpo?.id, texto = corpo?.texto;
    if (typeof id !== 'string' || !ID_SESSAO.test(id)) return erro(400, 'id de sessão inválido');
    if (typeof texto !== 'string' || !texto.trim()) return erro(400, 'texto vazio');
    if (texto.length > 2000 || texto.includes('\0')) return erro(400, 'texto passa de 2000 caracteres');
    const L = precisa('lancar');
    const r = await L.lancar(L.argvMensagemNuvem(id, texto), { spawn });
    return r?.ok ? ok({ ok: true, id }) : erro(502, `mensagem não chegou: ${String(r?.motivo || r?.saida || '').slice(0, 300)}`);
  }

  async function concluirProjects(corpo) {
    const id = corpo?.id;
    if (typeof id !== 'string' || !ID_ITEM.test(id)) return erro(400, 'id de item inválido');
    const c = await carregar(corpo?.arquivo);
    if (c.falha) return c.falha;
    const R = precisa('registro');
    if (!(c.plano.itens || []).some((i) => i.id === id)) return erro(404, 'item não existe no plano');
    const est = R.estadoDosItens(c.plano, c.reg, { agora: agora() })[id];
    if (est !== 'entregue-projects') return erro(409, `item está ${est}, só concluo item entregue ao Projects`);
    const reg = R.marcar(c.reg, id, 'concluiu', {}, { agora: agora() });
    await R.gravar(c.regArq, reg, { fs: fsp });
    return ok({ ok: true, id, progresso: R.progresso(c.plano, reg) });
  }

  async function salvarPapeis(corpo) {
    const P = precisa('papeis');
    const papeis = corpo?.papeis;
    const erros = comoLista(P.validarPapeis(papeis));
    if (erros.length) return erro(400, erros[0], { erros });
    await P.gravarPapeis(dado('papeis.json'), papeis, { fs: fsp });
    return ok({ ok: true });
  }

  async function salvarPesos(corpo) {
    const tipo = corpo?.tipo ?? 'score';
    if (tipo !== 'score' && tipo !== 'escala') return erro(400, 'tipo precisa ser score ou escala');
    const pesos = corpo?.pesos;
    if (!pesos || typeof pesos !== 'object' || Array.isArray(pesos)) return erro(400, 'pesos precisa ser um objeto');
    const erros = tipo === 'score' ? comoLista(precisa('score').validarPesos(pesos)) : comoLista(precisa('escala').validarEscala(pesos));
    if (erros.length) return erro(400, erros[0], { erros });
    gravarJsonAtomico(dado(tipo === 'score' ? 'score-pesos.json' : 'escala-pesos.json'), pesos);
    return ok({ ok: true, tipo });
  }

  // ---------- roteamento ----------
  const embrulha = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) {
      if (e instanceof Falta) return erro(503, e.message);
      return erro(500, e.message);
    }
  };

  /** GET: devolve { code, corpo } ou null se a rota não é deste módulo. */
  const get = embrulha(async (p, params) => {
    if (p === '/api/planos') return ok(await listarPlanos());
    if (p === '/api/plano') return verPlano(params.get('arquivo'));
    if (p === '/api/papeis') return verPapeis();
    if (p === '/api/score') return verScore();
    if (p === '/api/escala') return verEscala();
    if (p === '/api/sessoes') return ok(await verSessoes());
    if (p === '/api/lideres') return ok(await verLideres());
    if (p === '/api/sugestoes') return ok(verSugestoes());
    return null;
  });
  const temGet = (p) => ['/api/planos', '/api/plano', '/api/papeis', '/api/score', '/api/escala', '/api/sessoes', '/api/lideres', '/api/sugestoes'].includes(p);

  const POSTS = {
    'aprovar-plano': aprovarPlano,
    'descartar-plano': descartarPlano,
    'parar-sessao': pararSessao,
    'mensagem-sessao': mensagemSessao,
    'concluir-projects': concluirProjects,
    'salvar-papeis': salvarPapeis,
    'salvar-pesos': salvarPesos,
    'remover-sessao': removerSessao,
    'abrir-terminal': abrirTerminal,
    'tentar-de-novo': tentarDeNovo,
  };
  const post = embrulha(async (id, corpo) => POSTS[id](corpo));
  const temAcao = (id) => ACOES.has(id);

  // Líderes de área: o diário de cada um (Etapa, Atualizado, Fazendo) + a sessão lider-<area>, se viva.
  // As áreas são as que você criou: um diário em <lideres>/<area>.md ou um agente ~/.claude/agents/lider-<area>.md
  // (o lider-exemplo.md do repo não conta). Sem nenhum, a lista sai vazia.
  const RE_AREA = /^[a-z0-9][a-z0-9-]{0,40}$/;
  function areasConhecidas(pasta) {
    const achadas = new Set();
    try { for (const f of fs.readdirSync(pasta)) { const m = f.match(/^(.+)\.md$/); if (m && RE_AREA.test(m[1])) achadas.add(m[1]); } } catch {}
    try { for (const f of fs.readdirSync(path.join(dirs.home, '.claude', 'agents'))) { const m = f.match(/^lider-(.+)\.md$/); if (m && RE_AREA.test(m[1]) && m[1] !== 'exemplo') achadas.add(m[1]); } } catch {}
    return [...achadas].sort();
  }
  async function verLideres() {
    const pasta = dirs.lideres ?? path.join(dirs.home, '.claude', 'agentic-os', 'lideres');
    let sessoes = [];
    try { sessoes = (await verSessoes()).sessoes || []; } catch {}
    return areasConhecidas(pasta).map((area) => {
      let texto = null;
      try { texto = fs.readFileSync(path.join(pasta, `${area}.md`), 'utf8'); } catch {}
      const campo = (nome) => texto?.match(new RegExp(`\\*\\*${nome}:\\*\\*\\s*(.+)`))?.[1]?.trim() ?? null;
      const s = sessoes.find((x) => x.nome === `lider-${area}`);
      return {
        area,
        temDiario: texto !== null,
        etapa: campo('Etapa'),
        atualizado: campo('Atualizado'),
        // "Fazendo" é texto livre (ids do seu tracker, se usar um), separado por vírgula
        fazendo: (campo('Fazendo') || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12),
        sessao: s ? { nome: s.nome, status: s.status, esperando: !!s.esperando } : null,
      };
    });
  }

  // Sugestões dos verificadores: cada relatório traz um bloco json em "## Tarefas sugeridas".
  // A Central só MOSTRA as sugestões. Ponto de extensão: se você usa um tracker (GitHub Issues, Linear, Jira…),
  // ligue-o aqui — uma ação POST nova que recebe { verificador, arquivo, indice }, relê a sugestão com
  // lerSugestoesDe() e cria o item no seu tracker por argv fixo (nunca shell com texto do relatório).
  const pastaVerif = () => dirs.verificadores ?? path.join(dirs.home, '.claude', 'agentic-os', 'verificadores');
  function lerSugestoesDe(verificador, arquivo) {
    let texto;
    try { texto = fs.readFileSync(path.join(pastaVerif(), verificador, arquivo), 'utf8'); } catch { return []; }
    const m = texto.match(/##\s*Tarefas sugeridas[\s\S]*?```json\s*([\s\S]*?)```/i);
    if (!m) return [];
    try { const l = JSON.parse(m[1]); return Array.isArray(l) ? l.filter((x) => x && typeof x.titulo === 'string' && x.titulo.trim() && x.titulo.trim() !== '...') : []; } catch { return []; }
  }
  function verSugestoes() {
    let verifs = [];
    try { verifs = fs.readdirSync(pastaVerif()).filter((d) => /^[a-z-]+$/.test(d)); } catch { return []; }
    const out = [];
    for (const v of verifs) {
      let arqs = [];
      try { arqs = fs.readdirSync(path.join(pastaVerif(), v)).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)).sort(); } catch {}
      const ultimo = arqs.at(-1);
      if (!ultimo) continue;
      lerSugestoesDe(v, ultimo).forEach((s, indice) => {
        out.push({ verificador: v, arquivo: ultimo, indice, titulo: s.titulo, tipo: s.tipo ?? null, area: s.area ?? null, severidade: s.severidade ?? null, resumo: s.resumo ?? null, recurso: s.recurso ?? null });
      });
    }
    return out.sort((a, b) => (a.severidade ?? 9) - (b.severidade ?? 9));
  }
  // Disparo automático: item que destrava quando a dependência conclui
  // é disparado sozinho, mas só dentro de um plano JÁ APROVADO por um humano. Reaprovar não
  // redispara o que já foi disparado; aqui só se chama quando há item pronto.
  async function tick() {
    const R = mod.registro, P = mod.plano;
    if (!R || !P || !mod.lancar) return [];
    let nomes = [];
    try { nomes = fs.readdirSync(dirs.planos).filter((f) => ARQ_PLANO.test(f)); } catch { return []; }
    const feitos = [];
    for (const arquivo of nomes) {
      if (emAprovacao.has(arquivo)) continue;
      try {
        const c = await carregar(arquivo);
        if (c.falha || c.reg?.estado !== 'aprovado') continue;
        const estados = R.estadoDosItens(c.plano, c.reg, { agora: agora() });
        if (!Object.values(estados).includes('pronto')) continue;
        const r = await aprovarPlano({ arquivo, onde: {} });
        if (r.code === 200 && r.corpo?.disparados?.length) feitos.push({ arquivo, disparados: r.corpo.disparados });
      } catch { /* um plano com problema não para os outros */ }
    }
    if (feitos.length) esquecerSessoes();
    return feitos;
  }

  return { get, temGet, post, temAcao, tick };
}
