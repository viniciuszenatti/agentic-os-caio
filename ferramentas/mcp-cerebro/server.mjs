#!/usr/bin/env node
// MCP "cerebro" — busca no índice do segundo cérebro (stdio, JSON-RPC 2.0).
// Node puro, sem dependências. SOMENTE LEITURA.
// O índice é carregado só na 1ª chamada de ferramenta e recarregado quando
// o mtime do indice.json muda (checado a cada chamada; sem watcher).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
// Índice gerado pelo indexador da Central (~/.claude/agentic-os/cerebro/indexar.mjs).
const INDICE = process.env.CEREBRO_INDICE ||
  path.join(HOME, '.claude', 'agentic-os', 'cerebro', 'indice.json');
const VERSAO = '1.0.0';
const LER_MAX = 4096;

// Raízes de onde cerebro_arquivo pode ler conteúdo. Devem ser as mesmas do indexar.mjs.
// Sobrescreva com CEREBRO_RAIZES (caminhos separados por ":"). Nota pessoal fora daqui: CEREBRO_VAULT.
function raizesPadrao() {
  const r = [
    process.env.AGENTIC_OS_PROJETOS || path.join(HOME, 'Projects'),
    path.join(HOME, '.claude', 'skills'),
    path.join(HOME, '.claude', 'limpeza', 'relatorios'),
    path.join(HOME, '.claude', 'doc-de-sessao'),
    path.join(HOME, '.config', 'systemd', 'user'),
    path.join(HOME, '.claude', 'CLAUDE.md'),
  ];
  // memória de cada projeto: ~/.claude/projects/<pasta>/memory (só a memória, nunca os transcripts)
  const proj = path.join(HOME, '.claude', 'projects');
  try { for (const d of fs.readdirSync(proj)) r.push(path.join(proj, d, 'memory')); } catch {}
  if (process.env.CEREBRO_VAULT) r.push(process.env.CEREBRO_VAULT);
  return r;
}
const RAIZES = process.env.CEREBRO_RAIZES
  ? process.env.CEREBRO_RAIZES.split(':').filter(Boolean).map((p) => p.replace(/^~(?=\/|$)/, HOME))
  : raizesPadrao();
const SENSIVEL = /(secret|token|\.env|credential|senha|password|passwd|\.pem$|\.key$|id_rsa|\.config\/)/i;

// ---------- índice ----------
let idx = null;        // { itens, norm[], porCaminho: Map, entrada: Map<id, id[]>, gerado }
let idxMtime = 0;
let raizesReais = null;

const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function carregar() {
  let st;
  try { st = fs.statSync(INDICE); } catch { throw new Error(`índice não encontrado: ${INDICE}`); }
  if (idx && st.mtimeMs === idxMtime) return idx;
  const j = JSON.parse(fs.readFileSync(INDICE, 'utf8'));
  const itens = j.itens || [];
  const norm = new Array(itens.length);
  const porCaminho = new Map();
  const entrada = new Map();
  itens.forEach((it, i) => {
    norm[i] = { t: semAcento(it.t), p: semAcento(it.p), x: semAcento(it.x) };
    porCaminho.set(it.p, i);
    for (const alvo of it.l || []) {
      if (!entrada.has(alvo)) entrada.set(alvo, []);
      entrada.get(alvo).push(i);
    }
  });
  idx = { itens, norm, porCaminho, entrada, gerado: j.gerado };
  idxMtime = st.mtimeMs;
  return idx;
}

function reais() {
  if (raizesReais) return raizesReais;
  raizesReais = [];
  for (const r of RAIZES) {
    let real; try { real = fs.realpathSync(r); } catch { continue; }
    raizesReais.push({ orig: r, real });
  }
  return raizesReais;
}

const dentro = (p, raiz) => p === raiz || p.startsWith(raiz + path.sep);

// Resolve o caminho pedido: aceita absoluto, ~/..., ou só o nome do arquivo
// (se for único no índice). Devolve { real, item?, i? } ou lança erro.
function resolver(caminho) {
  const I = carregar();
  let c = String(caminho || '').trim();
  if (!c) throw new Error('caminho vazio');
  if (c.startsWith('~/')) c = path.join(HOME, c.slice(2));
  if (!path.isAbsolute(c)) {
    const base = semAcento(c);
    const hits = [];
    I.itens.forEach((it, i) => { if (semAcento(it.p).endsWith('/' + base) || semAcento(it.p).endsWith('/' + base + '.md')) hits.push(i); });
    if (hits.length === 1) c = I.itens[hits[0]].p;
    else if (hits.length > 1) throw new Error(`ambíguo (${hits.length}): ` + hits.slice(0, 5).map((i) => I.itens[i].p).join(' | '));
    else throw new Error('não está no índice; passe o caminho absoluto');
  }
  c = path.resolve(c);
  let i = I.porCaminho.get(c);
  let real;
  try { real = fs.realpathSync(c); } catch { real = null; }
  if (real) {
    // casa de volta com o índice por raiz (ex.: ~/Projects é link para /mnt/disco/Projects)
    if (i === undefined) {
      for (const r of reais()) {
        if (dentro(real, r.real)) { i = I.porCaminho.get(r.orig + real.slice(r.real.length)); break; }
      }
    }
  }
  return { pedido: c, real, i, item: i === undefined ? null : I.itens[i] };
}

