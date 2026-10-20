// Nota de escalabilidade (docs/arquitetura.md) — núcleo da varredura estática.
// Node puro, sem dependências. Só lê arquivos; nunca escreve no repo varrido.
// Heurística por contagem: cada achado traz arquivo:linha e o trecho, para conferir à mão.
import fs from 'node:fs';
import path from 'node:path';

const EXT_JS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXT_PY = new Set(['.py']);
const PULAR_DIR = /(^|\/)(node_modules|\.git|\.next|dist|build|coverage|\.venv|venv|__pycache__|public|drizzle)(\/|$)/;
const EH_TESTE = /(^|\/)(tests?|__tests__|e2e|evals|cenarios|fixtures)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;

// ---------- leitura ----------
export function listarArquivos(raiz, incluir = null) {
  const out = [];
  const anda = (dir) => {
    let ds = []; try { ds = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ds) {
      const abs = path.join(dir, d.name);
      const rel = path.relative(raiz, abs).split(path.sep).join('/');
      if (d.isDirectory()) { if (!PULAR_DIR.test(rel + '/')) anda(abs); continue; }
      const ext = path.extname(d.name);
      if (!EXT_JS.has(ext) && !EXT_PY.has(ext)) continue;
      if (d.name.endsWith('.d.ts')) continue;
      // testes entram sempre: servem para saber quem está testado, nunca geram achado
      if (incluir && !EH_TESTE.test(rel) && !incluir.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
      out.push({ abs, rel, ext, py: EXT_PY.has(ext), teste: EH_TESTE.test(rel) });
    }
  };
  anda(raiz);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Troca comentários por espaço mantendo as quebras de linha (os números de linha continuam valendo).
export function semComentarios(src, py) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (q.length === 3 ? src.startsWith(q, i) : c === q) { if (q.length === 3) { out += q.slice(1); i += 3; } else i++; q = null; continue; }
      i++; continue;
    }
    if (py) {
      if ((c === '"' || c === "'") && src.startsWith(c.repeat(3), i)) { q = c.repeat(3); out += q; i += 3; continue; }
      if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    } else {
      if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
      if (c === '/' && d === '*') { i += 2; out += '  '; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    }
    out += c; i++;
  }
  return out;
}

const linhaDe = (src, idx) => src.slice(0, idx).split('\n').length;
const trecho = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 140);

