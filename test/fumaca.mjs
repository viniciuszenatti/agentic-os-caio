#!/usr/bin/env node
// Teste de fumaça do núcleo (o mesmo no Linux e no Windows; o CI roda nos dois).
// Sobe a Central de verdade numa porta própria com um HOME temporário, confere as rotas básicas,
// roda o indexador do cérebro e fala com o MCP do cérebro por stdio. Não chama o claude, não usa rede.
// Uso: node test/fumaca.mjs   (FUMACA_PORTA troca a porta; padrão 4799). Sai com código 1 se algo falhar.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = Number(process.env.FUMACA_PORTA || 4799);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-fumaca-'));
// o indexador grava o índice ao lado de si; numa cópia, o repo de verdade fica intocado
const COPIA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-fumaca-repo-'));
fs.cpSync(path.join(RAIZ, 'cerebro'), path.join(COPIA, 'cerebro'), { recursive: true });

// HOME e USERPROFILE apontam para a pasta temporária: os.homedir() lê um ou outro conforme o sistema.
const ENV = { ...process.env, HOME, USERPROFILE: HOME, CENTRAL_HOME: HOME, CENTRAL_PORT: String(PORTA), AGENTIC_OS_DIR: path.join(HOME, '.claude', 'agentic-os') };
fs.mkdirSync(path.join(HOME, 'Projects', 'demo'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'Projects', 'demo', 'README.md'), '# Demo da fumaça\n\nArquivo para o índice achar.\n');
fs.mkdirSync(path.join(HOME, '.claude', 'skills', 'exemplo'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'skills', 'exemplo', 'SKILL.md'), '---\nname: exemplo\ndescription: skill de exemplo da fumaça\n---\n# Exemplo\n');

let falhas = 0;
const conferir = (nome, cond, info = '') => { console.log(`${cond ? 'OK   ' : 'FALHA'} ${nome}${info ? ' · ' + info : ''}`); if (!cond) falhas++; };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function rodar(cmd, args, opcoes = {}) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'], ...opcoes });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => ok({ codigo: -1, out, err: err + e.message }));
    p.on('close', (codigo) => ok({ codigo, out, err }));
  });
}

