#!/usr/bin/env node
// Segundo cérebro visual — indexador.
// SOMENTE LEITURA nas pastas indexadas. Escreve apenas indice.json e indice.js
// ao lado deste script. Sem dependências npm, sem rede.
// Uso: node ~/.claude/agentic-os/cerebro/indexar.mjs
// Pastas (todas opcionais): AGENTIC_OS_PROJETOS (padrão ~/Projects) e CEREBRO_VAULT ou NOTAS_DIR (notas em markdown).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const T0 = Date.now();
const HOME = os.homedir();
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const LIMITE_TOTAL = 15000;
const PREVIEW_MAX = 300;
const LER_MAX = 64 * 1024; // lê no máx. 64 KB de cada arquivo

const til = (p) => (p ? p.replace(/^~(?=[\\/]|$)/, HOME) : p); // ~/x ou ~\x (Windows)
const ORIGENS = {
  projetos: til(process.env.AGENTIC_OS_PROJETOS) || path.join(HOME, 'Projects'),
  notas: til(process.env.CEREBRO_VAULT || process.env.NOTAS_DIR) || null,
  skills: path.join(HOME, '.claude', 'skills'),
  // memória de todo projeto do Claude Code: ~/.claude/projects/<pasta>/memory
  memoria: path.join(HOME, '.claude', 'projects'),
  limpeza: path.join(HOME, '.claude', 'limpeza', 'relatorios'),
  sessao: path.join(HOME, '.claude', 'doc-de-sessao'),
  rotinas: path.join(HOME, '.config', 'systemd', 'user'),
  nucleo: path.join(HOME, '.claude', 'CLAUDE.md'),
};

const PULAR_DIR = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.expo', '.turbo', 'coverage',
  '__pycache__', '.venv', 'venv', '.cache', '.obsidian', '.trash', 'ios', 'android',
  'Pods', '.pytest_cache', '.mypy_cache', 'out', 'brag-output',
]);

// Nada de segredo: nem conteúdo nem caminho.
// separador "/" ou "\\" (Windows) no .config
const SENSIVEL = /(secret|token|\.env|credential|senha|password|passwd|\.pem$|\.key$|id_rsa|\.config[\\/])/i;
const ehSensivel = (p) => SENSIVEL.test(p);

const itens = [];
const avisos = [];
let cortados = 0;

