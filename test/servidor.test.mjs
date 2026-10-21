// Testes do servidor (C5): sobe a Central numa porta livre, com HOME falso e os módulos do contrato trocados por dublês.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn as spawnReal } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as plano from './stubs/plano.mjs';
import * as registro from './stubs/registro.mjs';
import * as lancar from './stubs/lancar.mjs';
import * as papeis from './stubs/papeis.mjs';
import * as score from './stubs/score.mjs';
import * as escala from './stubs/escala.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'a'.repeat(64);

function portaLivre() {
  return new Promise((ok, falha) => {
    const s = net.createServer();
    s.once('error', falha);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

// spawn falso: só o conferidor de push usa (git). Responde como uma branch limpa e com push.
const gitChamadas = [];
function spawnFalso(cmd, args) {
  gitChamadas.push([cmd, ...args]);
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  setImmediate(() => {
    const sub = args[2];
    if (sub === 'rev-parse') p.stdout.emit('data', 'origin/minha-branch\n');
    if (sub === 'rev-list') p.stdout.emit('data', '0\n');
    if (sub === 'remote') p.stdout.emit('data', 'https://github.com/fulano/repo-a.git\n');
    p.emit('close', 0);
  });
  return p;
}

let tmp, porta, base, srv, relogio = 1_000_000, servidorMod, rotasMod;
const dirs = {};

const PLANO_MD = [
  '# Plano de teste',
  '',
  '```prompt id=P1 repo=~/Projects/repo-a papel=executor onde=local',
  'faça o item 1',
  '```',
  '',
  '```prompt id=P2 repo=~/Projects/repo-a papel=executor onde=nuvem',
  'faça o item 2',
  '```',
  '',
  '```prompt id=P3 repo=~/Projects/repo-a papel=executor onde=projects',
  'faça o item 3',
  '```',
  '',
  '```prompt id=P4 repo=~/Projects/repo-a papel=executor depende=P1',
  'faça o item 4 depois do 1',
  '```',
  '',
].join('\n');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-teste-'));
  porta = await portaLivre();
  process.env.CENTRAL_HOME = tmp;
  process.env.CENTRAL_PORT = String(porta);
  servidorMod = await import('../central/server.mjs');
  rotasMod = await import('../central/rotas-planos.mjs');
  Object.assign(dirs, { planos: path.join(tmp, 'planos'), registros: path.join(tmp, 'planos', 'registro'), dados: path.join(tmp, 'dados'), home: tmp });
  fs.mkdirSync(dirs.planos, { recursive: true });
  fs.mkdirSync(dirs.dados, { recursive: true });
  fs.writeFileSync(path.join(dirs.dados, 'nuvem-repos.json'), JSON.stringify({ comApp: ['fulano/*'] }));
  fs.mkdirSync(path.join(tmp, 'Projects', 'repo-a'), { recursive: true });
  fs.writeFileSync(path.join(dirs.planos, '2026-10-20-teste.md'), PLANO_MD);
  fs.writeFileSync(path.join(dirs.planos, '2026-10-19-descartar.md'), PLANO_MD);
  fs.writeFileSync(path.join(dirs.planos, '2026-10-18-ruim.md'), '# Ruim\n\n```prompt id=X1 repo=~/Projects/nao-existe\nx\n```\n');
  const rotas = rotasMod.criarRotasPlanos({ mod: { plano, registro, lancar, papeis, score, escala }, fs, spawn: spawnFalso, agora: () => relogio, dirs });
  srv = servidorMod.criarServidor({ token: TOKEN, rotas });
  await new Promise((ok) => srv.listen(porta, '127.0.0.1', ok));
  base = `http://127.0.0.1:${porta}`;
});

after(async () => {
  await new Promise((ok) => srv.close(ok));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const origem = () => `http://127.0.0.1:${porta}`;
async function get(p, headers = {}) {
  const r = await fetch(base + p, { headers });
  const tipo = r.headers.get('content-type') || '';
  return { status: r.status, corpo: tipo.includes('json') ? await r.json() : await r.text() };
}
async function post(acao, corpo, { token = TOKEN, origin = origem() } = {}) {
  const headers = { 'content-type': 'application/json', origin };
  if (token !== null) headers['x-central-token'] = token;
  const r = await fetch(`${base}/api/acao/${acao}`, { method: 'POST', headers, body: JSON.stringify(corpo) });
  return { status: r.status, corpo: await r.json() };
}

// ---------- configuração por ambiente ----------
test('CENTRAL_PORT e CENTRAL_HOME mudam porta, HOME e o arquivo do token', () => {
  assert.equal(servidorMod.CONFIG.PORT, porta);
  assert.equal(servidorMod.CONFIG.HOME, tmp);
  assert.equal(servidorMod.TOKEN_ARQ, path.join(tmp, '.claude', 'agentic-os', `central-${porta}.token`));
});

test('Host de outra porta (a 4747 de sempre) é recusado: o conjunto de Host segue a porta', async () => {
  const r = await new Promise((ok, falha) => {
    const s = net.connect(porta, '127.0.0.1', () => s.write('GET /api/planos HTTP/1.1\r\nHost: 127.0.0.1:4747\r\nConnection: close\r\n\r\n'));
    let txt = ''; s.on('data', (d) => { txt += d; }); s.on('end', () => ok(txt)); s.on('error', falha);
  });
  assert.match(r, /^HTTP\/1\.1 403/);
});

// ---------- token ----------
test('POST sem X-Central-Token recebe 403 (rota nova)', async () => {
  const r = await post('descartar-plano', { arquivo: '2026-10-19-descartar.md' }, { token: null });
  assert.equal(r.status, 403);
  assert.match(r.corpo.erro, /token/);
});

test('POST com token errado recebe 403', async () => {
  const r = await post('salvar-pesos', { pesos: { a: 100 } }, { token: 'b'.repeat(64) });
  assert.equal(r.status, 403);
});

test('POST sem token recebe 403 também nas ações antigas', async () => {
  for (const acao of ['salvar-layout', 'abrir', 'diagnostico', 'responder']) {
    const r = await post(acao, {}, { token: null });
    assert.equal(r.status, 403, acao);
  }
});

test('POST com token mas origem estranha continua 403', async () => {
  const r = await post('salvar-pesos', { pesos: { a: 100 } }, { origin: 'http://localhost.evil.com' });
  assert.equal(r.status, 403);
  assert.match(r.corpo.erro, /origem/);
});

test('ação antiga com token passa da trava (chega na validação dela)', async () => {
  const r = await post('salvar-layout', { layout: { v: 2 } });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /versão/);
});

test('a página servida traz o token em <meta name="central-token">', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.ok(r.corpo.includes(`<meta name="central-token" content="${TOKEN}">`));
});

test('criarServidor recusa token curto', () => {
  assert.throws(() => servidorMod.criarServidor({ token: 'curto', rotas: null }), /token/);
});

// ---------- planos ----------
test('GET /api/planos lista arquivo, título, estado e progresso', async () => {
  const r = await get('/api/planos');
  assert.equal(r.status, 200);
  const p = r.corpo.find((x) => x.arquivo === '2026-10-20-teste.md');
  assert.deepEqual(p, { arquivo: '2026-10-20-teste.md', titulo: 'Plano de teste', estado: 'proposto', progresso: { concluidos: 0, total: 4, pct: 0 } });
});

test('GET /api/plano devolve plano, estados, progresso e erros', async () => {
  const r = await get('/api/plano?arquivo=2026-10-20-teste.md');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.plano.itens.length, 4);
  assert.deepEqual(r.corpo.estados, { P1: 'pronto', P2: 'pronto', P3: 'pronto', P4: 'bloqueado' });
  assert.deepEqual(r.corpo.erros, []);
  assert.equal(r.corpo.progresso.pct, 0);
});

