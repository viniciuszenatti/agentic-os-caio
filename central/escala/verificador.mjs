#!/usr/bin/env node
// Verificador A15 — nota de escalabilidade (docs/arquitetura.md). Só leitura.
// Uso:
//   node verificador.mjs --alvo meu-app          lê origin/main do repo (git archive), sem tocar no checkout
//   node verificador.mjs --alvo meu-app --local  lê o checkout como está (útil para testar um branch)
//   node verificador.mjs --dir <pasta> --nome x      varre uma pasta qualquer (teste com repo plantado)
// Grava: ../escala.jsonl (uma linha por rodada) e ultimo-<alvo>.json (todos os achados).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listarArquivos, varrerArquivo, lerMigrations, lerDrizzle, grafoImports, ciclos, notaEixo, notaCarga, notaGeral } from './lib.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CENTRAL = path.dirname(AQUI);
export const CONFIG = path.join(CENTRAL, 'escala-pesos.json');
export const HIST = path.join(CENTRAL, 'escala.jsonl');
export const EIXOS = ['carga', 'dados', 'estado', 'custo', 'manutencao'];
export const NOME_EIXO = { carga: 'Carga', dados: 'Dados', estado: 'Estado e infra', custo: 'Custo por unidade', manutencao: 'Manutenção pelo time' };

export function lerConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const soma = EIXOS.reduce((a, k) => a + (c.pesos?.[k] || 0), 0);
  if (soma !== 100) throw new Error(`pesos em ${CONFIG} somam ${soma}, precisam somar 100`);
  // "~/" nos caminhos de repo vira o home de quem roda
  const til = (r) => (typeof r === 'string' && r.startsWith('~/') ? path.join(os.homedir(), r.slice(2)) : r);
  for (const al of Object.values(c.alvos_repos || {})) {
    al.repo = til(al.repo);
    if (al.migrations) al.migrations.repo = til(al.migrations.repo);
    if (al.stack) al.stack.repo = til(al.stack.repo);
  }
  return c;
}

