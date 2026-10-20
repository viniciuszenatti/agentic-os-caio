// Servidor de mentira para ver a Central sem a máquina real.
// Serve central/index.html e as fontes, e responde as rotas do contrato C5 (docs/arquitetura.md)
// com dados falsos, mais as rotas antigas que a página já chama, com respostas mínimas.
//
// Uso:  node central/dev/fake-api.mjs [porta]      (padrão 4790; nunca use 4747/4748)
// Nos testes: import { criarFakeApi } from '../central/dev/fake-api.mjs'
//
// Só para desenvolvimento: guarda o estado em memória, não lê nem grava nada fora de central/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CENTRAL = path.resolve(AQUI, '..');

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};

// ---------- dados falsos no formato dos contratos ----------
const MODELOS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSOES = ['default', 'acceptEdits', 'plan'];
const ONDES = ['local', 'nuvem', 'projects'];

const PAPEIS = {
  orquestrador: { modelo: 'claude-opus-5-5', esforco: 'medium', onde: 'local', permissao: 'plan' },
  lider: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'default' },
  executor: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'acceptEdits' },
  verificador: { modelo: 'claude-sonnet-5-5', esforco: 'low', onde: 'nuvem', permissao: 'default' },
  rapido: { modelo: 'claude-haiku-5-5', esforco: 'low', onde: 'local', permissao: 'default' },
};

const item = (id, titulo, extra = {}) => ({
  id, titulo, prompt: `Prompt do item ${id}: ${titulo}.`, repo: '~/Projects/meu-app', papel: 'executor', area: 'web',
  onde: 'local', modelo: null, esforco: null, permissao: null, depende: [], conflita: [], porta: null, custo: null, exclusivo: null, ...extra,
});

function planosIniciais() {
  return {
    '2026-10-20-central-fases.md': {
      estado: 'aprovado',
      plano: {
        titulo: 'Central de Agentes: fases 1 a 5',
        itens: [
          item('N1', 'Parser e registro de planos', { area: 'central' }),
          item('N2', 'Lançadores local e nuvem', { area: 'central', onde: 'nuvem' }),
          item('N3', 'Papéis e score', { area: 'central', modelo: 'claude-haiku-5-5' }),
          item('N4', 'Rotas novas do servidor', { area: 'central', depende: ['N1', 'N2'] }),
          item('N5', 'Interface da Central', { area: 'design', papel: 'lider', depende: ['N4'] }),
          item('N6', 'Agentes e rotinas', { area: 'ia', onde: 'projects' }),
        ],
      },
      estados: { N1: 'concluido', N2: 'iniciado', N3: 'iniciado', N4: 'bloqueado', N5: 'bloqueado', N6: 'entregue-projects' },
      registro: {
        N1: { onde: 'local', sessao: 'a1b2c3', nome: '2026-10-20-central-fases-N1' },
        N2: { onde: 'nuvem', sessao: 'cse_01ABCD', url: 'https://claude.ai/code/session_01ABCD' },
        N3: { onde: 'local', sessao: 'd4e5f6', nome: '2026-10-20-central-fases-N3' },
        N6: { onde: 'projects' },
      },
    },
    '2026-10-20-login-app.md': {
      estado: 'proposto',
      plano: {
        titulo: 'Corrigir o login do app',
        itens: [
          item('P1', 'Reproduzir o erro de login no celular', { repo: '~/Projects/meu-app-mobile', area: 'app', papel: 'rapido' }),
          item('P2', 'Corrigir o redirect_uri no provedor de login do DEV', { repo: '~/Projects/minha-infra', area: 'infra', depende: ['P1'], porta: 'mexe no login do DEV' }),
          item('P3', 'Teste do fluxo de login', { repo: '~/Projects/meu-app-mobile', area: 'app', depende: ['P2'], onde: 'nuvem' }),
          item('P4', 'Revisar a tela de login', { area: 'design', papel: 'lider', modelo: 'claude-opus-5-5', esforco: 'high' }),
        ],
      },
      estados: { P1: 'pronto', P2: 'bloqueado', P3: 'bloqueado', P4: 'pronto' },
      registro: {},
    },
  };
}

