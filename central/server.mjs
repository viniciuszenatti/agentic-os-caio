// Central — tela de comando local do Agentic OS.
// Node puro, sem dependências. Escuta só em 127.0.0.1:4747 (CENTRAL_PORT/CENTRAL_HOST/CENTRAL_HOME trocam isso).
// Convenção de pastas: o repo inteiro mora em ~/.claude/agentic-os (AGENTIC_OS_DIR troca a pasta de dados).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { randomUUID, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { criarRotasPlanos, carregarModulos } from './rotas-planos.mjs';

function portaDoEnv(v) {
  if (v === undefined || v === '') return 4747;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`CENTRAL_PORT inválida: ${v}`);
  return n;
}
const HOST = process.env.CENTRAL_HOST || '127.0.0.1';
const PORT = portaDoEnv(process.env.CENTRAL_PORT);
const HOME = process.env.CENTRAL_HOME || os.homedir();
const CL = `${HOME}/.claude`;
const AQUI = path.dirname(fileURLToPath(import.meta.url));
// Dados da ferramenta (planos, líderes, verificadores, fila de respostas, token): ~/.claude/agentic-os por padrão.
const BASE = process.env.AGENTIC_OS_DIR || `${CL}/agentic-os`;
// Código irmão da Central no mesmo repo: ../cerebro e ../coletar.mjs.
const RAIZ_REPO = path.dirname(AQUI);
const CEREBRO = path.join(RAIZ_REPO, 'cerebro');
const COLETOR = path.join(RAIZ_REPO, 'coletar.mjs');
const SCRATCH = `/tmp/claude-${process.getuid?.() ?? 1000}/`;
const NOMES_HOST = [...new Set(['127.0.0.1', 'localhost', HOST])];
const ORIGENS = new Set(NOMES_HOST.map((h) => `http://${h}:${PORT}`));
const HOSTS = new Set(NOMES_HOST.map((h) => `${h}:${PORT}`));
// Pastas que o botão "abrir" aceita (comparadas pelo realpath). NOTAS_DIR entra se existir.
const RAIZES_ABRIR = [`${CL}/`, SCRATCH, `${RAIZ_REPO}/`, ...(process.env.NOTAS_DIR ? [path.resolve(process.env.NOTAS_DIR) + '/'] : [])];
function realOuNada(p) { try { return fs.realpathSync(p); } catch { return null; } }
function podeAbrir(real) {
  if (!real) return false;
  return RAIZES_ABRIR.some((r) => real.startsWith(r));
}
const LIMITE_CORPO = 8192; // cabe uma resposta de 2000 caracteres acentuados
const ENV = { ...process.env, HOME, PATH: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin` };

// ---------- utilidades ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function lerJson(arq) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return null; }
}
function ultimasLinhas(arq, n) {
  try { return fs.readFileSync(arq, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
function rabo(s, max = 2048) {
  s = String(s || '');
  return s.length > max ? '…' + s.slice(-max) : s;
}

// ---------- retrato (cache 30 s, uma execução por vez) ----------
let cache = { em: 0, dado: null };
let emVoo = null;
function retrato() {
  if (cache.dado && Date.now() - cache.em < 30_000) return Promise.resolve(cache.dado);
  if (emVoo) return emVoo;
  emVoo = new Promise((ok) => {
    execFile('node', [COLETOR], { env: ENV, timeout: 25_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) => {
      emVoo = null;
      if (err) return ok({ erro: `coletor falhou: ${rabo(errOut || err.message, 400)}`, anterior: cache.dado });
      try {
        cache = { em: Date.now(), dado: JSON.parse(out) };
        ok(cache.dado);
      } catch { ok({ erro: 'coletor devolveu algo que não é JSON', anterior: cache.dado }); }
    });
  });
  return emVoo;
}

// ---------- execuções ----------
const execucoes = []; // mais nova primeiro, guarda 20
function registrar(acao) {
  const e = { id: randomUUID().slice(0, 8), acao, estado: 'rodando', inicio: Date.now(), fim: null, saida: '' };
  execucoes.unshift(e);
  execucoes.length = Math.min(execucoes.length, 20);
  return e;
}
function rodar(acao, cmd, args, timeoutMs, cwd = HOME) {
  const e = registrar(acao);
  let buf = '';
  const p = spawn(cmd, args, { env: ENV, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const junta = (d) => { buf = rabo(buf + d.toString(), 8192); };
  p.stdout.on('data', junta);
  p.stderr.on('data', junta);
  const t = setTimeout(() => { junta('\n[tempo esgotado: processo encerrado]'); p.kill('SIGTERM'); }, timeoutMs);
  p.on('error', (err) => { junta(`\n[não iniciou: ${err.message}]`); });
  p.on('close', (code) => {
    clearTimeout(t);
    e.estado = code === 0 ? 'ok' : 'falhou';
    e.fim = Date.now();
    e.saida = rabo(buf.trim(), 2048);
    if (acao === 'diagnostico' || acao.startsWith('deck')) cache.em = 0;
  });
  return e;
}
const rodando = (acao) => execucoes.find((e) => e.acao === acao && e.estado === 'rodando');

// ---------- deck ----------
const MODELOS = new Set(['haiku', 'sonnet', 'opus']);
const ESFORCOS = new Set(['low', 'medium', 'high']);
const DECK_DIR = `${CL}/deck`;
const SCRIPT_LEITURA = 'mkdir -p "$5" && f="$5/$1-$(date +%Y-%m-%d_%H%M).md" && claude -p "$2" --model "$3" --effort "$4" --allowedTools Read Grep Glob > "$f" && echo "$(date -Iseconds) $1 modelo=$3 esforco=$4 arquivo=$f" >> "$5/runs.log" && echo "$f"';
const SCRIPT_LIMPEZA = `mkdir -p "$5" && f="$5/$1-$(date +%Y-%m-%d_%H%M).md" && claude -p "$2" --model "$3" --effort "$4" --allowedTools "Bash(bash ${CL}/skills/limpeza/diagnostico.sh:*)" Read > "$f" && echo "$(date -Iseconds) $1 modelo=$3 esforco=$4 arquivo=$f" >> "$5/runs.log" && echo "$f"`;
// Standup genérico: lê os planos e os diários dos líderes (sem tracker). Ligue aqui o seu tracker, se quiser.
const PROMPT_STANDUP = `Resuma a semana em pt-BR: planos em ${BASE}/planos (o .md e o .registro.json ao lado), o que concluiu, o que está rodando há mais tempo, o que falhou ou travou, e a etapa de cada área nos diários de ${BASE}/lideres. Só leitura: não altere nada.`;

// ---------- ações (lista fechada) ----------
const ACOES = {
  diagnostico: () => ({ cmd: 'bash', args: [`${CL}/skills/limpeza/diagnostico.sh`, '--rapido'], t: 5 * 60_000 }),
  saude: () => {
    const arq = `${CL}/limpeza/saude.mjs`;
    if (!fs.existsSync(arq)) return { erro: `o medidor de saúde ainda não existe (${arq})`, code: 404 };
    return { cmd: 'node', args: [arq], t: 2 * 60_000 };
  },
  reindexar: () => ({ cmd: 'node', args: [`${CEREBRO}/indexar.mjs`], t: 3 * 60_000 }),
  'deck-standup': (c) => deck('standup', PROMPT_STANDUP, SCRIPT_LEITURA, c),
  'deck-limpeza': (c) => deck('limpeza', '/limpeza', SCRIPT_LIMPEZA, c),
};
// ---------- fase 3: modo build (script do outro agente; pode ainda não existir) ----------
const MODO_BUILD = `${CL}/rotinas/modo-build.sh`;
for (const modo of ['on', 'off']) {
  ACOES[`modo-build-${modo}`] = () => {
    if (!fs.existsSync(MODO_BUILD)) return { erro: `o script do modo build ainda não existe (${MODO_BUILD})`, code: 404 };
    return { cmd: 'bash', args: [MODO_BUILD, modo], t: 60_000 };
  };
}
function modoBuild() {
  return new Promise((ok) => {
    if (!fs.existsSync(MODO_BUILD)) return ok({ ausente: true, ativo: false });
    execFile('bash', [MODO_BUILD, 'status'], { env: ENV, cwd: HOME, timeout: 10_000, maxBuffer: 256 * 1024 }, (err, out, errOut) => {
      const txt = String(out || '').trim();
      const ini = txt.indexOf('{');
      try {
        const d = JSON.parse(ini >= 0 ? txt.slice(ini) : txt);
        return ok({ ativo: !!d.ativo, desde: d.desde ?? null, volta: typeof d.volta === 'string' ? d.volta : null, timers: Array.isArray(d.timers) ? d.timers.slice(0, 40).map(String) : [] });
      } catch {
        return ok({ erro: `status não devolveu JSON: ${rabo(errOut || txt || err?.message, 300)}`, ativo: false });
      }
    });
  });
}

// ---------- fase 3: capacidade do PC (arquivo do outro agente) ----------
const CAPACIDADE = `${CL}/rotinas/estado/capacidade.json`;
function capacidade() {
  if (!fs.existsSync(CAPACIDADE)) return { ausente: true };
  const d = lerJson(CAPACIDADE);
  if (!d || typeof d !== 'object') return { ausente: true, erro: 'capacidade.json não é JSON válido' };
  return d;
}

// ---------- fase 5: arquivos de estado (só leitura, lista fechada) ----------
// O nome vem da URL, mas só escolhe uma chave deste mapa: nenhum caminho do cliente vira leitura de disco.
const ESTADO_DIR = `${CL}/rotinas/estado`;
const ESTADOS = {
  capacidade: `${ESTADO_DIR}/capacidade.json`,
  'vigia-ci': `${ESTADO_DIR}/vigia-ci.json`,
  'saude-rotinas': `${ESTADO_DIR}/saude-rotinas.json`,
  'lembrete-commit': `${ESTADO_DIR}/lembrete-commit.json`,
  'onde-parei': `${ESTADO_DIR}/onde-parei.json`,
  cota: `${ESTADO_DIR}/cota.json`,
  saude: `${CL}/limpeza/saude.json`,
};
const LIMITE_ESTADO = 2 * 1024 * 1024;
// "fora há N min": o saude.json não guarda histórico; a Central lembra (em memória) a 1ª medição em que cada alvo apareceu fora.
const foraDesde = new Map();
function lerEstado(nome) {
  const arq = ESTADOS[nome];
  let st; try { st = fs.statSync(arq); } catch { return { ausente: true, nome }; }
  if (!st.isFile() || st.size > LIMITE_ESTADO) return { ausente: true, nome, erro: 'arquivo grande demais ou não é arquivo' };
  const d = lerJson(arq);
  if (!d || typeof d !== 'object') return { ausente: true, nome, erro: `${path.basename(arq)} não é JSON válido` };
  if (nome === 'saude' && Array.isArray(d.itens)) {
    const em = typeof d.em === 'number' ? d.em : Date.parse(d.em) || st.mtimeMs;
    const vistos = new Set();
    for (const i of d.itens) {
      const k = `${i.ambiente}|${i.nome}`;
      if (i.ok) continue;
      vistos.add(k);
      if (!foraDesde.has(k)) foraDesde.set(k, em);
      i.foraDesde = foraDesde.get(k);
    }
    for (const k of [...foraDesde.keys()]) if (!vistos.has(k)) foraDesde.delete(k);
  }
  return { ...d, _mtime: st.mtimeMs };
}

// ---------- fase 3: pergunte ao cérebro ----------
const PERGUNTAS = `${DECK_DIR}/perguntas`;
const PREFIXO_PERGUNTA = `Responda em pt-BR, em até 8 linhas, citando os caminhos dos arquivos usados. Use o índice ${CEREBRO}/indice.json para achar os arquivos relevantes e leia só os necessários (no máximo 6). Só leitura. Pergunta: `;
const MODELOS_PERGUNTA = new Set(['haiku', 'sonnet']);
const dois = (n) => String(n).padStart(2, '0');
function isoLocal(d) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}T${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}${s}${dois(Math.floor(a / 60))}:${dois(a % 60)}`;
}
function caminhosCitados(txt) {
  const vistos = new Set(), out = [];
  const homeRe = HOME.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const m of String(txt).matchAll(new RegExp(`(?:~|${homeRe})/[^\\s\`'"()<>\\[\\]{},;|*]+`, 'g'))) {
    const bruto = m[0].replace(/[.:!?]+$/, '').replace(/:\d+(-\d+)?$/, '');
    const abs = bruto.startsWith('~') ? HOME + bruto.slice(1) : bruto;
    if (vistos.has(abs)) continue;
    vistos.add(abs);
    const real = realOuNada(abs);
    out.push({ texto: bruto, caminho: abs, existe: !!real, abrivel: podeAbrir(real) });
    if (out.length >= 12) break;
  }
  return out;
}
function perguntar(corpo, res) {
  const pergunta = typeof corpo?.pergunta === 'string' ? corpo.pergunta.trim() : '';
  const modelo = corpo?.modelo ?? 'haiku';
  if (!pergunta) return json(res, 400, { erro: 'pergunta vazia' });
  if (pergunta.length > 300) return json(res, 400, { erro: 'pergunta passa de 300 caracteres' });
  if (pergunta.includes('\0')) return json(res, 400, { erro: 'pergunta inválida' });
  if (typeof modelo !== 'string' || !MODELOS_PERGUNTA.has(modelo)) return json(res, 400, { erro: 'modelo fora da lista (haiku|sonnet)' });
  const ja = rodando('perguntar');
  if (ja) return json(res, 409, { erro: 'já tem uma pergunta rodando', execucao: ja.id });
  const e = registrar('perguntar');
  e.pergunta = pergunta; e.modelo = modelo;
  // argv fixo: a pergunta é UM argumento do processo, nunca passa por shell.
  const args = ['-p', PREFIXO_PERGUNTA + pergunta, '--model', modelo, '--effort', 'low', '--allowedTools', 'Read', 'Grep', 'Glob'];
  let out = '', err = '';
  const p = spawn('claude', args, { env: ENV, cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => { out = (out + d.toString()).slice(-32_768); });
  p.stderr.on('data', (d) => { err = rabo(err + d.toString(), 4096); });
  const t = setTimeout(() => { err += '\n[tempo esgotado: 5 min]'; p.kill('SIGTERM'); }, 5 * 60_000);
  p.on('error', (x) => { err += `\n[não iniciou: ${x.message}]`; });
  p.on('close', (code) => {
    clearTimeout(t);
    e.fim = Date.now();
    e.estado = code === 0 && out.trim() ? 'ok' : 'falhou';
    e.resposta = out.trim().slice(0, 8000);
    e.saida = rabo((e.estado === 'ok' ? '' : err.trim() + '\n') + e.resposta, 2048);
    e.caminhos = caminhosCitados(e.resposta);
    try {
      const d = new Date(e.inicio);
      fs.mkdirSync(PERGUNTAS, { recursive: true });
      const nome = `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}_${dois(d.getHours())}${dois(d.getMinutes())}${dois(d.getSeconds())}.md`;
      const arq = path.join(PERGUNTAS, nome);
      const seg = Math.round((e.fim - e.inicio) / 1000);
      fs.writeFileSync(arq, `# Pergunta ao cérebro\n\n- quando: ${isoLocal(d)}\n- modelo: ${modelo} · esforço low\n- tempo: ${seg} s\n- estado: ${e.estado}\n\n## Pergunta\n\n${pergunta}\n\n## Resposta\n\n${e.resposta || '(sem resposta)'}\n${e.estado === 'ok' ? '' : `\n## Erro\n\n\`\`\`\n${err.trim()}\n\`\`\`\n`}`);
      fs.appendFileSync(`${DECK_DIR}/runs.log`, `${isoLocal(new Date())} perguntar modelo=${modelo} esforco=low segundos=${seg} estado=${e.estado} arquivo=${arq}\n`);
      e.arquivo = arq;
    } catch (x) { e.saida = rabo(`${e.saida}\n[não gravei o .md: ${x.message}]`, 2048); }
  });
  return json(res, 202, { execucao: e.id, acao: 'perguntar' });
}

function deck(id, prompt, script, corpo) {
  const modelo = corpo?.modelo ?? 'haiku';
  const esforco = corpo?.esforco ?? 'low';
  if (!MODELOS.has(modelo) || !ESFORCOS.has(esforco)) return { erro: 'modelo ou esforço fora da lista', code: 400 };
  return { cmd: 'bash', args: ['-c', script, '_', id, prompt, modelo, esforco, DECK_DIR], t: 20 * 60_000 };
}

function abrir(corpo, res) {
  const bruto = corpo?.caminho;
  if (typeof bruto !== 'string' || !bruto.startsWith('/') || bruto.includes('\0')) return json(res, 400, { erro: 'caminho inválido' });
  let real;
  try { real = fs.realpathSync(bruto); } catch { return json(res, 404, { erro: 'arquivo não existe' }); }
  if (!podeAbrir(real)) return json(res, 403, { erro: 'caminho fora das pastas permitidas' });
  execFile('setsid', ['-f', 'xdg-open', real], { env: { ...ENV, DISPLAY: process.env.DISPLAY || ':0' }, timeout: 10_000 }, (err) => {
    if (err) return json(res, 500, { erro: `xdg-open falhou: ${err.message}` });
    json(res, 200, { ok: true, caminho: real });
  });
}


// ---------- nós do segundo cérebro (amostra para o globo) ----------
const AREAS = ['projetos', 'notas', 'memoria', 'skills', 'artefatos'];
let cacheNos = { mtime: 0, dado: null };
function nos() {
  const arq = `${CEREBRO}/indice.json`;
  let st; try { st = fs.statSync(arq); } catch { return { ausente: true, areas: AREAS, pontos: [] }; }
  if (cacheNos.dado && cacheNos.mtime === st.mtimeMs) return cacheNos.dado;
  const ind = lerJson(arq);
  const itens = Array.isArray(ind?.itens) ? ind.itens : [];
  const MAX = 2500;
  const passo = Math.max(1, itens.length / MAX);
  const pontos = [];
  for (let i = 0; i < itens.length && pontos.length < MAX; i += passo) {
    const a = AREAS.indexOf(itens[Math.floor(i)]?.a);
    pontos.push(a < 0 ? AREAS.length : a);
  }
  const dado = { gerado: ind?.gerado ?? null, total: itens.length, areas: AREAS, porArea: ind?.porArea ?? {}, pontos };
  cacheNos = { mtime: st.mtimeMs, dado };
  return dado;
}

// ---------- anel: skills e agentes reais ----------
// Skills que aparecem primeiro no anel (as que vêm neste repo); o resto entra por uso nos últimos 30 dias.
const PRIORIDADE = ['limpeza', 'pesquisa-rapida', 'velocidade-site', 'performance', 'core-web-vitals', 'calibrate', 'personalise'];
const ACAO_DA_SKILL = { limpeza: 'deck-limpeza' };
const NAO_E_ITEM = new Set(['general-purpose', 'Explore', 'Plan', 'claude', 'statusline-setup', 'claude-code-guide']);
function frenteMd(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];
  let desc = '';
  const d = fm.match(/^description:[ \t]*(.*)$/m);
  if (d) {
    let v = d[1].trim();
    if (/^[>|][-+]?$/.test(v) || v === '') {
      const resto = fm.slice(d.index + d[0].length).split('\n');
      const linhas = [];
      for (const l of resto) { if (/^\S/.test(l)) break; linhas.push(l.trim()); }
      v = linhas.join(' ');
    }
    desc = v.replace(/^["']|["']$/g, '').trim();
  }
  return { desc };
}
function curta(s, n = 260) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const corte = s.slice(0, n);
  const ponto = corte.lastIndexOf('. ');
  return (ponto > n * 0.5 ? corte.slice(0, ponto + 1) : corte.replace(/\s+\S*$/, '') + '…');
}
function acharPlugin(nome) {
  const [, sk] = nome.split(':');
  if (!sk) return null;
  const raiz = `${CL}/plugins/cache`;
  const achados = [];
  const andar = (d, prof) => {
    if (prof > 5) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === 'skills') { const f = path.join(p, sk, 'SKILL.md'); if (fs.existsSync(f)) achados.push(f); }
      else andar(p, prof + 1);
    }
  };
  andar(raiz, 0);
  if (!achados.length) return null;
  achados.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return achados[0];
}
function itemAnel(nome, usos) {
  let caminho = null, tipo = 'skill', origem = 'sua';
  const sk = `${CL}/skills/${nome}/SKILL.md`, ag = `${CL}/agents/${nome}.md`;
  if (fs.existsSync(sk)) caminho = sk;
  else if (fs.existsSync(ag)) { caminho = ag; tipo = 'agente'; origem = 'agente'; }
  else if (nome.includes(':')) { caminho = acharPlugin(nome); origem = 'plugin · ' + nome.split(':')[0]; }
  if (!caminho) return null;
  const real = realOuNada(caminho);
  let md = ''; try { md = fs.readFileSync(caminho, 'utf8'); } catch {}
  const it = { nome, tipo, origem, desc: curta(frenteMd(md).desc), caminho: real || caminho, abrivel: podeAbrir(real) };
  if (typeof usos === 'number') it.usos = usos;
  if (ACAO_DA_SKILL[nome]) it.acao = ACAO_DA_SKILL[nome];
  return it;
}
let cacheAnel = { em: 0, ctx: 0, dado: null };
function anel() {
  const ctxArq = `${CL}/limpeza/contexto.json`;
  let ctxM = 0; try { ctxM = fs.statSync(ctxArq).mtimeMs; } catch {}
  if (cacheAnel.dado && cacheAnel.ctx === ctxM && Date.now() - cacheAnel.em < 10 * 60_000) return cacheAnel.dado;
  const ctx = lerJson(ctxArq);
  const usos = ctx && ctx.usos30d && typeof ctx.usos30d === 'object' ? ctx.usos30d : null;
  const u = (n) => (usos ? (usos[n] ?? 0) : undefined);
  const itens = [], vistos = new Set();
  const por = (n) => { if (vistos.has(n) || NAO_E_ITEM.has(n) || itens.length >= 30) return; const it = itemAnel(n, u(n)); if (it) { itens.push(it); vistos.add(n); } };
  PRIORIDADE.forEach(por);
  if (usos) Object.entries(usos).sort((a, b) => b[1] - a[1]).forEach(([n, v]) => { if (v > 0) por(n); });
  const dado = { em: Date.now(), usosDisponiveis: !!usos, base: usos ? `${ctx.transcripts30d ?? '?'} transcripts de 30 dias` : null, itens };
  cacheAnel = { em: Date.now(), ctx: ctxM, dado };
  return dado;
}


