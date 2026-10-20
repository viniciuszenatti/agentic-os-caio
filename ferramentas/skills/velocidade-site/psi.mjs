#!/usr/bin/env node
// psi.mjs — PageSpeed Insights API v5 sem dependências.
// Uso:
//   node psi.mjs <url> [url...] [--estrategia mobile|desktop|ambos] [--saida <dir>]
// Padrão: --estrategia ambos, --saida ~/.claude/deck/velocidade
// Chave opcional: variável PSI_API_KEY ou linha PSI_API_KEY=... em ~/.config/psi/.env
// Saída: resumo em pt-BR no terminal + JSON bruto por URL/estratégia.
// Código de saída: 0 tudo ok · 1 alguma medição falhou · 2 uso errado · 3 cota (429)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function lerChave() {
  if (process.env.PSI_API_KEY) return process.env.PSI_API_KEY.trim();
  const arq = join(homedir(), '.config', 'psi', '.env');
  if (!existsSync(arq)) return '';
  for (const linha of readFileSync(arq, 'utf8').split('\n')) {
    const m = linha.match(/^\s*(?:export\s+)?PSI_API_KEY\s*=\s*["']?([^"'\s#]+)/);
    if (m) return m[1];
  }
  return '';
}

function args(argv) {
  const urls = [];
  let estrategia = 'ambos';
  let saida = join(homedir(), '.claude', 'deck', 'velocidade');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--estrategia' || a === '--strategy' || a === '-s') estrategia = argv[++i];
    else if (a === '--saida' || a === '--out') saida = argv[++i];
    else if (a === '-h' || a === '--help') return null;
    else if (a.startsWith('-')) { console.error(`Flag desconhecida: ${a}`); process.exit(2); }
    else urls.push(/^https?:\/\//.test(a) ? a : `https://${a}`);
  }
  const mapa = { mobile: ['mobile'], celular: ['mobile'], desktop: ['desktop'], ambos: ['mobile', 'desktop'], both: ['mobile', 'desktop'] };
  if (!mapa[estrategia]) { console.error(`Estratégia inválida: ${estrategia} (use mobile, desktop ou ambos)`); process.exit(2); }
  return { urls, estrategias: mapa[estrategia], saida };
}

// ---------- formatação ----------
const CAT = { FAST: 'bom', AVERAGE: 'precisa melhorar', SLOW: 'ruim' };
const seg = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} s` : `${Math.round(ms)} ms`);
const CAMPO = [
  ['LCP', 'LARGEST_CONTENTFUL_PAINT_MS', seg],
  ['INP', 'INTERACTION_TO_NEXT_PAINT', seg],
  ['CLS', 'CUMULATIVE_LAYOUT_SHIFT_SCORE', (v) => (v / 100).toFixed(2).replace('.', ',')],
  ['FCP', 'FIRST_CONTENTFUL_PAINT_MS', seg],
  ['TTFB', 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', seg],
];
const LAB = [
  ['LCP', 'largest-contentful-paint'],
  ['FCP', 'first-contentful-paint'],
  ['TBT', 'total-blocking-time'],
  ['CLS', 'cumulative-layout-shift'],
  ['Speed Index', 'speed-index'],
];

function blocoCampo(titulo, exp) {
  if (!exp || !exp.metrics || !Object.keys(exp.metrics).length) return [`  ${titulo}: sem dado de campo (pouco tráfego no CrUX)`];
  const linhas = [`  ${titulo} (p75, 28 dias de usuários reais) — geral: ${CAT[exp.overall_category] || exp.overall_category || '?'}`];
  for (const [nome, chave, fmt] of CAMPO) {
    const m = exp.metrics[chave];
    if (!m) continue;
    linhas.push(`    ${nome.padEnd(5)} ${fmt(m.percentile).padEnd(8)} ${CAT[m.category] || m.category}`);
  }
  return linhas;
}

function oportunidades(audits) {
  const lista = [];
  for (const a of Object.values(audits || {})) {
    if (a.score === null || a.score === undefined || a.score >= 0.9) continue;
    if (a.scoreDisplayMode === 'informative' || a.scoreDisplayMode === 'notApplicable') continue;
    const ms = a.details?.overallSavingsMs || a.metricSavings?.LCP || a.metricSavings?.FCP || 0;
    const bytes = a.details?.overallSavingsBytes || 0;
    if (ms <= 0 && bytes <= 0) continue;
    lista.push({ id: a.id, titulo: a.title, ms, kb: Math.round(bytes / 1024) });
  }
  return lista.sort((x, y) => y.ms - x.ms || y.kb - x.kb).slice(0, 5);
}

function resumo(url, estrategia, j) {
  const lr = j.lighthouseResult || {};
  const nota = lr.categories?.performance?.score;
  const out = [];
  out.push(`\n== ${url} · ${estrategia === 'mobile' ? 'MOBILE' : 'DESKTOP'} ==`);
  out.push(`Nota de performance (laboratório): ${nota == null ? '?' : Math.round(nota * 100)}/100  · Lighthouse ${lr.lighthouseVersion || '?'}`);
  out.push('Campo (CrUX):');
  out.push(...blocoCampo('Página', j.loadingExperience?.origin_fallback ? null : j.loadingExperience));
  out.push(...blocoCampo('Domínio inteiro', j.originLoadingExperience));
  out.push('Laboratório (1 carga simulada):');
  for (const [nome, id] of LAB) {
    const a = lr.audits?.[id];
    if (a) out.push(`    ${nome.padEnd(11)} ${String(a.displayValue || '').padEnd(10)} ${a.score == null ? '' : a.score >= 0.9 ? 'bom' : a.score >= 0.5 ? 'precisa melhorar' : 'ruim'}`);
  }
  const ops = oportunidades(lr.audits);
  out.push('Top oportunidades (economia estimada pelo Lighthouse):');
  if (!ops.length) out.push('    nenhuma com economia mensurável');
  for (const o of ops) {
    const eco = [o.ms > 0 ? `~${seg(o.ms)}` : '', o.kb > 0 ? `~${o.kb} KB` : ''].filter(Boolean).join(' / ');
    out.push(`    - ${o.titulo} [${o.id}] → ${eco}`);
  }
  return out.join('\n');
}

// ---------- chamada ----------
async function medir(url, estrategia, chave) {
  const q = new URLSearchParams({ url, strategy: estrategia, category: 'performance', locale: 'pt-BR' });
  if (chave) q.set('key', chave);
  let resp;
  try {
    resp = await fetch(`${ENDPOINT}?${q}`, { signal: AbortSignal.timeout(150_000) });
  } catch (e) {
    return { erro: `rede/timeout: ${e.message}` };
  }
  const texto = await resp.text();
  if (resp.status === 429) return { erro: 'cota', status: 429, texto };
  if (!resp.ok) {
    let msg = texto.slice(0, 400);
    try { msg = JSON.parse(texto).error?.message || msg; } catch {}
    return { erro: `HTTP ${resp.status}: ${msg}`, status: resp.status };
  }
  return { json: JSON.parse(texto), texto };
}

async function main() {
  const p = args(process.argv.slice(2));
  if (!p || !p.urls.length) {
    console.log('Uso: node psi.mjs <url> [url...] [--estrategia mobile|desktop|ambos] [--saida <dir>]');
    process.exit(p ? 2 : 0);
  }
  const chave = lerChave();
  console.log(`PageSpeed Insights v5 · ${chave ? 'com chave (PSI_API_KEY)' : 'SEM chave (cota anônima baixa)'}`);
  mkdirSync(p.saida, { recursive: true });
  const carimbo = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  let falhas = 0, cota = false;

  for (const url of p.urls) {
    for (const est of p.estrategias) {
      const r = await medir(url, est, chave);
      if (r.erro === 'cota') {
        cota = true; falhas++;
        console.log(`\n== ${url} · ${est} ==\nERRO 429: cota da API esgotada${chave ? ' para esta chave' : ' (sem chave a cota anônima é compartilhada e baixa)'}.`);
        console.log('Correção: criar a chave grátis (ver "Como gerar a chave grátis" no SKILL.md) e salvar em ~/.config/psi/.env como PSI_API_KEY=...');
        continue;
      }
      if (r.erro) { falhas++; console.log(`\n== ${url} · ${est} ==\nERRO: ${r.erro}`); continue; }
      let host = 'site';
      try { host = new URL(url).host; } catch {}
      const arq = join(p.saida, `${carimbo}-${host}-${est}.json`);
      writeFileSync(arq, r.texto);
      console.log(resumo(url, est, r.json));
      console.log(`JSON bruto: ${arq}`);
    }
  }
  process.exit(cota ? 3 : falhas ? 1 : 0);
}

main();