// ---------- formatação compacta ----------
const data = (s) => new Date(s * 1000).toISOString().slice(0, 10);
const curto = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
function linha(it, extra = '') {
  return `- ${it.t} [${it.a}/${it.k}${it.j ? '/' + it.j : ''}] ${data(it.m)}${extra}\n  ${it.p}` +
    (it.x ? `\n  ${curto(it.x, 160)}` : '');
}

// ---------- ferramentas ----------
function buscar({ consulta, area, tipo, limite = 10 }) {
  const I = carregar();
  const termos = [...new Set(semAcento(consulta).split(/[^a-z0-9_.-]+/).filter((t) => t.length > 1))];
  if (!termos.length) throw new Error('consulta vazia');
  const lim = Math.max(1, Math.min(20, limite | 0 || 10));
  const agora = Date.now() / 1000;
  const inicioPalavra = termos.map((t) => new RegExp('(^|[^a-z0-9])' + t.replace(/[.]/g, '\\.')));
  const res = [];
  I.itens.forEach((it, i) => {
    if (area && it.a !== area) return;
    if (tipo && it.k !== tipo) return;
    const n = I.norm[i];
    let pont = 0, casou = 0;
    for (let k = 0; k < termos.length; k++) {
      const t = termos[k];
      let s = 0;
      if (n.t.includes(t)) s += 6 + (inicioPalavra[k].test(n.t) ? 2 : 0);
      if (n.p.includes(t)) s += 3;
      if (n.x.includes(t)) s += 1;
      if (s) { casou++; pont += s; }
    }
    if (!casou) return;
    if (casou === termos.length && termos.length > 1) pont *= 1.5;
    else pont *= casou / termos.length;
    const dias = Math.max(0, (agora - it.m) / 86400);
    pont += 3 * Math.exp(-dias / 30);
    res.push([pont, i]);
  });
  res.sort((a, b) => b[0] - a[0]);
  const top = res.slice(0, lim);
  if (!top.length) return `Nada para "${consulta}". Tente outros termos ou sem filtro.`;
  return `${res.length} resultado(s), mostrando ${top.length}:\n` +
    top.map(([p, i]) => linha(I.itens[i], ` · ${p.toFixed(1)}`)).join('\n');
}

function arquivo({ caminho }) {
  const r = resolver(caminho);
  const partes = [];
  if (r.item) {
    const it = r.item;
    partes.push(`${it.t}\n${it.p}\nárea=${it.a} tipo=${it.k}${it.j ? ' projeto=' + it.j : ''}${it.d ? ' pasta=' + it.d : ''} mtime=${data(it.m)} bytes=${it.s}` +
      (it.l ? ` links_saida=${it.l.length}` : '') + (idx.entrada.get(r.i) ? ` links_entrada=${idx.entrada.get(r.i).length}` : ''));
  } else {
    partes.push(`(fora do índice) ${r.pedido}`);
  }
  if (SENSIVEL.test(r.pedido) || (r.real && SENSIVEL.test(r.real))) return partes.concat('[conteúdo bloqueado: caminho sensível]').join('\n');
  if (!r.real) return partes.concat('[conteúdo: arquivo não existe]').join('\n');
  if (!reais().some((x) => dentro(r.real, x.real))) return partes.concat('[conteúdo bloqueado: fora das raízes do índice]').join('\n');
  let st; try { st = fs.statSync(r.real); } catch { st = null; }
  if (!st || !st.isFile()) return partes.concat('[conteúdo: não é arquivo]').join('\n');
  const fd = fs.openSync(r.real, 'r');
  const buf = Buffer.alloc(Math.min(LER_MAX, st.size));
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  if (buf.subarray(0, n).includes(0)) return partes.concat('[conteúdo: binário]').join('\n');
  let txt = buf.subarray(0, n).toString('utf8').replace(/�$/, '');
  partes.push('---', txt);
  if (st.size > n) partes.push(`--- [cortado em ${n} de ${st.size} bytes; use Read para o resto]`);
  return partes.join('\n');
}