// ---------- busca no índice do cérebro ----------
let cacheIndice = { mtime: 0, itens: [] };
function itensIndice() {
  const arq = `${CEREBRO}/indice.json`;
  let st; try { st = fs.statSync(arq); } catch { return []; }
  if (cacheIndice.mtime !== st.mtimeMs) {
    const ind = lerJson(arq);
    cacheIndice = { mtime: st.mtimeMs, itens: (Array.isArray(ind?.itens) ? ind.itens : []).map((i) => ({
      p: String(i.p || ''), a: i.a, t: String(i.t || ''), x: String(i.x || '').slice(0, 400), m: i.m,
      chave: `${i.t || ''} ${i.p || ''} ${i.x || ''}`.toLowerCase(),
    })) };
  }
  return cacheIndice.itens;
}
function busca(q) {
  q = String(q ?? '').trim().toLowerCase().slice(0, 100);
  if (!q) return { q, resultados: [] };
  const termos = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const res = [];
  for (const i of itensIndice()) {
    if (!termos.every((t) => i.chave.includes(t))) continue;
    const tl = i.t.toLowerCase();
    const score = termos.reduce((a, t) => a + (tl.includes(t) ? 3 : 0) + (path.basename(i.p).toLowerCase().includes(t) ? 2 : 0), 0);
    res.push({ score, i });
  }
  res.sort((a, b) => b.score - a.score || (b.i.m || 0) - (a.i.m || 0));
  return { q, total: res.length, resultados: res.slice(0, 30).map(({ i }) => {
    const real = realOuNada(i.p);
    return { titulo: i.t || path.basename(i.p), caminho: i.p, area: i.a, desc: i.x.replace(/\s+/g, ' ').slice(0, 180), abrivel: podeAbrir(real) };
  }) };
}