const git = (repo, ...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
function extrair(repo, ref, sub, destino) {
  fs.mkdirSync(destino, { recursive: true });
  const r = spawnSync('bash', ['-c', 'git -C "$1" archive "$2" ${3:+"$3"} | tar -x -C "$4"', '_', repo, ref, sub || '', destino], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git archive falhou em ${repo}: ${r.stderr.trim()}`);
}
function lerPasta(dir, filtro) {
  const out = [];
  const anda = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) anda(p); else if (filtro(e.name)) out.push(fs.readFileSync(p, 'utf8')); } };
  if (fs.existsSync(dir)) anda(dir);
  return out;
}

// stack do Swarm: serviço com volume (disco do nó) não sobe 2ª réplica em outro nó sem ajuste
export function lerStack(yml) {
  const servs = []; let atual = null, emServ = false, emVol = false;
  for (const l of yml.split('\n')) {
    if (/^services:\s*$/.test(l)) { emServ = true; continue; }
    if (/^\S/.test(l)) { emServ = false; atual = null; continue; }
    if (!emServ) continue;
    const s = l.match(/^ {2}([\w.-]+):\s*$/);
    if (s) { atual = { nome: s[1], replicas: 1, volumes: [], linha: 0 }; servs.push(atual); emVol = false; continue; }
    if (!atual) continue;
    const r = l.match(/^\s+replicas:\s*(\d+)/); if (r) atual.replicas = +r[1];
    if (/^ {4}volumes:\s*$/.test(l)) { emVol = true; continue; }
    if (emVol) { const v = l.match(/^ {6}-\s*["']?([^"'\s]+)/); if (v) atual.volumes.push(v[1]); else if (/^ {4}\S/.test(l)) emVol = false; }
  }
  return servs;
}

export function avaliar({ raiz, nome, sqls = [], drizzleSrc = '', stackYml = '', stackArq = '', alias = {}, carga = null, cfg, incluir = null }) {
  const arquivos = listarArquivos(raiz, incluir);
  const cache = new Map();
  const ler = (f) => { if (!cache.has(f.rel)) cache.set(f.rel, fs.readFileSync(f.abs, 'utf8')); return cache.get(f.rel); };
  const mig = lerMigrations(sqls);
  const drizzle = lerDrizzle(drizzleSrc);
  for (const v of drizzle.values()) { mig.tabelas.add(v.tabela); if (!mig.colunas.has(v.tabela)) mig.colunas.set(v.tabela, new Set()); for (const c of v.props.values()) mig.colunas.get(v.tabela).add(c); if ([...v.props.values()].includes('tenant_id')) mig.comTenant.add(v.tabela); }
  const ctx = {
    alvos: cfg.alvos,
    drizzle,
    conhecida: (t) => mig.tabelas.has(t),
    naoCresce: (t) => (cfg.tabelasQueNaoCrescem || []).includes(t),
    cresce: (t) => mig.comTenant.has(t) || (cfg.tabelasQueCrescem || []).includes(t),
    coluna: (t, c) => !mig.colunas.has(t) || mig.colunas.get(t).has(c),
    semIndice: (t, c) => {
      if (!mig.tabelas.has(t)) return false; // tabela fora do schema conhecido: não julga
      if (c === 'id') return false;
      const idx = mig.indices.get(t); const dz = [...drizzle.values()].find((v) => v.tabela === t);
      return !(idx?.has(c) || dz?.indexadas.has(c));
    },
  };
  const achados = [];
  for (const f of arquivos) if (!f.teste) achados.push(...varrerArquivo(f, ler(f), ctx));

  // estado e infra: stack
  for (const s of lerStack(stackYml)) if (s.volumes.length) achados.push({ eixo: 'estado', tipo: 'nao-replica', arquivo: stackArq, linha: 1, trecho: `${s.nome}: volumes ${s.volumes.join(', ')}`, pena: 15, msg: `serviço ${s.nome} grava em volume do nó: não sobe 2ª réplica em outro nó` });

  // manutenção: ciclos e módulos muito importados sem teste
  const grafo = grafoImports(arquivos, (f) => ler(f), alias);
  const prod = new Set(arquivos.filter((f) => !f.teste).map((f) => f.rel));
  const grafoProd = new Map([...grafo].filter(([k]) => prod.has(k)).map(([k, v]) => [k, new Set([...v].filter((x) => prod.has(x)))]));
  for (const c of ciclos(grafoProd)) achados.push({ eixo: 'manutencao', tipo: 'ciclo', arquivo: c[0], linha: 1, trecho: c.slice(0, 6).join(' ↔ '), pena: 5, msg: `import circular entre ${c.length} arquivos` });
  const fanIn = new Map(), testados = new Set();
  for (const [de, deps] of grafo) for (const d of deps) { if (prod.has(de)) fanIn.set(d, (fanIn.get(d) || 0) + 1); else testados.add(d); }
  const nomesTeste = new Set(arquivos.filter((f) => f.teste).map((f) => path.basename(f.rel).replace(/^test_/, '').replace(/(\.test|\.spec|_test)?\.\w+$/, '')));
  for (const [rel, n] of fanIn) {
    const base = path.basename(rel).replace(/\.\w+$/, '');
    if (n >= cfg.alvos.fanInSemTeste && !testados.has(rel) && !nomesTeste.has(base) && !/(^|\/)(types?|index|__init__|schema|constants?)\.\w+$/.test(rel)) achados.push({ eixo: 'manutencao', tipo: 'sem-teste', arquivo: rel, linha: 1, trecho: `importado por ${n} arquivos`, pena: 5, msg: `importado por ${n} arquivos e sem teste` });
  }

  // dedupe arquivo+linha+tipo e ordena pelo peso da pena
  const vistos = new Set();
  const lista = achados.filter((a) => { const k = `${a.tipo}|${a.arquivo}|${a.linha}|${a.msg}`; if (vistos.has(k)) return false; vistos.add(k); return true; }).sort((a, b) => b.pena - a.pena || a.arquivo.localeCompare(b.arquivo) || a.linha - b.linha);

  const eixos = {};
  for (const k of EIXOS) {
    const meus = lista.filter((a) => a.eixo === k);
    eixos[k] = k === 'carga' ? { nota: notaCarga(carga), peso: cfg.pesos[k], achados: [], carga: carga ? { em: carga.em, alvo: carga.alvo, degraus: carga.degraus } : null }
      : { nota: notaEixo(meus, cfg.curva ?? 0.99), peso: cfg.pesos[k], achados: meus };
  }
  const nota = notaGeral(eixos, cfg.pesos);
  return { nome, arquivos: arquivos.length, eixos, nota, gargalo: gargalo(eixos) };
}

export function gargalo(eixos) {
  let pior = null;
  for (const [k, e] of Object.entries(eixos)) {
    if (e.nota == null) continue;
    const perda = (100 - e.nota) * e.peso;
    if (perda > 0 && (!pior || perda > pior.perda)) pior = { eixo: k, perda };
  }
  if (!pior) return null;
  const e = eixos[pior.eixo];
  if (pior.eixo === 'carga') {
    const ds = e.carga?.degraus || [];
    const ok = ds.filter((d) => d.ok).pop(), falha = ds.find((d) => !d.ok);
    const lento = falha?.fluxos?.slice().sort((a, b) => b.p95 - a.p95)[0];
    return { eixo: 'carga', frase: `${ok ? `aguenta ${ok.fator}×` : 'não aguenta nem a carga normal'}${falha ? `; no ${falha.fator}× ${lento ? `"${lento.nome}" passa de ${lento.p95} ms no p95` : 'falha'}${falha.erros ? ` e ${falha.erros} requisição(ões) deram erro` : ''}` : ''}`, arquivo: null, linha: null };
  }
  const a = e.achados[0];
  const tipos = new Map(); for (const x of e.achados) tipos.set(x.tipo, (tipos.get(x.tipo) || 0) + 1);
  return { eixo: pior.eixo, frase: `${NOME_EIXO[pior.eixo]} perde mais: ${e.achados.length} achado(s); o pior é ${a.msg}`, arquivo: a.arquivo, linha: a.linha, tipos: Object.fromEntries(tipos) };
}

function resumoLinha(r, extra) {
  const eixos = {};
  for (const [k, e] of Object.entries(r.eixos)) eixos[k] = { nota: e.nota, peso: e.peso, n: e.achados.length };
  return { em: new Date().toISOString(), alvo: r.nome, ...extra, arquivos: r.arquivos, nota: r.nota, eixos, gargalo: r.gargalo };
}

// ---------- CLI ----------
async function main() {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const cfg = lerConfig();
  const nomeAlvo = arg('--alvo');
  let raiz, nome, incluir = null, extra = {}, tmp = null, sqls = [], drizzleSrc = '', stackYml = '', stackArq = '', alias = {};
  try {
    if (arg('--dir')) {
      raiz = path.resolve(arg('--dir')); nome = arg('--nome') || path.basename(raiz);
      sqls = lerPasta(raiz, (n) => n.endsWith('.sql'));
      const dz = path.join(raiz, 'src/lib/schema.ts'); if (fs.existsSync(dz)) drizzleSrc = fs.readFileSync(dz, 'utf8');
      const st = path.join(raiz, 'stack.yml'); if (fs.existsSync(st)) { stackYml = fs.readFileSync(st, 'utf8'); stackArq = 'stack.yml'; }
      alias = { js: 'src', py: 'src' };
      extra = { fonte: raiz };
    } else {
      const al = cfg.alvos_repos?.[nomeAlvo];
      if (!al) throw new Error(`alvo desconhecido: ${nomeAlvo}. Válidos: ${Object.keys(cfg.alvos_repos || {}).join(', ')}`);
      nome = nomeAlvo; alias = al.alias || {}; incluir = al.incluir || null;
      const local = a.includes('--local');
      if (local) { raiz = al.repo; extra = { fonte: 'checkout local', commit: git(al.repo, 'rev-parse', '--short', 'HEAD').stdout.trim() }; }
      else {
        git(al.repo, 'fetch', '-q', 'origin', 'main');
        const commit = git(al.repo, 'rev-parse', '--short', 'origin/main').stdout.trim();
        if (!commit) throw new Error(`sem origin/main em ${al.repo}`);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), `escala-${nome}-`));
        extrair(al.repo, 'origin/main', '', tmp);
        raiz = tmp; extra = { fonte: 'origin/main', commit };
      }
      if (al.migrations) {
        git(al.migrations.repo, 'fetch', '-q', 'origin', 'main');
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'escala-mig-'));
        extrair(al.migrations.repo, 'origin/main', al.migrations.path, d);
        sqls = lerPasta(d, (n) => n.endsWith('.sql'));
        fs.rmSync(d, { recursive: true, force: true });
      }
      if (al.drizzle) { const p = path.join(raiz, al.drizzle); if (fs.existsSync(p)) drizzleSrc = fs.readFileSync(p, 'utf8'); }
      if (al.stack) {
        git(al.stack.repo, 'fetch', '-q', 'origin', 'main');
        const r = git(al.stack.repo, 'show', `origin/main:${al.stack.path}`);
        if (r.status === 0) { stackYml = r.stdout; stackArq = `${path.basename(al.stack.repo)}/${al.stack.path}`; }
      }
    }
    const cargaArq = path.join(AQUI, `carga-${nome}.json`);
    let carga = null;
    try { const c = JSON.parse(fs.readFileSync(cargaArq, 'utf8')); if (Date.now() - Date.parse(c.em) < 30 * 86_400_000) carga = c; } catch {}
    const r = avaliar({ raiz, nome, sqls, drizzleSrc, stackYml, stackArq, alias, carga, cfg, incluir });
    const linha = resumoLinha(r, extra);
    if (!a.includes('--nao-gravar')) {
      fs.appendFileSync(HIST, JSON.stringify(linha) + '\n');
      fs.writeFileSync(path.join(AQUI, `ultimo-${nome}.json`), JSON.stringify({ ...linha, eixos: r.eixos }, null, 1));
    }
    console.log(`Escalabilidade de ${nome} (${extra.fonte}${extra.commit ? ' ' + extra.commit : ''}): ${r.nota ?? 'sem dado'}/100 · ${r.arquivos} arquivos`);
    for (const k of EIXOS) { const e = r.eixos[k]; console.log(`  ${NOME_EIXO[k].padEnd(22)} ${e.nota == null ? 'sem dado' : String(e.nota).padStart(3)}  peso ${e.peso}  ${e.achados.length} achado(s)`); }
    if (r.gargalo) console.log(`Primeiro gargalo: ${r.gargalo.frase}${r.gargalo.arquivo ? ` — ${r.gargalo.arquivo}:${r.gargalo.linha}` : ''}`);
    if (a.includes('--json')) console.log(JSON.stringify(r.eixos, null, 1));
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(`erro: ${e.message}`); process.exit(1); });