test('GET /api/plano mostra os erros do conferir (repo inexistente)', async () => {
  const r = await get('/api/plano?arquivo=2026-10-18-ruim.md');
  assert.equal(r.status, 200);
  assert.match(r.corpo.erros[0], /repo não existe/);
});

test('GET /api/plano recusa caminho fora da pasta e arquivo que não existe', async () => {
  for (const a of ['../segredo.md', '..%2Fsegredo.md', 'nao-existe.md', 'x.txt', '']) {
    const r = await get(`/api/plano?arquivo=${a}`);
    assert.equal(r.status, 404, a);
  }
});

test('GET das rotas novas recusa pedido cross-site', async () => {
  const r = await get('/api/planos', { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
});

test('aprovar-plano com onde inválido ou item desconhecido → 400', async () => {
  let r = await post('aprovar-plano', { arquivo: '2026-10-20-teste.md', onde: { P1: 'marte' } });
  assert.equal(r.status, 400);
  r = await post('aprovar-plano', { arquivo: '2026-10-20-teste.md', onde: { Z9: 'local' } });
  assert.equal(r.status, 400);
});

test('aprovar-plano com erros no plano → 409, nada disparado', async () => {
  const antes = lancar.chamadas.lancar.length;
  const r = await post('aprovar-plano', { arquivo: '2026-10-18-ruim.md', onde: {} });
  assert.equal(r.status, 409);
  assert.equal(lancar.chamadas.lancar.length, antes);
});

test('aprovar-plano dispara só os prontos, cada um no seu modo, e grava o registro', async () => {
  const antes = lancar.chamadas.lancar.length;
  const r = await post('aprovar-plano', { arquivo: '2026-10-20-teste.md', onde: { P1: 'local' } });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  const porId = Object.fromEntries(r.corpo.disparados.map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(porId).sort(), ['P1', 'P2', 'P3']);
  assert.equal(porId.P1.onde, 'local');
  assert.equal(porId.P1.sessao, 'bg1');
  assert.equal(porId.P1.nome, 'plano-P1');
  assert.equal(porId.P2.onde, 'nuvem');
  assert.equal(porId.P2.url, 'https://claude.ai/code/cse_1');
  assert.equal(porId.P3.onde, 'projects');
  assert.match(r.corpo.projectsTexto, /faça o item 3/);

  const novas = lancar.chamadas.lancar.slice(antes);
  assert.equal(novas.length, 2); // P1 local + P2 nuvem; P3 vai por texto; P4 bloqueado
  assert.equal(novas[0].argv[1], '--bg');
  assert.equal(novas[0].cwd, path.join(tmp, 'Projects', 'repo-a'));
  assert.match(novas[0].argv.at(-1), /\[marcar em .*2026-10-20-teste\.md\]/); // prompt embrulhado
  assert.equal(novas[1].argv[1], '--cloud');
  assert.ok(gitChamadas.some((c) => c.includes('rev-parse')), 'nuvem confere o push antes');

  const reg = JSON.parse(fs.readFileSync(path.join(dirs.planos, '2026-10-20-teste.registro.json'), 'utf8'));
  assert.equal(reg.estado, 'aprovado');
  assert.equal(reg.aprovadoEm, relogio);
  assert.equal(reg.itens.P1.sessao, 'bg1');
  assert.equal(reg.itens.P2.url, 'https://claude.ai/code/cse_1');
  assert.equal(reg.itens.P4.onde, 'local');

  const v = await get('/api/plano?arquivo=2026-10-20-teste.md');
  assert.deepEqual(v.corpo.estados, { P1: 'disparado', P2: 'disparado', P3: 'entregue-projects', P4: 'bloqueado' });
});

test('aprovar de novo não redispara quem já foi disparado', async () => {
  const antes = lancar.chamadas.lancar.length;
  const r = await post('aprovar-plano', { arquivo: '2026-10-20-teste.md', onde: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.disparados, []);
  assert.equal(lancar.chamadas.lancar.length, antes);
});

test('concluir-projects conclui item entregue ao Projects e recusa os outros', async () => {
  let r = await post('concluir-projects', { arquivo: '2026-10-20-teste.md', id: 'P1' });
  assert.equal(r.status, 409);
  r = await post('concluir-projects', { arquivo: '2026-10-20-teste.md', id: 'P3' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.progresso.concluidos, 1);
  r = await post('concluir-projects', { arquivo: '2026-10-20-teste.md', id: '../P3' });
  assert.equal(r.status, 400);
});

test('descartar-plano descarta proposto, recusa aprovado, e aprovar descartado é 409', async () => {
  let r = await post('descartar-plano', { arquivo: '2026-10-19-descartar.md' });
  assert.equal(r.status, 200);
  r = await post('aprovar-plano', { arquivo: '2026-10-19-descartar.md', onde: {} });
  assert.equal(r.status, 409);
  r = await post('descartar-plano', { arquivo: '2026-10-20-teste.md' });
  assert.equal(r.status, 409);
});

test('lançamento que falha marca o item como falhou com motivo', async () => {
  fs.writeFileSync(path.join(dirs.planos, '2026-10-17-falha.md'), '# Falha\n\n```prompt id=F1 repo=~/Projects/repo-a\nx\n```\n');
  lancar.controle.falharLancar = true;
  try {
    const r = await post('aprovar-plano', { arquivo: '2026-10-17-falha.md', onde: {} });
    assert.equal(r.status, 200);
    assert.equal(r.corpo.disparados[0].ok, false);
    assert.match(r.corpo.disparados[0].motivo, /erro simulado/);
  } finally { lancar.controle.falharLancar = false; }
  const v = await get('/api/plano?arquivo=2026-10-17-falha.md');
  assert.equal(v.corpo.estados.F1, 'falhou');
});

// ---------- sessões ----------
test('GET /api/sessoes usa claude agents (lancar.sessoes) com cache de 5 s', async () => {
  // aprovar zerou o cache; a 1ª leitura chama, a 2ª (mesmo instante) não
  const n0 = lancar.chamadas.sessoes;
  let r = await get('/api/sessoes');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.sessoes[0].id, 'abc123');
  await get('/api/sessoes');
  assert.equal(lancar.chamadas.sessoes, n0 + 1);
  relogio += 4_000;
  await get('/api/sessoes');
  assert.equal(lancar.chamadas.sessoes, n0 + 1);
  relogio += 1_500;
  r = await get('/api/sessoes');
  assert.equal(lancar.chamadas.sessoes, n0 + 2);
});

test('parar-sessao valida o id e chama claude stop', async () => {
  let r = await post('parar-sessao', { id: 'x; rm -rf /' });
  assert.equal(r.status, 400);
  r = await post('parar-sessao', { id: 'abc123' });
  assert.equal(r.status, 200);
  assert.deepEqual(lancar.chamadas.lancar.at(-1).argv, ['claude', 'stop', 'abc123']);
});

test('mensagem-sessao valida e manda o texto como um argumento só', async () => {
  let r = await post('mensagem-sessao', { id: 'cse_1', texto: '' });
  assert.equal(r.status, 400);
  r = await post('mensagem-sessao', { id: 'cse_1', texto: 'x'.repeat(2001) });
  assert.equal(r.status, 400);
  r = await post('mensagem-sessao', { id: 'cse_1', texto: 'olá; $(whoami)' });
  assert.equal(r.status, 200);
  assert.deepEqual(lancar.chamadas.lancar.at(-1).argv, ['claude', '-p', 'olá; $(whoami)', '--cloud', 'cse_1', '--output-format', 'json']);
});

// ---------- papéis, score, escala ----------
test('GET /api/papeis devolve o padrão e as listas fechadas', async () => {
  const r = await get('/api/papeis');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.papeis.orquestrador.modelo, 'claude-opus-5-5');
  assert.deepEqual(r.corpo.listas.ondes, ['local', 'nuvem', 'projects']);
});

test('salvar-papeis recusa inválido e grava válido', async () => {
  let r = await post('salvar-papeis', { papeis: { executor: { modelo: 'gpt' } } });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /modelo/);
  const novo = { executor: { modelo: 'claude-haiku-5-5', esforco: 'low', onde: 'local', permissao: 'default' } };
  r = await post('salvar-papeis', { papeis: novo });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.dados, 'papeis.json'), 'utf8')), novo);
  const v = await get('/api/papeis');
  assert.equal(v.corpo.papeis.executor.modelo, 'claude-haiku-5-5');
});

