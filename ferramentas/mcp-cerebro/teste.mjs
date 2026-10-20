#!/usr/bin/env node
// Teste de ponta a ponta do MCP cerebro: monta um índice FALSO numa pasta temporária (não precisa do
// índice real nem de rede), sobe o server.mjs, fala JSON-RPC por stdio, mede latência por chamada e
// memória (RSS/PSS/privada, só Linux) do processo filho.
// Uso: node teste.mjs   (sai com código 1 se algo falhar)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

// ---------- índice falso ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-teste-'));
const RAIZ = path.join(TMP, 'raiz');
fs.mkdirSync(path.join(RAIZ, 'memoria'), { recursive: true });
const nota = path.join(RAIZ, 'memoria', 'feedback_exemplo.md');
fs.writeFileSync(nota, '# Exemplo de memória\n\nRegra: medir antes de opinar. Ver [[guia_limpeza]].\n');
const guia = path.join(RAIZ, 'memoria', 'guia_limpeza.md');
fs.writeFileSync(guia, '# Guia da limpeza\n\nComo deixar a máquina leve.\n');
const segredo = path.join(RAIZ, 'memoria', 'token.env');
fs.writeFileSync(segredo, 'SEGREDO=nao-pode-aparecer\n');
const agora = Math.floor(Date.now() / 1000);
const itens = [
  { t: 'Exemplo de memória', p: nota, a: 'memoria', k: 'feedback', m: agora - 3600, s: 80, x: 'Regra: medir antes de opinar.', l: [1] },
  { t: 'Guia da limpeza', p: guia, a: 'memoria', k: 'nota', m: agora - 86400, s: 50, x: 'Como deixar a máquina leve.' },
  { t: 'Skill de migração', p: path.join(RAIZ, 'skills', 'migracao', 'SKILL.md'), a: 'skills', k: 'skill', m: agora - 10 * 86400, s: 10, x: 'migração de banco' },
];
const INDICE = path.join(TMP, 'indice.json');
fs.writeFileSync(INDICE, JSON.stringify({ gerado: new Date().toISOString(), itens }));

const filho = spawn(process.execPath, [...(process.env.NODE_FLAGS || '').split(' ').filter(Boolean), SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, CEREBRO_INDICE: INDICE, CEREBRO_RAIZES: RAIZ },
});
let buf = '', proxId = 1;
const pend = new Map();
filho.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    pend.get(m.id)?.(m); pend.delete(m.id);
  }
});
const chamar = (method, params) => new Promise((ok) => {
  const id = proxId++; const t = process.hrtime.bigint();
  pend.set(id, (m) => ok({ m, ms: Number(process.hrtime.bigint() - t) / 1e6 }));
  filho.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const mem = () => {
  try {
    const s = fs.readFileSync(`/proc/${filho.pid}/smaps_rollup`, 'utf8');
    const g = (k) => +(new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(s)[1]) / 1024;
    return `RSS ${g('Rss').toFixed(1)} MB · PSS ${g('Pss').toFixed(1)} MB · privada ${(g('Private_Clean') + g('Private_Dirty')).toFixed(1)} MB`;
  } catch { return '(medição de memória só no Linux)'; }
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let falhas = 0;
const conferir = (nome, cond, info = '') => { console.log(`${cond ? 'OK   ' : 'FALHA'} ${nome} ${info}`); if (!cond) falhas++; };

const ini = await chamar('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '0' } });
conferir('initialize', ini.m.result?.serverInfo?.name === 'cerebro', `${ini.ms.toFixed(1)} ms`);
filho.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const lista = await chamar('tools/list', {});
const tools = lista.m.result?.tools || [];
const jsonTools = JSON.stringify(tools);
conferir('tools/list', tools.length === 4, `${tools.map((t) => t.name).join(', ')} · ${jsonTools.length} chars ≈ ${Math.round(jsonTools.length / 3.5)} tokens`);
await espera(300);
console.log('memória parada (antes de carregar índice):', mem());

const casos = [
  ['cerebro_buscar', { consulta: 'medir opinar', limite: 5 }, (t) => t.includes('Exemplo de memória')],
  ['cerebro_buscar', { consulta: 'migração', area: 'skills', tipo: 'skill', limite: 3 }, (t) => t.includes('Skill de migração')],
  ['cerebro_arquivo', { caminho: 'feedback_exemplo.md' }, (t) => t.includes('medir antes de opinar')],
  ['cerebro_arquivo', { caminho: segredo }, (t) => /bloqueado/.test(t) && !t.includes('nao-pode-aparecer')],
  ['cerebro_arquivo', { caminho: '/etc/passwd' }, (t) => /bloqueado|não está no índice|Erro/.test(t) && !/root:/.test(t)],
  ['cerebro_ligacoes', { caminho: nota }, (t) => t.includes('Guia da limpeza')],
  ['cerebro_recentes', { dias: 2, limite: 5 }, (t) => t.includes('Exemplo de memória') && !t.includes('Skill de migração')],
];
for (const [name, args, esperado] of casos) {
  const r = await chamar('tools/call', { name, arguments: args });
  const txt = r.m.result?.content?.[0]?.text || JSON.stringify(r.m.error);
  console.log(`\n=== ${name} ${JSON.stringify(args).replace(TMP, '<tmp>')} · ${r.ms.toFixed(1)} ms${r.m.result?.isError ? ' (isError)' : ''}`);
  console.log(txt.split('\n').slice(0, 8).join('\n').split(TMP).join('<tmp>'));
  conferir(name, !r.m.error && esperado(txt));
}
// 2ª rodada: latência com índice já em memória
const t2 = await chamar('tools/call', { name: 'cerebro_buscar', arguments: { consulta: 'limpeza maquina' } });
console.log(`\nbusca com índice quente: ${t2.ms.toFixed(1)} ms`);
await espera(300);
console.log('memória após carregar índice:', mem());
filho.stdin.end();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
process.exit(falhas ? 1 : 0);