// ---------- utilitários ----------
function lerInicio(arq) {
  try {
    const fd = fs.openSync(arq, 'r');
    const buf = Buffer.alloc(LER_MAX);
    const n = fs.readSync(fd, buf, 0, LER_MAX, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; }
}

function frontmatter(txt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(txt);
  if (!m) return { fm: {}, corpo: txt };
  const fm = {};
  for (const linha of m[1].split(/\r?\n/)) {
    const k = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(linha);
    if (k && !(k[1] in fm)) {
      let v = k[2].trim().replace(/^["']|["']$/g, '');
      if (v && v !== '|' && v !== '>') fm[k[1]] = v;
    }
  }
  return { fm, corpo: txt.slice(m[0].length) };
}

function primeiroTitulo(corpo) {
  const m = /^#{1,3}\s+(.+)$/m.exec(corpo);
  return m ? m[1].trim().replace(/[*_`]/g, '') : '';
}

function resumo(corpo) {
  const t = corpo
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/m, '') // tira o 1º heading (já vira título)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[#>*_`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.slice(0, PREVIEW_MAX);
}

function linksDe(corpo) {
  const set = new Set();
  for (const m of corpo.matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)) set.add(m[1].trim());
  // links markdown para .md locais (padrão do MEMORY.md)
  for (const m of corpo.matchAll(/\]\(([^)\s#]+\.md)\)/g)) {
    if (!/^https?:/.test(m[1])) set.add(path.basename(m[1], '.md'));
  }
  return [...set].slice(0, 200);
}

function tipoDe(arq) {
  const ext = path.extname(arq).toLowerCase();
  if (ext === '.md' || ext === '.mdx') return 'nota';
  if (ext === '.sql') return 'migration';
  if (ext === '.json') return 'config';
  return ext.slice(1) || 'arquivo';
}

function add(item) {
  if (itens.length >= LIMITE_TOTAL) { cortados++; return false; }
  itens.push(item);
  return true;
}

function entradaArquivo(arq, area, raiz, extra = {}) {
  if (ehSensivel(arq)) return;
  let st;
  try { st = fs.statSync(arq); } catch { return; }
  const rel = path.relative(raiz, arq);
  const pasta = path.dirname(rel) === '.' ? '' : path.dirname(rel);
  const item = {
    p: arq, a: area, d: pasta, t: path.basename(arq), k: tipoDe(arq),
    m: Math.round(st.mtimeMs / 1000), s: st.size,
  };
  if (/\.mdx?$/i.test(arq)) {
    const txt = lerInicio(arq);
    const { fm, corpo } = frontmatter(txt);
    item.t = fm.name || fm.title || primeiroTitulo(corpo) || path.basename(arq).replace(/\.mdx?$/i, '');
    const desc = fm.description || '';
    item.x = (desc ? desc + ' — ' : '') + resumo(corpo);
    item.x = item.x.slice(0, PREVIEW_MAX);
    if (fm.type) item.k = fm.type;
    const ls = linksDe(corpo);
    if (ls.length) item.l = ls;
  } else if (path.basename(arq) === 'package.json') {
    try {
      const pj = JSON.parse(lerInicio(arq));
      item.t = (pj.name || path.basename(path.dirname(arq))) + ' · package.json';
      item.x = (pj.description || '') + (pj.scripts ? ' scripts: ' + Object.keys(pj.scripts).slice(0, 15).join(', ') : '');
      item.x = item.x.trim().slice(0, PREVIEW_MAX);
    } catch { /* json quebrado: só caminho */ }
  } else if (/\.sql$/i.test(arq)) {
    item.x = lerInicio(arq).replace(/\s+/g, ' ').slice(0, PREVIEW_MAX);
  }
  Object.assign(item, extra);
  add(item);
}

function walk(dir, profundidade, max, visita) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (ehSensivel(full)) continue;
    if (e.isDirectory()) { // isDirectory() não segue symlink
      if (PULAR_DIR.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.claude' && e.name !== '.github') continue;
      if (profundidade < max) walk(full, profundidade + 1, max, visita);
    } else if (e.isFile()) {
      visita(full, profundidade);
    }
  }
}

const contagem = {};
const conta = (a, n = 1) => { contagem[a] = (contagem[a] || 0) + n; };
const tempos = {};
function etapa(nome, fn) { const t = Date.now(); const antes = itens.length; fn(); tempos[nome] = Date.now() - t; conta(nome, itens.length - antes); }

// ---------- 1) memórias (primeiro: são pequenas e importantes) ----------
etapa('memoria', () => {
  let pastas = [];
  try { pastas = fs.readdirSync(ORIGENS.memoria, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return avisos.push('memória não encontrada'); }
  for (const d of pastas) {
    const raiz = path.join(ORIGENS.memoria, d.name, 'memory');
    if (!fs.existsSync(raiz)) continue; // só a memória; os transcripts .jsonl ficam fora
    walk(raiz, 1, 2, (f) => { if (/\.md$/i.test(f)) entradaArquivo(f, 'memoria', raiz); });
  }
});

// ---------- 2) skills ----------
etapa('skills', () => {
  const raiz = ORIGENS.skills;
  let ents = [];
  try { ents = fs.readdirSync(raiz, { withFileTypes: true }); } catch { return avisos.push('skills não encontradas'); }
  for (const e of ents) {
    const dir = path.join(raiz, e.name);
    const sk = path.join(dir, 'SKILL.md');
    if (ehSensivel(dir) || !fs.existsSync(sk)) continue;
    let st; try { st = fs.statSync(sk); } catch { continue; }
    let txt = ''; try { txt = fs.readFileSync(sk, 'utf8'); } catch {}
    const { fm, corpo } = frontmatter(txt);
    const linhas = txt ? txt.split('\n').length : 0;
    add({
      p: sk, a: 'skills', d: e.name, t: fm.name || e.name, k: 'skill',
      m: Math.round(st.mtimeMs / 1000), s: st.size, n: linhas,
      x: ((fm.description || resumo(corpo)) + ` (${linhas} linhas)`).slice(0, PREVIEW_MAX),
    });
  }
});

// ---------- 3) artefatos recentes ----------
etapa('artefatos', () => {
  for (const [nome, raiz] of [['limpeza', ORIGENS.limpeza], ['doc-de-sessao', ORIGENS.sessao]]) {
    if (!fs.existsSync(raiz)) { avisos.push(`${raiz} não encontrado`); continue; }
    walk(raiz, 1, 2, (f) => {
      if (/\.(md|txt|json|html)$/i.test(f)) entradaArquivo(f, 'artefatos', path.dirname(raiz), { g: nome });
    });
  }
});

// ---------- 3b) núcleo: ~/.claude/CLAUDE.md (centro da vista Anéis) ----------
etapa('nucleo', () => {
  const f = ORIGENS.nucleo;
  if (!fs.existsSync(f)) return avisos.push('CLAUDE.md global não encontrado');
  entradaArquivo(f, 'nucleo', path.dirname(f), { k: 'claude-md' });
});

// ---------- 3c) rotinas: timers do systemd do usuário ----------
// Lê só Description/agenda do .timer e o nome do script do .service.
// Nada de Environment=, nada de conteúdo do script (pode ter segredo).
etapa('rotinas', () => {
  const raiz = ORIGENS.rotinas;
  let ents = [];
  try { ents = fs.readdirSync(raiz).filter((n) => n.endsWith('.timer')); } catch { return avisos.push('timers do systemd não encontrados'); }
  const campo = (txt, k) => { const m = new RegExp('^\\s*' + k + '\\s*=\\s*(.+)$', 'm').exec(txt); return m ? m[1].trim() : ''; };
  for (const nome of ents) {
    const f = path.join(raiz, nome);
    let st; try { st = fs.statSync(f); } catch { continue; }
    const timer = lerInicio(f);
    const unit = campo(timer, 'Unit') || nome.replace(/\.timer$/, '.service');
    const svc = lerInicio(path.join(raiz, unit));
    const desc = campo(timer, 'Description') || campo(svc, 'Description');
    const quando = campo(timer, 'OnCalendar') || (campo(timer, 'OnUnitActiveSec') ? 'a cada ' + campo(timer, 'OnUnitActiveSec') : '');
    const exec = campo(svc, 'ExecStart').split(/\s+/).filter((x) => /[/.]/.test(x) && !/^-/.test(x)).pop() || '';
    const script = exec && !ehSensivel(exec) ? path.basename(exec) : '';
    add({
      p: f, a: 'rotinas', d: '', t: nome.replace(/\.timer$/, ''), k: 'rotina',
      m: Math.round(st.mtimeMs / 1000), s: st.size,
      x: [desc, quando && 'quando: ' + quando, script && 'roda: ' + script].filter(Boolean).join(' · ').slice(0, PREVIEW_MAX),
    });
  }
});

// ---------- 4) pasta de notas (opcional) ----------
etapa('notas', () => {
  const raiz = ORIGENS.notas;
  if (!raiz) return; // sem pasta de notas configurada
  if (!fs.existsSync(raiz)) return avisos.push('pasta de notas não encontrada');
  walk(raiz, 1, 12, (f) => { if (/\.md$/i.test(f)) entradaArquivo(f, 'notas', raiz); });
});

// ---------- 5) projetos (~/Projects) ----------
const bancadas = [];
etapa('projetos', () => {
  const raiz = ORIGENS.projetos;
  let ents = [];
  try { ents = fs.readdirSync(raiz, { withFileTypes: true }); } catch { return avisos.push(`${raiz} não encontrado`); }
  // bancadas/* e wt-* viram um nó resumido
  try {
    for (const b of fs.readdirSync(path.join(raiz, 'bancadas'), { withFileTypes: true })) {
      if (b.isDirectory() || b.isSymbolicLink()) bancadas.push('bancadas/' + b.name);
    }
  } catch {}
  for (const e of ents) if (e.name.startsWith('wt-') && (e.isDirectory() || e.isSymbolicLink())) bancadas.push(e.name);

  const MAX_PROF = 5; // ~/Projects/<projeto>/a/b/c/arquivo (docs ficam fundos; continua longe do limite)
  const visita = (f, prof) => {
    const nome = path.basename(f);
    const rel = path.relative(raiz, f);
    const partes = rel.split(path.sep);
    if (/\.mdx?$/i.test(nome)) return entradaArquivo(f, 'projetos', raiz, { j: partes.length > 1 ? partes[0] : '(raiz)' });
    // .json de config só na raiz do projeto (ou subprojeto direto)
    if (/\.json$/i.test(nome) && partes.length <= 3 && /^(package|tsconfig|app|eas|turbo|components|vercel|wrangler|manifest|composer|lerna|nx)\.json$/i.test(nome)) {
      return entradaArquivo(f, 'projetos', raiz, { j: partes.length > 1 ? partes[0] : '(raiz)' });
    }
    if (/\.sql$/i.test(nome) && /migrat/i.test(rel)) return entradaArquivo(f, 'projetos', raiz, { j: partes[0] });
  };
  for (const e of ents) {
    const full = path.join(raiz, e.name);
    if (e.name.startsWith('wt-') || e.name === 'bancadas' || e.name.startsWith('.') || ehSensivel(full)) continue;
    if (PULAR_DIR.has(e.name)) continue;
    if (e.isDirectory()) walk(full, 2, MAX_PROF, visita);
    else if (e.isFile()) visita(full, 1);
  }
});

// nó resumido de bancadas/worktrees (não conta no limite de forma relevante)
itens.push({
  p: ORIGENS.projetos, a: 'projetos', d: '', j: '(bancadas/worktrees)', k: 'resumo', m: Math.round(Date.now() / 1000), s: 0,
  t: `${bancadas.length} bancadas/worktrees (não indexadas)`,
  x: 'Cópias de trabalho duplicadas, fora do índice: ' + bancadas.slice(0, 40).join(', ') + (bancadas.length > 40 ? ` … +${bancadas.length - 40}` : ''),
});

// ---------- resolver links em ids ----------
const porNome = new Map();
itens.forEach((it, i) => {
  if (it.a !== 'notas' && it.a !== 'memoria') return;
  const base = path.basename(it.p).replace(/\.md$/i, '').toLowerCase();
  if (!porNome.has(base)) porNome.set(base, i);
  if (it.t && !porNome.has(it.t.toLowerCase())) porNome.set(it.t.toLowerCase(), i);
});
let arestas = 0, quebrados = 0;
itens.forEach((it) => {
  if (!it.l) return;
  const ids = [];
  for (const alvo of it.l) {
    const j = porNome.get(path.basename(alvo).toLowerCase());
    if (j !== undefined) ids.push(j); else quebrados++;
  }
  it.l = [...new Set(ids)];
  if (!it.l.length) delete it.l; else arestas += it.l.length;
});

const ms = Date.now() - T0;
const indice = {
  gerado: new Date().toISOString(),
  ms, total: itens.length, cortados, arestas, linksQuebrados: quebrados,
  porArea: contagem, tempos, avisos,
  campos: 'p=caminho a=área d=pasta t=título k=tipo m=mtime(s) s=bytes x=preview l=links(ids) j=projeto g=grupo n=linhas',
  itens,
};
const json = JSON.stringify(indice);
fs.writeFileSync(path.join(AQUI, 'indice.json'), json);
fs.writeFileSync(path.join(AQUI, 'indice.js'), 'window.INDICE = ' + json + ';\n');

const mb = (Buffer.byteLength(json) / 1048576).toFixed(2);
console.log(`índice: ${itens.length} itens · ${arestas} links · ${mb} MB · ${ms} ms`);
console.log('por área:', JSON.stringify(contagem));
console.log('tempo por etapa (ms):', JSON.stringify(tempos));
console.log(`bancadas/worktrees resumidas: ${bancadas.length}`);
if (cortados) console.log(`ATENÇÃO: ${cortados} itens cortados pelo limite de ${LIMITE_TOTAL}`);
if (quebrados) console.log(`links [[...]] sem destino: ${quebrados}`);
if (avisos.length) console.log('avisos:', avisos.join('; '));