test('salvar-pesos recusa soma diferente de 100 e grava score e escala', async () => {
  let r = await post('salvar-pesos', { pesos: { a: 50, b: 40 } });
  assert.equal(r.status, 400);
  r = await post('salvar-pesos', { tipo: 'outro', pesos: { a: 100 } });
  assert.equal(r.status, 400);
  r = await post('salvar-pesos', { pesos: { ...score.PESOS_PADRAO } });
  assert.equal(r.status, 200);
  r = await post('salvar-pesos', { tipo: 'escala', pesos: { carga: 50, dados: 50 } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.dados, 'escala-pesos.json'), 'utf8')), { carga: 50, dados: 50 });
});

test('GET /api/score sem fontes: dimensões "sem dado", com histórico e tendência', async () => {
  fs.writeFileSync(path.join(dirs.dados, 'score.jsonl'), '{"geral":60}\n{"geral":70}\nlixo\n');
  const r = await get('/api/score');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.atual.dimensoes.length, 7);
  assert.ok(r.corpo.atual.dimensoes.every((d) => d.nota === null));
  assert.equal(r.corpo.tendencia, 10);
  assert.equal(r.corpo.historico.length, 2);
});

// No servidor, /api/escala é a rota da grade (verificador real em central/escala/), que responde antes das rotas
// novas; a calculadora do N3 continua acessível por rotas.get e é testada aqui direto.
test('rotas.get /api/escala (calculadora N3) usa os pesos gravados e devolve eixos e primeiro gargalo', async () => {
  const rotas = rotasMod.criarRotasPlanos({ mod: { plano, registro, lancar, papeis, score, escala }, fs, spawn: spawnFalso, dirs });
  const r = await rotas.get('/api/escala', new URLSearchParams());
  assert.equal(r.code, 200);
  assert.deepEqual(r.corpo.pesos, { carga: 50, dados: 50 });
  assert.equal(r.corpo.atual.eixos.length, 2);
  assert.ok('primeiroGargalo' in r.corpo.atual);
});
test('GET /api/escala no servidor é a rota da grade', async () => {
  const r = await get('/api/escala');
  assert.equal(r.status, 200);
  assert.ok('ausente' in r.corpo || 'alvos' in r.corpo, JSON.stringify(r.corpo).slice(0, 200));
});

