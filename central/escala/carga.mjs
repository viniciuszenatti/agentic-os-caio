#!/usr/bin/env node
// Teste de carga do eixo Carga. Node puro (fetch nativo).
// Sem --confirmar só mostra o plano (simulação). Regras travadas no código:
//   - só GET (nenhum POST: não dispara IA, não grava nada);
//   - só os hosts de DEV listados em carga.hostsDev do escala-pesos.json, ou localhost/127.0.0.1 (nunca HML nem PROD);
//   - degraus 1×, 2×, 5×, 10× do usuariosBase; teto 10× e 5 min por degrau;
//   - para no primeiro degrau que falhar (p95 acima do alvo ou erros acima do limite).
// Uso:
//   node carga.mjs --alvo meu-app                      simulação: mostra o plano
//   node carga.mjs --alvo meu-app --confirmar          roda no DEV (avise quem cuida do ambiente antes)
//   node carga.mjs --base http://127.0.0.1:9999 --nome x --confirmar   (teste local)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerConfig } from './verificador.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

// hostsDev: nomes exatos de host do seu DEV (ex.: ["dev.exemplo.com"]). Comparação exata: sufixo disfarçado não passa.
export function hostPermitido(base, hostsDev = []) {
  let u; try { u = new URL(base); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const hosts = (Array.isArray(hostsDev) ? hostsDev : []).map((h) => String(h).toLowerCase());
  return hosts.includes(u.hostname.toLowerCase()) || ['localhost', '127.0.0.1'].includes(u.hostname);
}

const p95 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]); };

async function degrau({ base, fluxos, conc, segundos, timeoutMs }) {
  const fim = Date.now() + segundos * 1000;
  const por = new Map(fluxos.map((f) => [f.nome, { nome: f.nome, ms: [], erros: 0 }]));
  let i = 0;
  const trabalhador = async () => {
    while (Date.now() < fim) {
      const f = fluxos[i++ % fluxos.length];
      const r = por.get(f.nome);
      const t0 = performance.now();
      try {
        const resp = await fetch(new URL(f.caminho, base), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'escala-carga/1 (Central de Agentes)' } });
        await resp.arrayBuffer();
        r.ms.push(performance.now() - t0);
        if (resp.status >= 500 || resp.status === 429) r.erros++;
      } catch { r.ms.push(timeoutMs); r.erros++; }
    }
  };
  await Promise.all(Array.from({ length: conc }, trabalhador));
  const lista = [...por.values()].map((r) => ({ nome: r.nome, n: r.ms.length, p95: p95(r.ms), erros: r.erros }));
  const n = lista.reduce((a, x) => a + x.n, 0), erros = lista.reduce((a, x) => a + x.erros, 0);
  return { n, erros, p95: p95([...por.values()].flatMap((r) => r.ms)), fluxos: lista };
}

export async function rodarCarga({ base, fluxos, cfgCarga, alvos, log = console.log }) {
  const degraus = cfgCarga.degraus.filter((f) => f <= Math.min(cfgCarga.fatorMax, 10));
  const seg = Math.min(cfgCarga.segundosPorDegrau, cfgCarga.segundosMaxPorDegrau, 300);
  const res = [];
  for (const fator of degraus) {
    const conc = cfgCarga.usuariosBase * fator;
    log(`degrau ${fator}× (${conc} simultâneos, ${seg} s)…`);
    const d = await degrau({ base, fluxos, conc, segundos: seg, timeoutMs: Math.max(alvos.p95ms * 5, 5000) });
    const taxa = d.n ? d.erros / d.n : 1;
    const piorFluxo = Math.max(...d.fluxos.map((f) => f.p95 ?? Infinity));
    const ok = d.n > 0 && piorFluxo <= alvos.p95ms && taxa <= alvos.errosMax;
    res.push({ fator, conc, ok, ...d, taxaErro: +taxa.toFixed(4) });
    log(`  ${ok ? 'ok' : 'FALHOU'} · ${d.n} req · p95 ${d.p95} ms · pior fluxo ${piorFluxo} ms · erros ${d.erros}`);
    if (!ok) break; // para no primeiro degrau que falhar
  }
  return res;
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const cfg = lerConfig();
  const nome = arg('--nome') || arg('--alvo');
  const alvoCfg = cfg.carga.alvos?.[arg('--alvo')] || {};
  const base = arg('--base') || alvoCfg.base;
  let fluxos = alvoCfg.fluxos || [];
  if (arg('--caminhos')) fluxos = arg('--caminhos').split(',').map((c) => ({ nome: c, caminho: c }));
  if (!nome || !base || !fluxos.length) { console.error('faltou --alvo (com base e fluxos no escala-pesos.json) ou --base + --nome + --caminhos'); process.exit(2); }
  if (!hostPermitido(base, cfg.carga?.hostsDev)) { console.error(`recusado: ${base} não é DEV nem localhost. HML e PROD nunca.`); process.exit(3); }
  const cfgCarga = { ...cfg.carga, ...(arg('--segundos') ? { segundosPorDegrau: +arg('--segundos') } : {}) };
  console.log(`Plano de carga em ${base}: degraus ${cfgCarga.degraus.join('×, ')}× de ${cfgCarga.usuariosBase} usuários, ${Math.min(cfgCarga.segundosPorDegrau, 300)} s cada, só GET em: ${fluxos.map((f) => f.caminho).join(', ')}. Alvo p95 ${cfg.alvos.p95ms} ms.`);
  if (!a.includes('--confirmar')) { console.log('Simulação: nada foi enviado. Rode com --confirmar (no DEV, avise quem cuida do ambiente antes: pode deixar o DEV lento enquanto roda).'); return; }
  const degraus = await rodarCarga({ base, fluxos, cfgCarga, alvos: cfg.alvos });
  const saida = { em: new Date().toISOString(), alvo: base, fluxos: fluxos.map((f) => f.caminho), degraus };
  fs.writeFileSync(path.join(AQUI, `carga-${nome}.json`), JSON.stringify(saida, null, 1));
  const ok = degraus.filter((d) => d.ok).pop();
  console.log(`Resultado: ${ok ? `aguenta ${ok.fator}×` : 'falhou já no 1×'}. Gravado em escala/carga-${nome}.json; rode o verificador para entrar na nota.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(`erro: ${e.message}`); process.exit(1); });