const SESSOES = [
  { id: 'a1b2c3', nome: '2026-10-20-central-fases-N1', cwd: '/home/voce/Projects/meu-app', status: 'idle', esperando: false },
  { id: 'd4e5f6', nome: '2026-10-20-central-fases-N3', cwd: '/home/voce/Projects/meu-app', status: 'waiting', esperando: 'permissão para rodar npm test' },
  { id: 'f0f0f0', nome: 'orquestrador', cwd: '/home/voce/Projects', status: 'idle', esperando: false },
];

const PESOS = {
  seguranca: 20, bugs: 20, velocidade: 15, apis: 15, testes: 15, fluxo: 10, ambientes: 5,
  alvos: { lighthouse: 90, apiMs: 800, diasParado: 7 },
};
const DIMENSOES = [
  { chave: 'seguranca', nome: 'Segurança', nota: 62, motivo: '1 achado alto e 4 médios abertos', tendencia: 'sobe' },
  { chave: 'bugs', nome: 'Bugs e interface', nota: 55, motivo: '2 bugs urgentes no tracker', tendencia: 'desce' },
  { chave: 'velocidade', nome: 'Velocidade das páginas', nota: 81, motivo: 'média do Lighthouse 81 (alvo 90)', tendencia: 'igual' },
  { chave: 'apis', nome: 'Desempenho das APIs', nota: 70, motivo: '7 de 10 processos abaixo de 800 ms', tendencia: 'sobe' },
  { chave: 'testes', nome: 'Testes', nota: 95, motivo: '19 de 20 suítes verdes', tendencia: 'igual' },
  { chave: 'fluxo', nome: 'Fluxo de trabalho', nota: 80, motivo: '2 itens em andamento parados há +7 dias', tendencia: 'desce' },
  { chave: 'ambientes', nome: 'Ambientes', nota: null, motivo: 'sem dado: saude.json ainda não existe', tendencia: null },
];

const ESCALA_PESOS = { carga: 35, dados: 25, 'estado-infra': 20, 'custo-unidade': 10, manutencao: 10 };
const ESCALA = {
  geral: 58,
  tendencia: 'sobe',
  eixos: [
    { chave: 'carga', nome: 'Carga', nota: 70, peso: 35, motivo: 'p95 abaixo de 800 ms até 5×; falha no 10×' },
    { chave: 'dados', nome: 'Dados', nota: 52, peso: 25, motivo: '3 consultas sem LIMIT em tabela que cresce, 1 N+1' },
    { chave: 'estado-infra', nome: 'Estado e infra', nota: 55, peso: 20, motivo: '1 serviço não replica, 6 estados em memória' },
    { chave: 'custo-unidade', nome: 'Custo por unidade', nota: null, peso: 10, motivo: 'sem dado: contagem de chamadas pagas ainda não rodou' },
    { chave: 'manutencao', nome: 'Manutenção pelo time', nota: 85, peso: 10, motivo: '3 arquivos com mais de 800 linhas' },
  ],
  primeiroGargalo: {
    texto: 'Aguenta 5×; no 10× o envio de mensagem passa de 2 s porque a lista de conversas é lida inteira a cada envio.',
    arquivo: 'meu-app/src/app/api/conversas/route.ts',
    linha: 42,
  },
  historico: [{ em: '2026-10-13', geral: 51 }, { em: '2026-10-16', geral: 54 }, { em: '2026-10-20', geral: 58 }],
};

// ---------- utilidades ----------
function json(res, code, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(corpo);
}

function servirArquivo(res, raiz, rel) {
  const alvo = path.resolve(raiz, rel);
  if (!alvo.startsWith(raiz + path.sep)) return json(res, 403, { erro: 'caminho fora da pasta' });
  fs.readFile(alvo, (erro, dado) => {
    if (erro) return json(res, 404, { erro: 'não achei' });
    res.writeHead(200, { 'content-type': TIPOS[path.extname(alvo)] || 'application/octet-stream' });
    res.end(dado);
  });
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) { req.destroy(); falha(new Error('corpo grande demais')); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { falha(new Error('JSON inválido')); } });
    req.on('error', falha);
  });
}

function progressoDe(p) {
  const total = p.plano.itens.length;
  const concluidos = p.plano.itens.filter((i) => ['concluido'].includes(p.estados[i.id])).length;
  return { concluidos, total, pct: total ? Math.round((100 * concluidos) / total) : 0 };
}

const somaPesos = (obj) => Object.values(obj || {}).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0);