function ligacoes({ caminho }) {
  const r = resolver(caminho);
  if (!r.item) throw new Error('não está no índice');
  const I = idx;
  const saida = (r.item.l || []).map((i) => I.itens[i]).filter(Boolean);
  const ent = (I.entrada.get(r.i) || []).map((i) => I.itens[i]);
  const fmt = (arr) => arr.length ? arr.slice(0, 40).map((it) => `- ${it.t} — ${it.p}`).join('\n') + (arr.length > 40 ? `\n… +${arr.length - 40}` : '') : '(nenhum)';
  return `${r.item.t}\nSaída (${saida.length}):\n${fmt(saida)}\nEntrada (${ent.length}):\n${fmt(ent)}`;
}

function recentes({ area, dias = 7, limite = 10 }) {
  const I = carregar();
  const d = Math.max(1, Math.min(30, dias | 0 || 7));
  const lim = Math.max(1, Math.min(20, limite | 0 || 10));
  const corte = Date.now() / 1000 - d * 86400;
  const res = I.itens.filter((it) => it.m >= corte && (!area || it.a === area) && it.k !== 'resumo')
    .sort((a, b) => b.m - a.m);
  if (!res.length) return `Nada mudou em ${d} dia(s)${area ? ' na área ' + area : ''}.`;
  return `${res.length} item(ns) em ${d} dia(s), mostrando ${Math.min(lim, res.length)}:\n` +
    res.slice(0, lim).map((it) => linha(it)).join('\n');
}

const FERRAMENTAS = [
  {
    name: 'cerebro_buscar',
    description: 'Busca arquivos no índice do segundo cérebro (memórias, notas, skills, projetos). Use antes de grep/find.',
    inputSchema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'termos' },
        area: { type: 'string', description: 'filtro opcional: a área que o indexador gravou (ex.: memoria, skills, projetos, rotinas)' },
        tipo: { type: 'string', description: 'nota, feedback, reference, project, skill, migration, config, rotina' },
        limite: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['consulta'],
    },
    fn: buscar,
  },
  {
    name: 'cerebro_arquivo',
    description: 'Metadados do índice + até 4 KB do conteúdo de um arquivo.',
    inputSchema: { type: 'object', properties: { caminho: { type: 'string', description: 'absoluto ou nome do arquivo' } }, required: ['caminho'] },
    fn: arquivo,
  },
  {
    name: 'cerebro_ligacoes',
    description: 'Links de saída e de entrada de uma nota.',
    inputSchema: { type: 'object', properties: { caminho: { type: 'string' } }, required: ['caminho'] },
    fn: ligacoes,
  },
  {
    name: 'cerebro_recentes',
    description: 'Arquivos do índice alterados nos últimos N dias.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'filtro opcional de área' },
        dias: { type: 'integer', minimum: 1, maximum: 30 },
        limite: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
    fn: recentes,
  },
];
const POR_NOME = new Map(FERRAMENTAS.map((f) => [f.name, f]));
const LISTA = FERRAMENTAS.map(({ fn, ...f }) => ({ ...f, annotations: { readOnlyHint: true } }));

// Solta o índice após 15 min sem chamada (sessão parada volta ao mínimo).
let descarga = null;
function armarDescarga() {
  if (descarga) clearTimeout(descarga);
  descarga = setTimeout(() => { idx = null; idxMtime = 0; }, 15 * 60 * 1000);
  descarga.unref();
}

// ---------- JSON-RPC por stdio (uma mensagem por linha) ----------
const enviar = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function tratar(m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    if (m && m.id !== undefined && m.method === undefined) return; // resposta do cliente: ignora
    return enviar({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const temId = m.id !== undefined && m.id !== null;
  const ok = (result) => temId && enviar({ jsonrpc: '2.0', id: m.id, result });
  const erro = (code, message) => temId && enviar({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': {
      const pedido = m.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLOS.includes(pedido) ? pedido : PROTOCOLOS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cerebro', version: VERSAO },
        instructions: 'Índice local do segundo cérebro. Prefira cerebro_buscar a grep/find para achar memória, nota, skill ou doc.',
      });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: LISTA });
    case 'tools/call': {
      armarDescarga();
      const f = POR_NOME.get(m.params?.name);
      if (!f) return erro(-32602, `ferramenta desconhecida: ${m.params?.name}`);
      try {
        return ok({ content: [{ type: 'text', text: f.fn(m.params.arguments || {}) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: 'Erro: ' + e.message }], isError: true });
      }
    }
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default:
      if (m.method.startsWith('notifications/')) return;
      return erro(-32601, `método não suportado: ${m.method}`);
  }
}

let resto = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (pedaco) => {
  resto += pedaco;
  let nl;
  while ((nl = resto.indexOf('\n')) >= 0) {
    const l = resto.slice(0, nl).trim();
    resto = resto.slice(nl + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { enviar({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (Array.isArray(m)) m.forEach(tratar); else tratar(m);
  }
});
process.stdin.on('end', () => process.exit(0));