// ---------- módulos ausentes ----------
test('módulo do contrato ausente → 503 dizendo qual falta, sem derrubar nada', async () => {
  const rotas = rotasMod.criarRotasPlanos({ mod: { plano: null, registro, lancar: null, papeis, score: null, escala }, fs, spawn: spawnFalso, dirs });
  let r = await rotas.get('/api/planos', new URLSearchParams());
  assert.equal(r.code, 503);
  assert.match(r.corpo.erro, /plano/);
  r = await rotas.get('/api/score', new URLSearchParams());
  assert.equal(r.code, 503);
  r = await rotas.post('parar-sessao', { id: 'abc' });
  assert.equal(r.code, 503);
  assert.equal(await rotas.get('/api/outra', new URLSearchParams()), null);
});

test('carregarModulos devolve null para módulo que não existe no caminho do contrato', async () => {
  const mod = await rotasMod.carregarModulos(new URL('file:///nao/existe/'));
  assert.deepEqual(Object.values(mod), [null, null, null, null, null, null]);
});

// ---------- servidor antigo continua subindo ----------
test('node central/server.mjs sobe na porta do ambiente, grava o token 600 e serve a página', async () => {
  const p2 = await portaLivre();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-sobe-'));
  const filho = spawnReal(process.execPath, [path.join(RAIZ, 'central', 'server.mjs')], {
    env: { ...process.env, CENTRAL_HOME: home, CENTRAL_PORT: String(p2), PATH: '/nao-existe' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((ok, falha) => {
      const t = setTimeout(() => falha(new Error('não subiu em 10 s')), 10_000);
      let out = '';
      filho.stdout.on('data', (d) => { out += d; if (out.includes('Central em')) { clearTimeout(t); ok(); } });
      filho.on('exit', (c) => { clearTimeout(t); falha(new Error(`saiu com ${c}`)); });
    });
    const arq = path.join(home, '.claude', 'agentic-os', `central-${p2}.token`);
    const st = fs.statSync(arq);
    // no Windows o modo POSIX não existe (o arquivo fica protegido pela ACL do perfil)
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
    const token = fs.readFileSync(arq, 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    const pag = await (await fetch(`http://127.0.0.1:${p2}/`)).text();
    assert.ok(pag.includes(`<meta name="central-token" content="${token}">`));
    const semToken = await fetch(`http://127.0.0.1:${p2}/api/acao/diagnostico`, { method: 'POST', headers: { origin: `http://127.0.0.1:${p2}` } });
    assert.equal(semToken.status, 403);
    // rota antiga de leitura continua respondendo
    const exec = await fetch(`http://127.0.0.1:${p2}/api/execucoes`);
    assert.equal(exec.status, 200);
    // rota nova responde (503 enquanto N1–N3 não estão integrados, 200 depois)
    const planos = await fetch(`http://127.0.0.1:${p2}/api/planos`);
    assert.ok([200, 503].includes(planos.status));
  } finally {
    filho.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