// ---------- servidor ----------
export function criarFakeApi({ token = 'token-de-teste' } = {}) {
  const PLANOS = planosIniciais();
  let papeis = structuredClone(PAPEIS);
  let pesos = structuredClone(PESOS);
  const log = []; // ações recebidas (útil para teste)

  const acoes = {
    'aprovar-plano'(c) {
      const p = PLANOS[c.arquivo];
      if (!p) return [404, { erro: 'plano não existe' }];
      if (p.estado !== 'proposto') return [409, { erro: 'o plano não está proposto' }];
      const onde = c.onde && typeof c.onde === 'object' ? c.onde : {};
      for (const [id, o] of Object.entries(onde)) if (!ONDES.includes(o)) return [400, { erro: `onde inválido em ${id}` }];
      p.estado = 'aprovado';
      const disparados = [];
      const projects = [];
      for (const it of p.plano.itens) {
        if (onde[it.id]) it.onde = onde[it.id];
        if (p.estados[it.id] !== 'pronto') continue;
        if (it.onde === 'projects') { p.estados[it.id] = 'entregue-projects'; projects.push(it); continue; }
        p.estados[it.id] = 'disparado';
        p.registro[it.id] = { onde: it.onde, sessao: `fake-${it.id}`, nome: `${c.arquivo.replace(/\.md$/, '')}-${it.id}` };
        disparados.push(it.id);
      }
      const r = { disparados };
      if (projects.length) r.projectsTexto = `Objetivo: ${p.plano.titulo}\n\n${projects.map((i) => `## ${i.id} · ${i.titulo}\nRepo: ${i.repo}\n${i.prompt}`).join('\n\n')}`;
      return [200, r];
    },
    'descartar-plano'(c) {
      const p = PLANOS[c.arquivo];
      if (!p) return [404, { erro: 'plano não existe' }];
      p.estado = 'descartado';
      return [200, { ok: true }];
    },
    'parar-sessao'(c) { return /^[\w-]+$/.test(c.id || '') ? [200, { ok: true }] : [400, { erro: 'id inválido' }]; },
    'mensagem-sessao'(c) {
      if (!/^[\w-]+$/.test(c.id || '')) return [400, { erro: 'id inválido' }];
      if (typeof c.texto !== 'string' || !c.texto.trim()) return [400, { erro: 'mensagem vazia' }];
      return [200, { ok: true }];
    },
    'concluir-projects'(c) {
      const p = PLANOS[c.arquivo];
      if (!p || !p.estados[c.id]) return [404, { erro: 'item não existe' }];
      p.estados[c.id] = 'concluido';
      return [200, { ok: true }];
    },
    'salvar-papeis'(c) {
      const obj = c.papeis;
      if (!obj || typeof obj !== 'object') return [400, { erro: 'papeis ausente' }];
      for (const [nome, v] of Object.entries(obj)) {
        if (!MODELOS.includes(v.modelo) || !ESFORCOS.includes(v.esforco) || !ONDES.includes(v.onde) || !PERMISSOES.includes(v.permissao)) {
          return [400, { erro: `valor inválido no papel ${nome}` }];
        }
      }
      papeis = obj;
      return [200, { ok: true }];
    },
    'salvar-pesos'(c) {
      if (!c.pesos || typeof c.pesos !== 'object') return [400, { erro: 'pesos ausente' }];
      if (somaPesos(c.pesos) !== 100) return [400, { erro: 'a soma dos pesos precisa dar 100' }];
      pesos = c.pesos;
      return [200, { ok: true }];
    },
    // rotas antigas
    'salvar-layout'() { return [200, { ok: true, em: Date.now() }]; },
  };

  function score() {
    const dims = DIMENSOES.map((d) => ({ ...d, peso: pesos[d.chave] ?? 0 }));
    const com = dims.filter((d) => d.nota != null);
    const soma = com.reduce((a, d) => a + d.peso, 0) || 1;
    const geral = Math.round(com.reduce((a, d) => a + d.nota * d.peso, 0) / soma);
    return { geral, tendencia: 'sobe', dimensoes: dims, pesos, historico: [{ em: '2026-10-18', geral: geral - 4 }, { em: '2026-10-19', geral: geral - 2 }, { em: '2026-10-20', geral }] };
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);

      if (req.method === 'POST') {
        if (req.headers['x-central-token'] !== token) return json(res, 403, { erro: 'token ausente ou errado' });
        const m = p.match(/^\/api\/acao\/([a-z-]+)$/);
        if (!m) return json(res, 404, { erro: 'ação desconhecida' });
        let corpo;
        try { corpo = await lerCorpo(req); } catch (e) { return json(res, 400, { erro: e.message }); }
        log.push({ acao: m[1], corpo });
        const fn = Object.hasOwn(acoes, m[1]) ? acoes[m[1]] : null;
        if (!fn) return json(res, 202, { execucao: `fake-${Date.now()}`, acao: m[1] });
        const [code, r] = fn(corpo);
        return json(res, code, r);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { erro: 'método não permitido' });

      if (p === '/' || p === '/index.html') {
        const html = fs.readFileSync(path.join(CENTRAL, 'index.html'), 'utf8')
          .replace('<meta name="central-token" content="">', `<meta name="central-token" content="${token}">`);
        res.writeHead(200, { 'content-type': TIPOS['.html'], 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (p.startsWith('/fonts/')) return servirArquivo(res, path.join(CENTRAL, 'fonts'), p.slice(7));

      // ---- contrato C5 ----
      if (p === '/api/planos') {
        return json(res, 200, Object.entries(PLANOS).map(([arquivo, x]) => ({ arquivo, titulo: x.plano.titulo, estado: x.estado, progresso: progressoDe(x) })));
      }
      if (p === '/api/plano') {
        const x = PLANOS[url.searchParams.get('arquivo') || ''];
        if (!x) return json(res, 404, { erro: 'plano não existe' });
        // `registro` é extra (não está no C5): a página funciona sem ele.
        return json(res, 200, { plano: x.plano, estados: x.estados, progresso: progressoDe(x), erros: [], estado: x.estado, registro: { itens: x.registro } });
      }
      if (p === '/api/papeis') return json(res, 200, { papeis, listas: { modelos: MODELOS, esforcos: ESFORCOS, permissoes: PERMISSOES, ondes: ONDES } });
      if (p === '/api/score') return json(res, 200, score());
      if (p === '/api/escala') return json(res, 200, { ...ESCALA, pesos: ESCALA_PESOS });
      if (p === '/api/sessoes') return json(res, 200, SESSOES);

      // ---- rotas antigas, respostas mínimas ----
      const antigas = {
        '/api/retrato': () => ({ em: Date.now(), sessoes: [], rotinas: [], saude: { itens: [] }, notas: null }),
        '/api/saude': () => ({ ausente: true }),
        '/api/contexto': () => ({ ausente: true }),
        '/api/limpeza': () => ({ ausente: true }),
        '/api/deck': () => ({ deck: [], limpeza: [] }),
        '/api/execucoes': () => ({ execucoes: [] }),
        '/api/nos': () => ({ total: 0, pontos: [] }),
        '/api/anel': () => ({ itens: [], base: null }),
        '/api/busca': () => ({ itens: [] }),
        '/api/hoje': () => ({ eventos: [] }),
        '/api/respostas': () => ({ itens: [] }),
        '/api/capacidade': () => ({ ausente: true }),
        '/api/modo-build': () => ({ ativo: false }),
        '/api/layout': () => ({}),
        '/api/revisao': () => ({ itens: [], pendentes: 0 }),
        '/api/noticias': () => ({ ausente: true }),
        '/api/fechamento': () => ({ ausente: true }),
        '/api/gemini': () => ({ existe: false }),
      };
      if (Object.hasOwn(antigas, p)) return json(res, 200, antigas[p]());
      if (p.startsWith('/api/estado/')) return json(res, 200, { ausente: true });
      return json(res, 404, { erro: 'não achei' });
    } catch (e) {
      return json(res, 500, { erro: e.message });
    }
  });
  servidor.log = log;
  return servidor;
}

// Rodando direto: sobe numa porta (padrão 4790).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const porta = Number(process.argv[2] || process.env.PORTA || 4790);
  if (porta === 4747 || porta === 4748) { console.error('As portas 4747 e 4748 são da Central real. Use outra.'); process.exit(1); }
  const token = process.env.CENTRAL_TOKEN || 'token-de-teste';
  criarFakeApi({ token }).listen(porta, '127.0.0.1', () => console.log(`fake-api em http://127.0.0.1:${porta} (token ${token})`));
}