// ---------- 1) Central ----------
console.log(`plataforma: ${process.platform} · node ${process.version} · HOME temporário ${HOME}`);
const central = spawn(process.execPath, [path.join(RAIZ, 'central', 'server.mjs')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
central.stdout.on('data', (d) => { log += d; });
central.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${PORTA}`;
let subiu = false;
for (let i = 0; i < 60 && !subiu; i++) {
  await espera(250);
  try { const r = await fetch(base + '/api/execucoes'); subiu = r.status === 200; } catch {}
}
conferir('Central subiu', subiu, subiu ? base : `log: ${log.slice(-800)}`);
if (subiu) {
  const pag = await fetch(base + '/');
  const html = await pag.text();
  const token = html.match(/<meta name="central-token" content="([0-9a-f]{64})">/)?.[1];
  conferir('GET / responde 200 com token na página', pag.status === 200 && !!token, `status ${pag.status}`);
  const arqToken = path.join(HOME, '.claude', 'agentic-os', `central-${PORTA}.token`);
  conferir('token gravado em disco', fs.existsSync(arqToken) && fs.readFileSync(arqToken, 'utf8').trim() === token);
  const planos = await fetch(base + '/api/planos');
  const planosCorpo = await planos.json().catch(() => null);
  conferir('GET /api/planos responde 200', planos.status === 200 && Array.isArray(planosCorpo), `status ${planos.status} ${JSON.stringify(planosCorpo).slice(0, 200)}`);
  const plat = await fetch(base + '/api/plataforma');
  const platCorpo = await plat.json().catch(() => null);
  conferir('GET /api/plataforma diz o sistema', plat.status === 200 && platCorpo?.plataforma === process.platform, JSON.stringify(platCorpo).slice(0, 300));
  const semToken = await fetch(base + '/api/acao/reindexar', { method: 'POST', headers: { origin: base } });
  conferir('POST sem token responde 403', semToken.status === 403, `status ${semToken.status}`);
  const cap = await fetch(base + '/api/capacidade');
  conferir('GET /api/capacidade não quebra', cap.status === 200, `status ${cap.status}`);
  const ret = await fetch(base + '/api/retrato');
  const retCorpo = await ret.json().catch(() => null);
  conferir('GET /api/retrato roda o coletor', ret.status === 200 && retCorpo && !retCorpo.erro, JSON.stringify(retCorpo).slice(0, 300));
  // ação com token: indisponível no Windows vira 501 com motivo; no Linux, sem o script instalado, 404
  const diag = await fetch(base + '/api/acao/diagnostico', { method: 'POST', headers: { origin: base, 'x-central-token': token, 'content-type': 'application/json' }, body: '{}' });
  const diagCorpo = await diag.json().catch(() => null);
  conferir('POST diagnostico com token responde sem derrubar', [202, 404, 501].includes(diag.status), `status ${diag.status} ${JSON.stringify(diagCorpo)}`);
  const ainda = await fetch(base + '/api/execucoes');
  conferir('Central continua de pé', ainda.status === 200);
}
central.kill();

// ---------- 2) indexador do cérebro ----------
const idx = await rodar(process.execPath, [path.join(COPIA, 'cerebro', 'indexar.mjs')]);
const indiceArq = path.join(COPIA, 'cerebro', 'indice.json');
let indice = null; try { indice = JSON.parse(fs.readFileSync(indiceArq, 'utf8')); } catch {}
const achouDemo = indice?.itens?.some((i) => i.t === 'Demo da fumaça');
const achouSkill = indice?.itens?.some((i) => i.a === 'skills' && i.t === 'exemplo');
conferir('indexar.mjs roda e acha projeto e skill', idx.codigo === 0 && achouDemo && achouSkill, `código ${idx.codigo} · ${idx.out.split('\n')[0]} ${idx.err.slice(0, 400)}`);

// ---------- 3) MCP do cérebro ----------
const mcp = spawn(process.execPath, [path.join(RAIZ, 'ferramentas', 'mcp-cerebro', 'server.mjs')], {
  env: { ...ENV, CEREBRO_INDICE: indiceArq }, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const respostas = new Map();
mcp.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, nl); buf = buf.slice(nl + 1);
    try { const m = JSON.parse(l); respostas.set(m.id, m); } catch {}
  }
});
const chamar = async (id, method, params) => {
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  for (let i = 0; i < 40 && !respostas.has(id); i++) await espera(100);
  return respostas.get(id);
};
const ini = await chamar(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fumaca', version: '0' } });
conferir('MCP responde initialize', ini?.result?.serverInfo?.name === 'cerebro', JSON.stringify(ini).slice(0, 200));
const busca = await chamar(2, 'tools/call', { name: 'cerebro_buscar', arguments: { consulta: 'demo fumaça' } });
conferir('MCP cerebro_buscar acha o projeto', /Demo da fumaça/.test(busca?.result?.content?.[0]?.text || ''), JSON.stringify(busca).slice(0, 300));
const porNome = await chamar(3, 'tools/call', { name: 'cerebro_arquivo', arguments: { caminho: 'README.md' } });
conferir('MCP cerebro_arquivo acha pelo nome', /Arquivo para o índice achar/.test(porNome?.result?.content?.[0]?.text || ''), JSON.stringify(porNome).slice(0, 300));
mcp.stdin.end();
await espera(300);
mcp.kill();

await espera(500);
for (const d of [HOME, COPIA]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch {} }
console.log(falhas ? `\n${falhas} FALHA(S)` : '\nFUMAÇA OK');
process.exit(falhas ? 1 : 0);