// Strings que parecem SQL (literal com SELECT … FROM), com a linha onde começam.
export function stringsSql(src, py) {
  const res = [];
  const re = py ? /("""|'''|"|')([\s\S]*?)\1/g : /(`|"|')((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const s = m[2];
    // janela: a string e o que vem logo depois (SQL partido em strings vizinhas, f-string, .where encadeado)
    if (/\bselect\b[\s\S]+?\bfrom\b/i.test(s) && s.length < 6000) res.push({ sql: s, linha: linhaDe(src, m.index), fstring: py ? /[fF][rR]?$|[rR][fF]$/.test(src.slice(Math.max(0, m.index - 2), m.index)) : m[1] === '`', janela: m[0] + src.slice(m.index + m[0].length, m.index + m[0].length + 400).split(/[;)]|\n\s*\n/)[0] });
  }
  return res;
}

// ---------- laços: em que linhas estamos dentro de um for/while/forEach ----------
const LACO_JS = /\bfor\s*(await\s*)?\(|\bwhile\s*\(|\.(forEach|map|flatMap|reduce)\(\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/;
export function linhasEmLaco(src, py) {
  const linhas = src.split('\n');
  const dentro = new Array(linhas.length).fill(false);
  if (py) {
    const pilha = []; // indentações dos laços abertos
    linhas.forEach((l, n) => {
      if (!l.trim()) { dentro[n] = pilha.length > 0; return; }
      const ind = l.length - l.trimStart().length;
      while (pilha.length && ind <= pilha[pilha.length - 1]) pilha.pop();
      dentro[n] = pilha.length > 0;
      if (/^\s*(async\s+)?(for|while)\b.*:\s*$/.test(l) || /\[[^\]]*\bfor\b[^\]]*\bin\b/.test(l) && /await/.test(l)) {
        if (/:\s*$/.test(l)) pilha.push(ind); else dentro[n] = true; // compreensão com await na mesma linha
      }
    });
    return dentro;
  }
  const pilha = []; // true = chave aberta por laço
  let laçoPendente = false, prof = 0;
  linhas.forEach((l, n) => {
    dentro[n] = pilha.some(Boolean) || laçoPendente;
    if (LACO_JS.test(l)) laçoPendente = true;
    let q = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(') prof++; else if (c === ')') prof = Math.max(0, prof - 1);
      else if (c === '{') { pilha.push(laçoPendente); laçoPendente = false; }
      else if (c === '}') pilha.pop();
    }
    // laço de uma linha só, sem chave: `for (...) await x;`
    if (laçoPendente && /;\s*$/.test(l) && !/\{\s*$/.test(l)) { dentro[n] = true; laçoPendente = false; }
  });
  return dentro;
}

// profundidade de chave por linha (0 = topo do módulo), só JS
function profundidades(src) {
  const prof = []; let d = 0, q = null;
  for (const l of src.split('\n')) {
    prof.push(d);
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{' || c === '(' || c === '[') d++; else if (c === '}' || c === ')' || c === ']') d = Math.max(0, d - 1);
    }
    if (q !== '`') q = null;
  }
  return prof;
}

// ---------- schema: tabelas, colunas indexadas, tabelas com tenant ----------
const nomeT = (s) => String(s).replace(/"/g, '').split('.').pop().toLowerCase();
export function lerMigrations(arquivosSql) {
  const indices = new Map(); // tabela -> Set(colunas presentes em algum índice/PK/UNIQUE)
  const comTenant = new Set(), tabelas = new Set(), colunas = new Map();
  const add = (t, cols) => { t = nomeT(t); if (!indices.has(t)) indices.set(t, new Set()); for (const c of cols) indices.get(t).add(nomeT(c.trim().split(/\s+/)[0].replace(/[()]/g, ''))); };
  for (const sql0 of arquivosSql) {
    const sql = sql0.replace(/--[^\n]*/g, ' ');
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(([\s\S]*?)\)\s*;/gi)) {
      const t = nomeT(m[1]); tabelas.add(t); if (!indices.has(t)) indices.set(t, new Set()); if (!colunas.has(t)) colunas.set(t, new Set());
      for (const linha of m[2].split(/,\s*\n/)) {
        const l = linha.trim();
        const col = l.match(/^"?(\w+)"?\s+\w/)?.[1];
        if (col && !/^(constraint|primary|unique|foreign|check)$/i.test(col)) colunas.get(t).add(col.toLowerCase());
        if (col && /^tenant_id$/i.test(col)) comTenant.add(t);
        if (col && /\b(primary\s+key|unique)\b/i.test(l) && !/^(constraint|primary|unique|foreign|check)\b/i.test(l)) add(t, [col]);
        const grp = l.match(/\b(?:primary\s+key|unique)\s*\(([^)]+)\)/i);
        if (grp) add(t, grp[1].split(','));
      }
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w."]+)([\s\S]*?);/gi)) {
      const t = nomeT(m[1]);
      if (/add\s+column\s+(if\s+not\s+exists\s+)?"?tenant_id"?/i.test(m[2])) comTenant.add(t);
      for (const g of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)) { if (!colunas.has(t)) colunas.set(t, new Set()); colunas.get(t).add(g[1].toLowerCase()); }
      for (const g of m[2].matchAll(/\b(?:primary\s+key|unique)\s*\(([^)]+)\)/gi)) add(t, g[1].split(','));
    }
    for (const m of sql.matchAll(/create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[\w."]*\s*on\s+(?:only\s+)?([\w."]+)\s*(?:using\s+\w+\s*)?\(([^;]*?)\)\s*(?:include\s*\([^)]*\)\s*)?(?:with\s*\([^)]*\)\s*)?(?:where\s+([^;]*?))?\s*;/gi)) {
      add(m[1], m[2].split(',').map((c) => c.replace(/\b(desc|asc|nulls\s+\w+)\b/gi, '').replace(/^\s*(lower|upper|coalesce)\s*\(/i, '')));
      // índice parcial (… WHERE status = 'pending'): consulta com o mesmo predicado usa o índice
      // só igualdade é seletiva; `<> 'canceled'` ou `IS NOT NULL` cobre quase a tabela e não ajuda a busca
      if (m[3]) add(m[1], [...m[3].matchAll(/"?(\w+)"?\s*(?:=(?!=)|\bin\s*\()/gi)].map((g) => g[1]).filter((c) => !/^(and|or|not|null)$/i.test(c)));
    }
  }
  return { indices, comTenant, tabelas, colunas };
}

// Drizzle: export const x = pgTable('tabela', { prop: tipo('coluna') ... }) + index() no 3º argumento
export function lerDrizzle(src) {
  const vars = new Map(); // var -> { tabela, props: Map(prop->coluna), indexadas:Set }
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable\(\s*["'`](\w+)["'`]\s*,\s*\{/g)) {
    const props = new Map();
    let i = m.index + m[0].length, d = 1;
    const ini = i;
    while (i < src.length && d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; }
    const corpo = src.slice(ini, i - 1);
    for (const p of corpo.matchAll(/^\s*(\w+)\s*:\s*\w+\(\s*["'`](\w+)["'`]/gm)) props.set(p[1], p[2]);
    const idx = new Set();
    for (const p of corpo.matchAll(/^\s*(\w+)\s*:\s*\w+\([^\n]*\.(primaryKey|unique)\(/gm)) idx.add(props.get(p[1]) || p[1]);
    // terceiro argumento: (t) => [index(...).on(t.a, t.b), unique().on(...)]
    let j = i, d2 = 1; while (j < src.length && d2 > 0) { if (src[j] === '(') d2++; else if (src[j] === ')') d2--; j++; }
    for (const on of src.slice(i, j).matchAll(/\.on\(([^)]*)\)/g)) for (const c of on[1].matchAll(/\w+\.(\w+)/g)) idx.add(props.get(c[1]) || c[1]);
    vars.set(m[1], { tabela: m[2], props, indexadas: idx });
  }
  return vars;
}

// ---------- varredura ----------
const DB_JS = /\bawait\s+(?:this\.)?(?:db|tx|trx|sql|pool|client|pg|prisma|knex|repo)\b\s*[.(`]|\bawait\s+[\w.]*\.(?:query|execute|findMany|findFirst|findUnique|select|insert|update|delete)\(/;
const API_JS = /\bawait\s+(?:fetch|axios(?:\.\w+)?|got|ky)\s*\(|\bawait\s+\w*(?:api|sdk|gateway|webhook)\w*\.\w+\(/i;
const LLM_JS = /\.(?:messages\.(?:create|stream)|chat\.completions\.create|responses\.create)\(|\b(?:generateText|streamText|generateObject)\(/;
const DB_PY = /\bawait\s+[\w.]*(?:session|conn|db|pool|cur|cursor|repo)\w*\.(?:execute|fetch|fetchrow|fetchval|fetchall|scalar|scalars|get)\(/;
const API_PY = /\bawait\s+[\w.]*(?:client|http|httpx|api|sdk|session)\w*\.(?:get|post|put|patch|request)\(/i;
const LLM_PY = /\.messages\.(?:create|stream)\(|\.chat\.completions\.create\(|\.ainvoke\(|\.responses\.create\(/;
const TETO = /\bmax_tokens\b|\bmaxTokens\b|\bmax_output_tokens\b|\bmaxOutputTokens\b/;

function achado(eixo, tipo, f, linha, txt, pena, extra = {}) { return { eixo, tipo, arquivo: f.rel, linha, trecho: trecho(txt), pena, ...extra }; }

export function varrerArquivo(f, src0, ctx) {
  const out = [];
  const src = semComentarios(src0, f.py);
  const linhas = src.split('\n');
  const orig = src0.split('\n');
  const laco = linhasEmLaco(src, f.py);
  const pena = (t) => (ctx.cresce(t) ? 8 : 3);

  // --- Dados: N+1 e chamada externa em laço
  linhas.forEach((l, n) => {
    if (!laco[n]) return;
    if ((f.py ? DB_PY : DB_JS).test(l)) out.push(achado('dados', 'n+1', f, n + 1, orig[n], 8, { msg: 'consulta ao banco dentro de laço (N+1)' }));
    else if ((f.py ? API_PY : API_JS).test(l)) out.push(achado('dados', 'api-em-laco', f, n + 1, orig[n], 3, { msg: 'chamada HTTP dentro de laço' }));
    if ((f.py ? LLM_PY : LLM_JS).test(l)) out.push(achado('custo', 'llm-em-laco', f, n + 1, orig[n], 10, { msg: 'chamada de LLM dentro de laço' }));
  });

  // --- Custo: LLM sem teto de tokens (olha a chamada até fechar o parêntese, máx. 40 linhas)
  linhas.forEach((l, n) => {
    const m = (f.py ? LLM_PY : LLM_JS).exec(l);
    if (!m) return;
    const bloco = linhas.slice(n, n + 40).join('\n');
    let d = 0, fim = bloco.length, ini = bloco.indexOf('(', bloco.indexOf(m[0].slice(1, 6)));
    for (let i = Math.max(ini, 0); i < bloco.length; i++) { if (bloco[i] === '(') d++; else if (bloco[i] === ')') { d--; if (d === 0) { fim = i; break; } } }
    const args = bloco.slice(0, fim);
    // chamada que só repassa um objeto montado antes (**kwargs, params) não dá para julgar: não conta
    if (/\(\s*(\*\*\w+|\w+)\s*\)/.test(args.replace(/\s+/g, ' ').slice(args.indexOf('('))) && !/[:=]/.test(args.slice(args.indexOf('(')))) return;
    if (!TETO.test(args)) out.push(achado('custo', 'llm-sem-teto', f, n + 1, orig[n], 20, { msg: 'chamada de LLM sem max_tokens' }));
  });

  // --- Dados: SQL em string
  // constantes de string do módulo (const WHERE_X = `…` / WHERE_X = """…""") entram no lugar da interpolação
  const consts = new Map();
  const reConst = f.py ? /^([A-Za-z_]\w*)\s*(?::\s*\w+)?\s*=\s*[fFrR]{0,2}("""|'''|"|')([\s\S]*?)\2/gm
    : /^\s*(?:export\s+)?const\s+(\w+)\s*(?::\s*\w+)?\s*=\s*(`|"|')((?:\\[\s\S]|(?!\2)[\s\S])*?)\2/gm;
  for (const m of src.matchAll(reConst)) if (m[3].length < 4000) consts.set(m[1], m[3]);
  const reInterp = f.py ? /\{([^{}]+)\}/g : /\$\{([^}]*)\}/g;
  for (const { sql, linha, janela: janela0, fstring } of stringsSql(src, f.py)) {
    let incerta = -1; // posição da 1ª interpolação que não deu para resolver
    const s = !fstring ? sql : sql.replace(reInterp, (todo, expr, pos) => {
      const nome = expr.trim();
      if (consts.has(nome)) return ' ' + consts.get(nome) + ' ';
      // logo depois de operador/IN/LIMIT é só um valor ($1 disfarçado), não um pedaço de SQL
      if (/(=|<>|!=|<|>|\bin\s*\(|,|\(|\blimit|\boffset|\bilike|\blike|\bany\s*\()\s*$/i.test(sql.slice(0, pos))) return '?';
      if (incerta < 0) incerta = pos;
      return '?';
    });
    const janela = s + janela0.slice(sql.length + 2);
    const tab = nomeT(s.match(/\bfrom\s+([\w."]+)/i)?.[1] || '');
    if (!ctx.conhecida(tab) || ctx.naoCresce(tab)) continue;
    // interpolação desconhecida depois do FROM pode ser o WHERE/LIMIT: não dá para julgar filtro nem índice
    const cega = incerta >= 0 && incerta > sql.search(/\bfrom\b/i);
    const agrega = /\bselect\s+(distinct\s+)?(count|sum|avg|max|min|exists|1\b|now|coalesce\(\s*(sum|max|count))/i.test(s) || /\bexists\s*\(/i.test(s);
    if (/\bselect\s+\*/i.test(s)) out.push(achado('dados', 'select-estrela', f, linha, sql, pena(tab), { msg: `SELECT * em ${tab}`, tabela: tab }));
    if (!cega && !agrega && !/\blimit\b/i.test(janela) && !/\bwhere\b/i.test(janela) && !/^\s*\(?\s*select\b[\s\S]*\)\s*$/i.test(s.trim()) && !/^[^s]*\(\s*select/i.test(s.trim())) out.push(achado('dados', 'sem-limit', f, linha, sql, pena(tab), { msg: `SELECT em ${tab} sem WHERE nem LIMIT`, tabela: tab }));
    const where = s.match(/\bwhere\b([\s\S]*?)(\border\s+by\b|\bgroup\s+by\b|\blimit\b|$)/i)?.[1] || '';
    const order = s.match(/\border\s+by\b([\s\S]*?)(\blimit\b|\boffset\b|$)/i)?.[1] || '';
    const cols = new Set();
    for (const c of where.matchAll(/(?:\b\w+\.)?"?(\w+)"?\s*(?:=|<>|!=|>=|<=|>|<|\bin\b|\bilike\b|\blike\b|\bis\b)/gi)) cols.add(c[1].toLowerCase());
    for (const c of order.matchAll(/(?:\b\w+\.)?"?(\w+)"?/g)) if (!/^(asc|desc|nulls|first|last)$/i.test(c[1])) cols.add(c[1].toLowerCase());
    const validas = [...cols].filter((c) => !/^\d|^(and|or|not|null|true|false|now|lower|upper|coalesce|any)$/.test(c) && ctx.coluna(tab, c));
    // basta uma coluna indexada no filtro para o Postgres não varrer a tabela inteira
    if (!cega && validas.length && validas.every((c) => ctx.semIndice(tab, c))) out.push(achado('dados', 'sem-indice', f, linha, sql, pena(tab), { msg: `${tab}: nenhuma coluna do filtro tem índice (${validas.join(', ')})`, tabela: tab }));
  }

  // --- Dados: Drizzle (select().from(x) sem where/limit; where/orderBy em coluna sem índice)
  if (!f.py) {
    for (const m of src.matchAll(/\.select\([^)]*\)\s*\.from\(\s*(\w+)\s*\)/g)) {
      const fim = src.indexOf(';', m.index); const stmt = src.slice(m.index, fim < 0 ? m.index + 2000 : Math.min(fim, m.index + 3000));
      const v = ctx.drizzle.get(m[1]); if (!v || ctx.naoCresce(v.tabela)) continue;
      const linha = linhaDe(src, m.index);
      const agrega = /\b(count|sum|avg|max|min)\s*\(/.test(src.slice(m.index, m.index + m[0].length));
      if (!agrega && !/\.(where|limit)\(/.test(stmt)) out.push(achado('dados', 'sem-limit', f, linha, orig[linha - 1], pena(v.tabela), { msg: `select de ${v.tabela} sem where nem limit`, tabela: v.tabela }));
      const usados = new Set();
      for (const c of stmt.matchAll(new RegExp(`\\b${m[1]}\\.(\\w+)`, 'g'))) usados.add(c[1]);
      const filtro = (stmt.match(/\.(where|orderBy)\([\s\S]*$/) || [''])[0];
      const cols = [...usados].filter((p) => new RegExp(`\\b${m[1]}\\.${p}\\b`).test(filtro)).map((p) => v.props.get(p) || p.replace(/[A-Z]/g, (x) => '_' + x.toLowerCase()));
      if (cols.length && cols.every((c) => !v.indexadas.has(c) && ctx.semIndice(v.tabela, c))) out.push(achado('dados', 'sem-indice', f, linha, orig[linha - 1], pena(v.tabela), { msg: `${v.tabela}: nenhuma coluna do filtro tem índice (${cols.join(', ')})`, tabela: v.tabela }));
    }
    for (const m of src.matchAll(/\.query\.(\w+)\.findMany\(\s*(\{)?/g)) {
      const v = ctx.drizzle.get(m[1]); if (ctx.naoCresce(v?.tabela || m[1])) continue; const linha = linhaDe(src, m.index);
      const arg = src.slice(m.index, m.index + 1200).split(/\)\s*;/)[0];
      if (!/\b(where|limit)\s*:/.test(arg)) out.push(achado('dados', 'sem-limit', f, linha, orig[linha - 1], pena(v?.tabela || m[1]), { msg: `findMany de ${v?.tabela || m[1]} sem where nem limit`, tabela: v?.tabela }));
    }
  }

  // --- Estado e infra: estado na memória do processo e escrita em disco local
  // módulo de navegador ('use client' / hook use-*) guarda estado no aparelho, não na réplica
  const doNavegador = /^\s*["']use client["']/.test(src0) || /(^|\/)use-[\w-]+\.tsx?$/.test(f.rel);
  if (doNavegador) { /* nada */ } else if (f.py) {
    orig.forEach((l, n) => {
      const m = linhas[n].match(/^(\w+)\s*(?::\s*[^=]+)?=\s*(\{\}|\[\]|dict\(\)|set\(\)|defaultdict\(|OrderedDict\(|TTLCache\(|LRUCache\(|deque\()/);
      if (m && m[1] !== m[1].toUpperCase()) out.push(achado('estado', 'memoria', f, n + 1, l, 5, { msg: `estado global mutável "${m[1]}" na memória do processo` }));
      if (/\bopen\([^)]*,\s*["'](w|a|wb|ab)["']/.test(linhas[n]) && !/tmp|tempfile/i.test(linhas[n])) out.push(achado('estado', 'disco', f, n + 1, l, 5, { msg: 'grava arquivo no disco local do container' }));
    });
  } else {
    const prof = profundidades(src);
    linhas.forEach((l, n) => {
      if (prof[n] === 0) {
        const m = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*new\s+(Map|Set|WeakMap|LRUCache|LRU)\s*(?:<[^>]*>)?\(\s*(\[)?/);
        const literal = m && (m[3] || /\(\s*$/.test(l) && /^\s*\[/.test(linhas[n + 1] || ''));
        if (m && !literal && m[1] !== m[1].toUpperCase()) out.push(achado('estado', 'memoria', f, n + 1, orig[n], 5, { msg: `${m[2]} "${m[1]}" no topo do módulo: some em outra réplica` }));
        const k = l.match(/^\s*let\s+(\w*(?:cache|store|sess|fila|queue|pend|memo|registry|token)\w*)\s*(?::[^=]+)?=/i);
        if (k) out.push(achado('estado', 'memoria', f, n + 1, orig[n], 5, { msg: `variável mutável "${k[1]}" no topo do módulo` }));
        if (/^\s*setInterval\(/.test(l)) out.push(achado('estado', 'timer', f, n + 1, orig[n], 5, { msg: 'setInterval no topo do módulo: roda em cada réplica' }));
      }
      if (/\bfs(?:\/promises)?\.\s*(?:writeFile|appendFile|createWriteStream|writeFileSync|appendFileSync)\s*\(|\b(?:writeFile|appendFile|createWriteStream)(?:Sync)?\(/.test(l) && !/tmp|tmpdir/i.test(l)) out.push(achado('estado', 'disco', f, n + 1, orig[n], 5, { msg: 'grava arquivo no disco local do container' }));
    });
  }

  // --- Manutenção: arquivo grande
  const total = orig.length;
  if (!f.teste && total > ctx.alvos.linhasPorArquivo) out.push(achado('manutencao', 'arquivo-grande', f, 1, `${total} linhas`, 5, { msg: `${total} linhas (alvo ${ctx.alvos.linhasPorArquivo})` }));
  return out;
}

// ---------- imports: ciclo e módulo muito importado sem teste ----------
export function grafoImports(arquivos, ler, aliasRaiz) {
  const porRel = new Map(arquivos.map((f) => [f.rel, f]));
  const resolve = (de, esp, py) => {
    const cands = [];
    if (py) {
      let base;
      if (esp.startsWith('.')) { const pts = esp.match(/^\.+/)[0].length; base = path.posix.join(path.posix.dirname(de), ...Array(pts - 1).fill('..'), esp.slice(pts).replace(/\./g, '/')); }
      else base = (aliasRaiz.py ? aliasRaiz.py + '/' : '') + esp.replace(/\./g, '/');
      cands.push(base + '.py', base + '/__init__.py');
    } else {
      let base;
      if (esp.startsWith('.')) base = path.posix.join(path.posix.dirname(de), esp);
      else if (esp.startsWith('@/')) base = aliasRaiz.js + '/' + esp.slice(2);
      else return null;
      for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) cands.push(base + e);
    }
    return cands.find((c) => porRel.has(c)) || null;
  };
  const arestas = new Map();
  for (const f of arquivos) {
    const src = ler(f);
    const deps = new Set();
    if (f.py) {
      for (const m of src.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n(]+|\([^)]*\))/gm)) {
        const r = resolve(f.rel, m[1], true);
        if (r) deps.add(r);
        // from pacote import modulo
        for (const nome of m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)) { const r2 = resolve(f.rel, (m[1].endsWith('.') ? m[1] : m[1] + '.') + nome, true); if (r2 && r2 !== r) deps.add(r2); }
      }
      for (const m of src.matchAll(/^\s*import\s+([\w.]+)/gm)) { const r = resolve(f.rel, m[1], true); if (r) deps.add(r); }
    } else {
      for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"`;]*?from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
        if (m[2]) continue; // import type some no build: não cria ciclo em runtime
        const r = resolve(f.rel, m[3] || m[4] || m[5], false); if (r) deps.add(r);
      }
    }
    deps.delete(f.rel);
    arestas.set(f.rel, deps);
  }
  return arestas;
}

export function ciclos(arestas) {
  let idx = 0; const ind = new Map(), low = new Map(), pilha = [], na = new Set(), comps = [];
  const visita = (v) => {
    ind.set(v, idx); low.set(v, idx); idx++; pilha.push(v); na.add(v);
    for (const w of arestas.get(v) || []) {
      if (!ind.has(w)) { visita(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (na.has(w)) low.set(v, Math.min(low.get(v), ind.get(w)));
    }
    if (low.get(v) === ind.get(v)) { const c = []; let w; do { w = pilha.pop(); na.delete(w); c.push(w); } while (w !== v); if (c.length > 1) comps.push(c.sort()); }
  };
  for (const v of arestas.keys()) if (!ind.has(v)) visita(v);
  return comps;
}

// ---------- notas ----------
// Curva (decisão 20/10): cada ponto de penalidade tira 1% do que sobrou. Nunca zera e todo conserto mexe a nota.
// A conta antiga (100 − soma, piso 0) zerava com ~13 achados e escondia qualquer melhora.
export function notaEixo(achados, base = 0.99) { return Math.round(1000 * Math.pow(base, achados.reduce((a, x) => a + x.pena, 0))) / 10; } // 1 casa: abaixo de 10 o inteiro esconderia o conserto
export function notaCarga(carga) {
  if (!carga || !Array.isArray(carga.degraus) || !carga.degraus.length) return null;
  const ok = carga.degraus.filter((d) => d.ok).map((d) => d.fator);
  const maior = ok.length ? Math.max(...ok) : 0;
  return maior >= 10 ? 100 : maior >= 5 ? 70 : maior >= 2 ? 40 : maior >= 1 ? 10 : 0;
}
export function notaGeral(eixos, pesos) {
  let soma = 0, p = 0;
  for (const [k, e] of Object.entries(eixos)) if (e.nota != null) { soma += e.nota * pesos[k]; p += pesos[k]; }
  return p ? Math.round(soma / p) : null;
}