// ---------- sessões: ler, fechar, responder ----------
const SESSOES = `${CL}/sessions`;
const vivo = (pid) => Number.isInteger(pid) && pid > 1 && fs.existsSync(`/proc/${pid}`);
function lerSessoes() {
  const out = [];
  let fs_ = []; try { fs_ = fs.readdirSync(SESSOES).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of fs_) { const s = lerJson(path.join(SESSOES, f)); if (s && s.sessionId) out.push(s); }
  return out;
}
const DIA_MS = 86_400_000;
function fecharSessao(corpo, res) {
  const sid = corpo?.sessionId;
  if (typeof sid !== 'string' || !/^[0-9a-f-]{36}$/.test(sid)) return json(res, 400, { erro: 'sessionId inválido' });
  const s = lerSessoes().find((x) => x.sessionId === sid);
  if (!s) return json(res, 404, { erro: 'sessão não encontrada' });
  if (s.status !== 'idle') return json(res, 409, { erro: `sessão está ${s.status || '?'}, só fecho sessão parada` });
  const desde = s.statusUpdatedAt ?? s.updatedAt ?? Date.now();
  if (Date.now() - desde < DIA_MS) return json(res, 409, { erro: 'sessão parada há menos de 24 h' });
  const pid = s.pid;
  if (!vivo(pid) || pid === process.pid) return json(res, 410, { erro: 'processo da sessão já não existe' });
  let cmd = '', stat = '';
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch {}
  if (!/claude/.test(cmd)) return json(res, 409, { erro: 'o pid não é um processo do claude' });
  const inicio = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (s.procStart && String(s.procStart) !== inicio) return json(res, 409, { erro: 'o pid foi reaproveitado por outro processo' });
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return json(res, 500, { erro: `não consegui encerrar: ${e.message}` }); }
  cache.em = 0;
  json(res, 200, { ok: true, nome: s.name ?? String(pid), pid });
}
const FILA = `${BASE}/fila-respostas`;
function responder(corpo, res) {
  const sid = corpo?.sessionId, texto = corpo?.texto;
  if (typeof sid !== 'string' || !/^[0-9a-f-]{36}$/.test(sid)) return json(res, 400, { erro: 'sessionId inválido' });
  if (typeof texto !== 'string' || !texto.trim()) return json(res, 400, { erro: 'texto vazio' });
  if (texto.length > 2000) return json(res, 400, { erro: 'texto passa de 2000 caracteres' });
  const s = lerSessoes().find((x) => x.sessionId === sid && vivo(x.pid));
  if (!s) return json(res, 404, { erro: 'sessão não está aberta' });
  const em = Date.now();
  fs.mkdirSync(FILA, { recursive: true });
  const nome = `${em}-${sid}.json`;
  const tmp = path.join(FILA, `.${nome}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ sessionId: sid, nome: s.name ?? String(s.pid), texto, em }));
  fs.renameSync(tmp, path.join(FILA, nome));
  json(res, 200, { ok: true, arquivo: nome });
}
function respostas() {
  const lista = [];
  const ler = (dir, estado) => {
    let fs_ = []; try { fs_ = fs.readdirSync(dir).filter((f) => /^\d+-[0-9a-f-]{36}\.json(\.enviando)?$/.test(f)); } catch {}
    for (const f of fs_) {
      const d = lerJson(path.join(dir, f)) || {};
      const est = f.endsWith('.enviando') ? 'enviando' : estado;
      lista.push({ arquivo: f, estado: est, sessionId: d.sessionId, nome: d.nome, texto: String(d.texto || '').slice(0, 160), em: d.em ?? Number(f.split('-')[0]), erro: d.erro });
    }
  };
  ler(FILA, 'fila'); ler(`${FILA}/enviadas`, 'enviada'); ler(`${FILA}/erros`, 'erro');
  lista.sort((a, b) => b.em - a.em);
  return { itens: lista.slice(0, 30) };
}

// ---------- linha do tempo de hoje ----------
const PROJETOS = `${CL}/projects`;
// pasta de projeto do Claude Code: o cwd com "/" virando "-" (ex.: -home-voce-Projects-app)
const PREFIXO_PROJ = new RegExp(`^${HOME.replace(/[^A-Za-z0-9]/g, '-')}-?`);
const RELATORIOS = `${CL}/doc-de-sessao`;
function pedaco(arq, inicio, tam) {
  const fd = fs.openSync(arq, 'r');
  try { const b = Buffer.alloc(tam); const n = fs.readSync(fd, b, 0, tam, inicio); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function tempos(texto, doFim) {
  const linhas = texto.split('\n');
  if (doFim) linhas.reverse();
  for (const l of linhas) { const m = l.match(/"timestamp":"([^"]+)"/); if (m) { const t = Date.parse(m[1]); if (t) return t; } }
  return null;
}
let cacheHoje = { em: 0, dado: null };
function hoje() {
  if (cacheHoje.dado && Date.now() - cacheHoje.em < 120_000) return cacheHoje.dado;
  const ini = new Date(); ini.setHours(0, 0, 0, 0);
  const t0 = ini.getTime();
  const sess = new Map(lerSessoes().map((s) => [s.sessionId, s]));
  const relatorios = [];
  try {
    for (const f of fs.readdirSync(RELATORIOS).filter((x) => x.endsWith('.md'))) {
      const st = fs.statSync(path.join(RELATORIOS, f));
      if (st.mtimeMs >= t0 - DIA_MS) relatorios.push({ f, m: st.mtimeMs });
    }
  } catch {}
  const raias = [];
  let pastas = []; try { pastas = fs.readdirSync(PROJETOS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of pastas) {
    const dir = path.join(PROJETOS, d.name);
    let arqs = []; try { arqs = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of arqs) {
      const arq = path.join(dir, f);
      let st; try { st = fs.statSync(arq); } catch { continue; }
      if (st.mtimeMs < t0) continue;
      const K = 64 * 1024;
      let ini_ = null, fim = null, titulo = '';
      try {
        const cab = pedaco(arq, 0, Math.min(K, st.size));
        ini_ = tempos(cab, false);
        fim = tempos(pedaco(arq, Math.max(0, st.size - K), Math.min(K, st.size)), true) ?? st.mtimeMs;
        const junto = cab + pedaco(arq, Math.max(0, st.size - K), Math.min(K, st.size));
        for (const m of junto.matchAll(/"(?:aiTitle|customTitle)":"((?:[^"\\]|\\.)*)"/g)) titulo = m[1];
        try { if (titulo) titulo = JSON.parse(`"${titulo}"`); } catch {}
      } catch { continue; }
      if (!ini_) ini_ = st.birthtimeMs || st.mtimeMs;
      const sid = f.replace(/\.jsonl$/, '');
      const s = sess.get(sid);
      raias.push({ sessionId: sid, nome: s?.name ?? null, pasta: s?.cwd ? s.cwd.replace(HOME, '~') : d.name.replace(PREFIXO_PROJ, '~/'), titulo, inicio: Math.max(ini_, t0), fim, aberta: !!(s && vivo(s.pid)), status: s?.status ?? null, kb: Math.round(st.size / 1024) });
    }
  }
  raias.sort((a, b) => a.inicio - b.inicio);
  // Checklist do doc-de-sessao: o coletor já casa relatório × sessão; aqui uso o retrato em cache.
  const porSessao = new Map((cache.dado?.sessoes || []).filter((s) => s.relatorio).map((s) => [s.sessionId, s.relatorio]));
  for (const r of raias) { const rel = porSessao.get(r.sessionId); if (rel) r.checklist = { titulo: rel.titulo, briefing: rel.briefing, itens: (rel.itens || []).slice(0, 12).map((i) => ({ item: i.item, estado: i.estado })) }; }
  const dado = { dia: t0, agora: Date.now(), raias: raias.slice(-40), total: raias.length };
  cacheHoje = { em: Date.now(), dado };
  return dado;
}

// ---------- layout do painel (compartilhado entre os aparelhos que abrem a Central) ----------
const LAYOUT = `${AQUI}/layout.json`;
const CARTOES = new Set(['apps', 'calendario', 'noticias', 'precisa', 'revisao', 'escala', 'deck', 'rotinas']);
const TAMANHOS = new Set(['compacto', 'normal', 'alto']);
const LARGURA_MIN = 240, LARGURA_MAX = 560;
const LIMITE_LAYOUT = 8192;
// Esquema fechado: chave desconhecida, id desconhecido, id repetido ou número fora da faixa → recusa (nada é "consertado" em silêncio).
function validarLayout(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'layout precisa ser um objeto';
  if (JSON.stringify(l).length > LIMITE_LAYOUT) return 'layout passa de 8 KB';
  const CHAVES = new Set(['v', 'colunas', 'escondidos', 'recolhidos', 'tamanhos', 'larguras']);
  for (const k of Object.keys(l)) if (!CHAVES.has(k)) return `chave desconhecida: ${k}`;
  if (l.v !== 1) return 'versão do layout precisa ser 1';
  const c = l.colunas;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'colunas precisa ser um objeto';
  for (const k of Object.keys(c)) if (k !== 'esq' && k !== 'dir') return `coluna desconhecida: ${k}`;
  const vistos = new Set();
  for (const k of ['esq', 'dir']) {
    if (!Array.isArray(c[k]) || c[k].length > CARTOES.size) return `colunas.${k} precisa ser uma lista`;
    for (const id of c[k]) {
      if (typeof id !== 'string' || !CARTOES.has(id)) return `cartão desconhecido: ${String(id).slice(0, 40)}`;
      if (vistos.has(id)) return `cartão repetido: ${id}`;
      vistos.add(id);
    }
  }
  for (const k of ['escondidos', 'recolhidos']) {
    const xs = l[k] ?? [];
    if (!Array.isArray(xs) || xs.length > CARTOES.size) return `${k} precisa ser uma lista`;
    if (new Set(xs).size !== xs.length) return `${k} tem repetido`;
    for (const id of xs) if (typeof id !== 'string' || !CARTOES.has(id)) return `cartão desconhecido em ${k}: ${String(id).slice(0, 40)}`;
  }
  const t = l.tamanhos ?? {};
  if (typeof t !== 'object' || Array.isArray(t) || t === null) return 'tamanhos precisa ser um objeto';
  for (const [id, v] of Object.entries(t)) {
    if (!CARTOES.has(id)) return `cartão desconhecido em tamanhos: ${id.slice(0, 40)}`;
    if (!TAMANHOS.has(v)) return `tamanho inválido: ${String(v).slice(0, 20)}`;
  }
  const w = l.larguras ?? {};
  if (typeof w !== 'object' || Array.isArray(w) || w === null) return 'larguras precisa ser um objeto';
  for (const [k, v] of Object.entries(w)) {
    if (k !== 'esq' && k !== 'dir') return `largura desconhecida: ${k.slice(0, 20)}`;
    if (v !== null && !(Number.isInteger(v) && v >= LARGURA_MIN && v <= LARGURA_MAX)) return `largura ${k} fora da faixa ${LARGURA_MIN}–${LARGURA_MAX}`;
  }
  return null;
}
function gravarAtomico(arq, texto) {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const tmp = path.join(path.dirname(arq), `.${path.basename(arq)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, texto);
  fs.renameSync(tmp, arq);
}
function salvarLayout(corpo, res) {
  const erro = validarLayout(corpo?.layout);
  if (erro) return json(res, 400, { erro });
  const l = corpo.layout;
  const limpo = { v: 1, colunas: { esq: l.colunas.esq, dir: l.colunas.dir }, escondidos: l.escondidos ?? [], recolhidos: l.recolhidos ?? [], tamanhos: l.tamanhos ?? {}, larguras: l.larguras ?? {}, em: Date.now() };
  try { gravarAtomico(LAYOUT, JSON.stringify(limpo, null, 1)); } catch (e) { return json(res, 500, { erro: `não gravei o layout: ${e.message}` }); }
  json(res, 200, { ok: true, em: limpo.em });
}
function lerLayout() {
  let st; try { st = fs.statSync(LAYOUT); } catch { return { ausente: true }; }
  if (!st.isFile() || st.size > LIMITE_LAYOUT * 2) return { ausente: true, erro: 'layout.json grande demais' };
  const d = lerJson(LAYOUT);
  if (!d) return { ausente: true, erro: 'layout.json não é JSON válido' };
  const { em, ...resto } = d;
  const erro = validarLayout(resto);
  return erro ? { ausente: true, erro: `layout.json inválido: ${erro}` } : { layout: resto, em };
}

// ---------- fase 6: caixa de revisão (lista fechada de pastas, só leitura) ----------
const REVISAO_DIR = `${BASE}/revisao`;
const DECISOES = `${REVISAO_DIR}/decisoes.jsonl`;
const SETE_DIAS = 7 * DIA_MS;
function mdsDe(dir, filtro) {
  let fs_ = []; try { fs_ = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return fs_.filter((e) => e.isFile() && e.name.endsWith('.md') && (!filtro || filtro(e.name))).map((e) => path.join(dir, e.name));
}
function fontesRevisao() {
  const hojeTx = (() => { const d = new Date(); return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`; })();
  const out = [];
  const add = (arq, origem, recente) => {
    let st; try { st = fs.lstatSync(arq); } catch { return; }
    if (!st.isFile()) return; // nada de link simbólico apontando para fora
    if (recente && Date.now() - st.mtimeMs > SETE_DIAS) return;
    out.push({ arq, origem, st });
  };
  for (const a of mdsDe(DECK_DIR)) add(a, 'deck', true);
  for (const a of mdsDe(PERGUNTAS)) add(a, 'pergunta', true);
  // relatórios .md que as suas rotinas gravarem em ~/.claude/rotinas/estado/ (lista fechada; acrescente o seu nome aqui)
  for (const n of ['noticias-ia']) add(`${ESTADO_DIR}/${n}.md`, 'rotina', false);
  add(`${CL}/limpeza/analise-ultima.md`, 'limpeza', false);
  for (const a of mdsDe(`${CL}/rotinas/fechamentos`, (n) => n.startsWith(hojeTx))) add(a, 'fechamento', false);
  return out;
}
// id = arquivo + versão: se a rotina regravar o arquivo, ele volta para a caixa como item novo.
const idRevisao = (arq, mtimeMs) => createHash('sha1').update(`${arq}|${Math.round(mtimeMs)}`).digest('hex').slice(0, 16);
function lerDecisoes() {
  const m = new Map();
  for (const l of ultimasLinhas(DECISOES, 5000)) { try { const d = JSON.parse(l); if (d && typeof d.id === 'string') m.set(d.id, d); } catch {} }
  return m;
}
function textoCurto(arq, max) {
  const fd = fs.openSync(arq, 'r');
  try { const b = Buffer.alloc(max); const n = fs.readSync(fd, b, 0, max, 0); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function itensRevisao() {
  const dec = lerDecisoes();
  return fontesRevisao().map(({ arq, origem, st }) => {
    let cab = ''; try { cab = textoCurto(arq, 4096); } catch {}
    // sem título "# ": usa a 1ª linha do texto (sem marcação) — "analise-ultima" não diz nada a ninguém
    const linha1 = cab.split('\n').map((l) => l.replace(/[#*_`>|]/g, '').trim()).find(Boolean) || '';
    const titulo = (cab.match(/^#{1,2}\s+(.+)$/m)?.[1] || (linha1.length > 90 ? linha1.slice(0, 88).replace(/\s+\S*$/, '') + '…' : linha1) || path.basename(arq, '.md')).trim().slice(0, 160);
    const trecho = cab.replace(/^#{1,2}\s+.+$/m, '').replace(/\r/g, '').trim().slice(0, 400);
    const id = idRevisao(arq, st.mtimeMs);
    const d = dec.get(id);
    return { id, titulo, origem, arquivo: arq.replace(HOME, '~'), quando: st.mtimeMs, trecho, kb: Math.round(st.size / 1024), decisao: d ? { decisao: d.decisao, em: d.em, comentario: d.comentario || '' } : null };
  }).sort((a, b) => b.quando - a.quando);
}
function itemRevisao(id) {
  const f = fontesRevisao().find(({ arq, st }) => idRevisao(arq, st.mtimeMs) === id);
  if (!f) return null;
  let texto = ''; try { texto = textoCurto(f.arq, 200 * 1024); } catch {}
  return { id, origem: f.origem, arquivo: f.arq.replace(HOME, '~'), caminho: f.arq, quando: f.st.mtimeMs, texto, cortado: f.st.size > 200 * 1024 };
}
function revisar(corpo, res) {
  const id = corpo?.id, decisao = corpo?.decisao, comentario = corpo?.comentario ?? '';
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return json(res, 400, { erro: 'id inválido' });
  if (decisao !== 'aprovar' && decisao !== 'rejeitar') return json(res, 400, { erro: 'decisão precisa ser aprovar ou rejeitar' });
  if (typeof comentario !== 'string' || comentario.length > 500 || comentario.includes('\0')) return json(res, 400, { erro: 'comentário passa de 500 caracteres' });
  const it = itensRevisao().find((x) => x.id === id);
  if (!it) return json(res, 404, { erro: 'item não está mais na caixa (o arquivo mudou ou saiu da janela de 7 dias)' });
  const linha = { em: isoLocal(new Date()), id, decisao, comentario: comentario.trim(), origem: it.origem, arquivo: it.arquivo, titulo: it.titulo };
  try { fs.mkdirSync(REVISAO_DIR, { recursive: true }); fs.appendFileSync(DECISOES, JSON.stringify(linha) + '\n'); }
  catch (e) { return json(res, 500, { erro: `não gravei a decisão: ${e.message}` }); }
  json(res, 200, { ok: true, ...linha });
}

// ---------- fase 6: notícias de IA (arquivo do outro agente; pode não existir) ----------
const NOTICIAS = `${ESTADO_DIR}/noticias-ia.json`;
const txt = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
function noticias() {
  let st; try { st = fs.statSync(NOTICIAS); } catch { return { ausente: true }; }
  if (!st.isFile() || st.size > LIMITE_ESTADO) return { ausente: true, erro: 'noticias-ia.json grande demais' };
  const d = lerJson(NOTICIAS);
  if (!d || !Array.isArray(d.itens)) return { ausente: true, erro: 'noticias-ia.json sem "itens"' };
  const itens = [];
  for (const i of d.itens.slice(0, 500)) {
    if (!i || typeof i !== 'object') continue;
    let url = null;
    try { const u = new URL(String(i.url || '')); if ((u.protocol === 'https:' || u.protocol === 'http:') && u.href.length <= 2000) url = u.href; } catch {}
    const titulo = txt(i.titulo, 300);
    if (!titulo || !url) continue;
    const q = typeof i.quando === 'number' ? (i.quando < 1e12 ? i.quando * 1000 : i.quando) : Date.parse(i.quando) || null;
    itens.push({ titulo, url, fonte: txt(i.fonte, 80), quando: q, tags: (Array.isArray(i.tags) ? i.tags : []).map((t) => txt(t, 40)).filter(Boolean).slice(0, 8), resumo: txt(i.resumo, 600) });
  }
  itens.sort((a, b) => (b.quando || 0) - (a.quando || 0));
  return { em: d.em ?? st.mtimeMs, total: itens.length, itens: itens.slice(0, 120) };
}

// ---------- fase 6: saída do dia ----------
const FECHAMENTOS = `${CL}/rotinas/fechamentos`;
function fechamento() {
  let fs_ = []; try { fs_ = fs.readdirSync(FECHAMENTOS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch {}
  if (!fs_.length) return { ausente: true };
  const arq = path.join(FECHAMENTOS, fs_[fs_.length - 1]);
  const d = lerJson(arq);
  if (!d) return { ausente: true, erro: `${path.basename(arq)} não é JSON válido` };
  const frentes = (Array.isArray(d.frentes) ? d.frentes : []).slice(0, 20).map((f) => ({
    titulo: txt(f.titulo, 160), feitos: f.feitos | 0, abertos: f.abertos | 0, bloqueados: f.bloqueados | 0,
    itens: (Array.isArray(f.itens) ? f.itens : []).filter((i) => i.classe === 'aberto' || i.classe === 'bloqueado').slice(0, 30)
      .map((i) => ({ n: txt(i.n, 10), item: txt(i.item, 200), estado: txt(i.estado, 240), classe: i.classe })),
  }));
  return { dia: d.dia, em: d.em, F: d.F | 0, A: d.A | 0, B: d.B | 0, frentes, md: realOuNada(arq.replace(/\.json$/, '.md')) };
}
const SCRIPT_ENCERRAR = 'systemctl --user start rotina-fechamento-do-dia.service; s=$?; echo "fechamento do dia: saída $s"; bash "$1" on --ate 08:00 || exit $?; exit $s';
ACOES['encerrar-dia'] = () => {
  if (!fs.existsSync(MODO_BUILD)) return { erro: `o script do modo build não existe (${MODO_BUILD})`, code: 404 };
  return { cmd: 'bash', args: ['-c', SCRIPT_ENCERRAR, '_', MODO_BUILD], t: 4 * 60_000 };
};

// ---------- fase 6: motor Gemini no deck (script do outro agente; pode não existir) ----------
const GEMINI = `${CL}/rotinas/gemini-rodar.sh`;
const TAREFAS_GEMINI = new Set(['standup', 'resumo-noticias']);
ACOES['deck-gemini'] = (c) => {
  const tarefa = c?.tarefa;
  if (typeof tarefa !== 'string' || !TAREFAS_GEMINI.has(tarefa)) return { erro: 'tarefa fora da lista (standup|resumo-noticias)', code: 400 };
  if (!fs.existsSync(GEMINI)) return { erro: `o script do Gemini ainda não existe (${GEMINI})`, code: 404 };
  return { cmd: 'bash', args: [GEMINI, tarefa], t: 10 * 60_000, tarefa };
};

// ---------- token dos POST (docs/arquitetura.md) ----------
// Gerado a cada início, gravado com modo 600 (um arquivo por porta) e injetado na página como <meta name="central-token">.
export const TOKEN_ARQ = `${BASE}/central-${PORT}.token`;
function gravarToken(arq, token) {
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const tmp = path.join(path.dirname(arq), `.${path.basename(arq)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, arq);
}
function tokenConfere(recebido, token) {
  if (typeof recebido !== 'string' || recebido.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(recebido), Buffer.from(token));
}
function servirPagina(res, token) {
  fs.readFile(path.join(AQUI, 'index.html'), 'utf8', (err, html) => {
    if (err) return json(res, 404, { erro: 'não encontrado' });
    const meta = `<meta name="central-token" content="${token}">\n<meta name="central-home" content="${HOME.replace(/[&"<>]/g, '')}">`;
    // a página traz <meta name="central-token" content=""> vazio: substitui; sem ele, injeta após <head>
    const VAZIO = /<meta name="central-token" content="">/;
    const com = VAZIO.test(html) ? html.replace(VAZIO, meta)
      : /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${meta}`) : meta + html;
    res.writeHead(200, { 'content-type': TIPOS['.html'], 'cache-control': 'no-store' });
    res.end(com);
  });
}

// ---------- nota de escalabilidade (docs/arquitetura.md), à parte do score ----------
const ESCALA_DIR = path.join(AQUI, 'escala');
const ESCALA_HIST = path.join(AQUI, 'escala.jsonl');
const alvosEscala = () => Object.keys(lerJson(path.join(AQUI, 'escala-pesos.json'))?.alvos_repos || {});
// Varredura estática: só leitura, lê origin/main por git archive. O teste de carga NÃO tem botão (mexe no DEV; roda pelo terminal).
ACOES['escala-varrer'] = (c) => {
  const alvo = c?.alvo;
  if (typeof alvo !== 'string' || !alvosEscala().includes(alvo)) return { erro: `alvo fora da lista (${alvosEscala().join('|')})`, code: 400 };
  return { cmd: 'node', args: [path.join(ESCALA_DIR, 'verificador.mjs'), '--alvo', alvo], t: 5 * 60_000, tarefa: alvo };
};
function escala() {
  const cfg = lerJson(path.join(AQUI, 'escala-pesos.json'));
  if (!cfg) return { ausente: true };
  let linhas = [];
  try { linhas = fs.readFileSync(ESCALA_HIST, 'utf8').trim().split('\n').filter(Boolean).slice(-400).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const alvos = Object.keys(cfg.alvos_repos || {}).map((alvo) => {
    const hist = linhas.filter((l) => l.alvo === alvo).slice(-30);
    const det = lerJson(path.join(ESCALA_DIR, `ultimo-${alvo}.json`));
    const achados = {};
    for (const [k, e] of Object.entries(det?.eixos || {})) achados[k] = (e.achados || []).slice(0, 12).map((a) => ({ tipo: a.tipo, arquivo: a.arquivo, linha: a.linha, msg: a.msg, trecho: a.trecho, pena: a.pena }));
    return { alvo, hist, ultimo: hist.at(-1) || null, achados, carga: det?.eixos?.carga?.carga || null };
  });
  return { pesos: cfg.pesos, alvos, rodando: execucoes.filter((e) => e.acao === 'escala-varrer' && e.estado === 'rodando').map((e) => e.tarefa) };
}

// ---------- leitura de corpo ----------
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let tam = 0, estourou = false; const partes = [];
    if (Number(req.headers['content-length'] || 0) > LIMITE_CORPO) estourou = true;
    req.on('data', (d) => {
      tam += d.length;
      if (tam > LIMITE_CORPO) estourou = true;
      if (!estourou) partes.push(d);
    });
    req.on('end', () => {
      if (estourou) return falha(Object.assign(new Error('corpo grande demais (limite 8 KB)'), { code: 413 }));
      const s = Buffer.concat(partes).toString('utf8').trim();
      if (!s) return ok({});
      try { const v = JSON.parse(s); ok(v && typeof v === 'object' ? v : {}); }
      catch { falha(Object.assign(new Error('corpo não é JSON'), { code: 400 })); }
    });
    req.on('error', falha);
  });
}

// ---------- estático ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function servir(res, raiz, rel) {
  const alvo = path.resolve(raiz, '.' + path.sep + rel);
  if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) return json(res, 403, { erro: 'fora da pasta' });
  const tipo = TIPOS[path.extname(alvo)];
  if (!tipo) return json(res, 404, { erro: 'não encontrado' });
  fs.readFile(alvo, (err, buf) => {
    if (err) return json(res, 404, { erro: 'não encontrado' });
    res.writeHead(200, { 'content-type': tipo, 'cache-control': 'no-store' });
    res.end(buf);
  });
}

// ---------- rotas ----------
// criarServidor({ token, rotas }) — `rotas` vem de criarRotasPlanos (injetável nos testes).
export function criarServidor({ token, rotas }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('token da Central ausente ou curto');
  return http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host || '')) return json(res, 403, { erro: 'host não permitido' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);

    if (req.method === 'POST') {
      if (!ORIGENS.has(req.headers.origin || '')) return json(res, 403, { erro: 'origem não permitida' });
      if (!tokenConfere(req.headers['x-central-token'], token)) return json(res, 403, { erro: 'token da Central ausente ou errado' });
      const m = p.match(/^\/api\/acao\/([a-z-]+)$/);
      if (!m) return json(res, 404, { erro: 'ação desconhecida' });
      let corpo;
      try { corpo = await lerCorpo(req); } catch (e) { return json(res, e.code || 400, { erro: e.message }); }
      const id = m[1];
      if (rotas?.temAcao(id)) { const r = await rotas.post(id, corpo); return json(res, r.code, r.corpo); }
      if (id === 'abrir') return abrir(corpo, res);
      if (id === 'fechar-sessao') return fecharSessao(corpo, res);
      if (id === 'responder') return responder(corpo, res);
      if (id === 'perguntar') return perguntar(corpo, res);
      if (id === 'salvar-layout') return salvarLayout(corpo, res);
      if (id === 'revisar') return revisar(corpo, res);
      const fab = Object.hasOwn(ACOES, id) ? ACOES[id] : null;
      if (!fab) return json(res, 404, { erro: 'ação desconhecida' });
      const ja = rodando(id);
      if (ja) return json(res, 409, { erro: 'essa ação já está rodando', execucao: ja.id });
      const plano = fab(corpo);
      if (plano.erro) return json(res, plano.code || 400, { erro: plano.erro });
      const e = rodar(id, plano.cmd, plano.args, plano.t, plano.cwd);
      if (plano.tarefa) e.tarefa = plano.tarefa;
      return json(res, 202, { execucao: e.id, acao: id });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { erro: 'método não permitido' });

    if (p === '/' || p === '/index.html') return servirPagina(res, token);
    if (p.startsWith('/fonts/')) return servir(res, path.join(AQUI, 'fonts'), p.slice('/fonts/'.length));
    if (p === '/cerebro' ) { res.writeHead(302, { location: '/cerebro/' }); return res.end(); }
    if (p.startsWith('/cerebro/')) {
      const rel = p.slice('/cerebro/'.length) || 'cerebro.html';
      return servir(res, CEREBRO, rel);
    }
    if (p === '/api/retrato') return json(res, 200, await retrato());
    if (p === '/api/saude') return json(res, 200, lerJson(`${CL}/limpeza/saude.json`) ?? { ausente: true });
    if (p === '/api/contexto') return json(res, 200, lerJson(`${CL}/limpeza/contexto.json`) ?? { ausente: true });
    if (p === '/api/limpeza') {
      const dir = `${CL}/limpeza/relatorios`;
      let arqs = [];
      try { arqs = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })); } catch {}
      if (!arqs.length) return json(res, 200, { ausente: true });
      arqs.sort((a, b) => b.t - a.t);
      const caminho = path.join(dir, arqs[0].f);
      const texto = fs.readFileSync(caminho, 'utf8');
      const alertas = texto.split('\n').filter((l) => l.startsWith('- ⚠️')).map((l) => l.replace(/^- ⚠️\s*/, '').trim());
      return json(res, 200, { arquivo: arqs[0].f, caminho, em: arqs[0].t, alertas, titulo: (texto.match(/^# (.+)$/m) || [])[1] || arqs[0].f });
    }
    if (p === '/api/deck') return json(res, 200, { deck: ultimasLinhas(`${CL}/deck/runs.log`, 10), limpeza: ultimasLinhas(`${CL}/limpeza/runs.log`, 10) });
    if (p === '/api/execucoes') return json(res, 200, { execucoes });
    if (p === '/api/nos') return json(res, 200, nos());
    if (p === '/api/anel') return json(res, 200, anel());
    if (p === '/api/busca') return json(res, 200, busca(url.searchParams.get('q')));
    if (p === '/api/hoje') { if (!cache.dado) await retrato(); return json(res, 200, hoje()); }
    if (p === '/api/respostas') return json(res, 200, respostas());
    if (p === '/api/capacidade') return json(res, 200, capacidade());
    if (p === '/api/modo-build') return json(res, 200, await modoBuild());
    // Leituras privadas (estado, layout, revisão, notícias, fechamento): mesma trava de origem das ações.
    const PRIVADAS = /^\/api\/(estado\/|layout$|revisao(\/|$)|noticias$|fechamento$|gemini$)/;
    if (PRIVADAS.test(p) && ((req.headers.origin && !ORIGENS.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site')) return json(res, 403, { erro: 'origem não permitida' });
    if (p === '/api/layout') return json(res, 200, lerLayout());
    if (p === '/api/revisao') { const itens = itensRevisao(); return json(res, 200, { itens, pendentes: itens.filter((i) => !i.decisao).length }); }
    if (p.startsWith('/api/revisao/')) {
      const m = p.match(/^\/api\/revisao\/([0-9a-f]{16})$/);
      const it = m && itemRevisao(m[1]);
      return it ? json(res, 200, it) : json(res, 404, { erro: 'item não encontrado' });
    }
    if (p === '/api/noticias') return json(res, 200, noticias());
    if (p === '/api/escala') return json(res, 200, escala());
    if (p === '/api/fechamento') return json(res, 200, fechamento());
    if (p === '/api/gemini') return json(res, 200, { existe: fs.existsSync(GEMINI) });
    if (p.startsWith('/api/estado/')) {
      const m = p.match(/^\/api\/estado\/([a-z-]{1,40})$/);
      if (!m || !Object.hasOwn(ESTADOS, m[1])) return json(res, 404, { erro: 'estado desconhecido' });
      return json(res, 200, lerEstado(m[1]));
    }
    if (rotas?.temGet(p)) {
      if ((req.headers.origin && !ORIGENS.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { erro: 'origem não permitida' });
      const r = await rotas.get(p, url.searchParams);
      return json(res, r.code, r.corpo);
    }
    return json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    json(res, 500, { erro: e.message });
  }
  });
}

export const CONFIG = { HOST, PORT, HOME, CL, AQUI };

// Pastas das rotas de planos: planos e registros em ~/.claude/agentic-os/planos; papéis, pesos e históricos ao lado do server.
export const DIRS_PLANOS = { planos: `${BASE}/planos`, dados: AQUI, home: HOME, lideres: `${BASE}/lideres`, verificadores: `${BASE}/verificadores` };
// Raízes onde os repos dos itens de plano podem ficar (CENTRAL_RAIZES="~/Projects:~/code"). Padrão: ~/Projects.
export const RAIZES_REPOS = (process.env.CENTRAL_RAIZES || '~/Projects').split(':').map((x) => x.trim()).filter(Boolean);

const ehPrincipal = (() => { try { return fs.realpathSync(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (ehPrincipal) {
  const token = randomBytes(32).toString('hex');
  try { gravarToken(TOKEN_ARQ, token); } catch (e) { console.error(`não gravei o token em ${TOKEN_ARQ}: ${e.message}`); }
  const mod = await carregarModulos();
  const faltam = Object.entries(mod).filter(([, v]) => !v).map(([k]) => k);
  if (faltam.length) console.error(`módulos ainda ausentes (rotas respondem 503): ${faltam.join(', ')}`);
  // os processos das rotas novas (claude e o conferidor de push) herdam o mesmo PATH/HOME das ações antigas
  const spawnCentral = (cmd, args, o = {}) => spawn(cmd, args, { cwd: HOME, ...o, env: ENV });
  // o claude --cloud exige terminal: roda pelo helper de pseudo-terminal, argv sem shell
  const PTY = fileURLToPath(new URL('./lancar/pty.py', import.meta.url));
  const spawnPty = (cmd, args, o = {}) => spawnCentral('python3', ['-I', PTY, '120', '--', cmd, ...args], o);
  const marcador = fileURLToPath(new URL('./planos/marcar.mjs', import.meta.url));
  const rotas = criarRotasPlanos({ mod, fs, spawn: spawnCentral, spawnPty, marcador, dirs: DIRS_PLANOS, raizes: RAIZES_REPOS, terminal: process.env.CENTRAL_TERMINAL || 'konsole' });
  // disparo automático dos itens que destravam, só em planos aprovados por você (a cada 30 s)
  setInterval(() => { rotas.tick().then((f) => f.length && console.log(`disparo automático: ${JSON.stringify(f).slice(0, 300)}`)).catch(() => {}); }, 30_000).unref();
  criarServidor({ token, rotas }).listen(PORT, HOST, () => console.log(`Central em http://${HOST}:${PORT}`));
}
