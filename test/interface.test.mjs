// O fake-api (central/dev/fake-api.mjs) responde às rotas do contrato C5 e serve a página com o token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { criarFakeApi } from '../central/dev/fake-api.mjs';

const TOKEN = 'tok-teste-123';
let srv, base;

before(async () => {
  srv = criarFakeApi({ token: TOKEN });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((ok) => srv.close(ok)));

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, corpo: await r.json() }; };
const post = async (p, corpo, token = TOKEN) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-Central-Token'] = token;
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(corpo) });
  return { status: r.status, corpo: await r.json() };
};

test('página servida com o token no meta, sem Google Fonts', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, new RegExp(`<meta name="central-token" content="${TOKEN}">`));
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
});

test('fontes locais existem e são servidas (sem fonte de marca comercial)', async () => {
  for (const p of ['/fonts/Inter-latin-wght.woff2', '/fonts/JetBrainsMono-latin-wght.woff2']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    await r.arrayBuffer();
  }
  assert.ok(fs.existsSync(new URL('../central/fonts/LICENSE-Inter.txt', import.meta.url)));
  assert.ok(fs.existsSync(new URL('../central/fonts/LICENSE-JetBrainsMono.txt', import.meta.url)));
});

test('GET /api/planos devolve [{ arquivo, titulo, estado, progresso }]', async () => {
  const { status, corpo } = await get('/api/planos');
  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo) && corpo.length >= 2);
  for (const p of corpo) {
    assert.equal(typeof p.arquivo, 'string');
    assert.equal(typeof p.titulo, 'string');
    assert.ok(['proposto', 'aprovado', 'descartado', 'encerrado'].includes(p.estado));
    assert.ok(Number.isInteger(p.progresso.pct) && p.progresso.pct >= 0 && p.progresso.pct <= 100);
    assert.equal(typeof p.progresso.total, 'number');
    assert.equal(typeof p.progresso.concluidos, 'number');
  }
});

test('GET /api/plano?arquivo= devolve { plano, estados, progresso, erros }', async () => {
  const { corpo: lista } = await get('/api/planos');
  const { status, corpo } = await get(`/api/plano?arquivo=${encodeURIComponent(lista[0].arquivo)}`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo.plano.itens));
  assert.ok(Array.isArray(corpo.erros));
  const estados = ['bloqueado', 'pronto', 'disparado', 'iniciado', 'concluido', 'entregue-projects', 'falhou'];
  for (const it of corpo.plano.itens) {
    assert.match(it.id, /^[A-Za-z]+\d+$/);
    assert.ok(['local', 'nuvem', 'projects'].includes(it.onde));
    assert.ok(estados.includes(corpo.estados[it.id]), it.id);
  }
  assert.equal((await get('/api/plano?arquivo=nao-existe.md')).status, 404);
});

test('GET /api/papeis, /api/score, /api/escala, /api/sessoes', async () => {
  const pap = (await get('/api/papeis')).corpo;
  assert.equal(pap.papeis.orquestrador.modelo, 'claude-opus-5-5');
  assert.equal(pap.papeis.orquestrador.esforco, 'medium');

  const sc = (await get('/api/score')).corpo;
  assert.equal(sc.dimensoes.length, 7);
  assert.equal(Object.values(sc.pesos).filter((v) => typeof v === 'number').reduce((a, b) => a + b, 0), 100);
  assert.ok(sc.dimensoes.some((d) => d.nota === null), 'tem dimensão sem dado');

  const es = (await get('/api/escala')).corpo;
  assert.equal(es.eixos.length, 5);
  assert.equal(es.eixos.reduce((a, e) => a + e.peso, 0), 100);
  assert.equal(typeof es.primeiroGargalo.arquivo, 'string');
  assert.equal(typeof es.primeiroGargalo.linha, 'number');

  const ses = (await get('/api/sessoes')).corpo;
  assert.ok(Array.isArray(ses));
  for (const s of ses) for (const k of ['id', 'nome', 'cwd', 'status', 'esperando']) assert.ok(k in s, k);
});

test('POST sem token ou com token errado recebe 403', async () => {
  assert.equal((await post('/api/acao/parar-sessao', { id: 'a1b2c3' }, null)).status, 403);
  assert.equal((await post('/api/acao/parar-sessao', { id: 'a1b2c3' }, 'errado')).status, 403);
  assert.equal((await post('/api/acao/parar-sessao', { id: 'a1b2c3' })).status, 200);
});

test('ações do C5 com token', async () => {
  const msg = await post('/api/acao/mensagem-sessao', { id: 'f0f0f0', texto: 'oi' });
  assert.equal(msg.status, 200);
  assert.equal((await post('/api/acao/mensagem-sessao', { id: 'f0f0f0', texto: '' })).status, 400);

  const { corpo: lista } = await get('/api/planos');
  const prop = lista.find((p) => p.estado === 'proposto');
  const ap = await post('/api/acao/aprovar-plano', { arquivo: prop.arquivo, onde: { P4: 'projects' } });
  assert.equal(ap.status, 200);
  assert.deepEqual(ap.corpo.disparados, ['P1']);
  assert.match(ap.corpo.projectsTexto, /P4/);
  assert.equal((await post('/api/acao/aprovar-plano', { arquivo: prop.arquivo, onde: {} })).status, 409);
  assert.equal((await get('/api/planos')).corpo.find((p) => p.arquivo === prop.arquivo).estado, 'aprovado');

  const ativo = lista.find((p) => p.estado === 'aprovado');
  assert.equal((await post('/api/acao/concluir-projects', { arquivo: ativo.arquivo, id: 'N6' })).status, 200);
  assert.equal((await post('/api/acao/descartar-plano', { arquivo: ativo.arquivo })).status, 200);

  const papeis = (await get('/api/papeis')).corpo.papeis;
  assert.equal((await post('/api/acao/salvar-papeis', { papeis })).status, 200);
  assert.equal((await post('/api/acao/salvar-papeis', { papeis: { x: { modelo: 'gpt', esforco: 'low', onde: 'local', permissao: 'default' } } })).status, 400);

  const pesos = (await get('/api/score')).corpo.pesos;
  assert.equal((await post('/api/acao/salvar-pesos', { pesos })).status, 200);
  assert.equal((await post('/api/acao/salvar-pesos', { pesos: { ...pesos, seguranca: 30 } })).status, 400);
});

test('rotas antigas que a página chama respondem', async () => {
  for (const p of ['/api/retrato', '/api/limpeza', '/api/capacidade', '/api/modo-build', '/api/nos', '/api/anel', '/api/revisao', '/api/noticias', '/api/gemini', '/api/layout', '/api/respostas', '/api/execucoes', '/api/estado/qualquer']) {
    assert.equal((await get(p)).status, 200, p);
  }
});

test('a página manda X-Central-Token em todo POST e não remove os cartões antigos', () => {
  const html = fs.readFileSync(new URL('../central/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-cartao="board"|\/api\/tarefas|marcar-fazendo|criar-tarefa|Menseal/, 'sem board nem fonte de marca');
  assert.match(html, /'X-Central-Token': TOKEN/);
  for (const c of ['apps', 'calendario', 'noticias', 'precisa', 'revisao', 'deck', 'rotinas']) assert.match(html, new RegExp(`data-cartao="${c}"`), c);
  for (const id of ['card-proposto', 'card-planos', 'card-workflow', 'card-score']) assert.match(html, new RegExp(`id="${id}"`), id);
  // escalabilidade: um só cartão, o da grade (data-cartao="escala", com verificador real)
  assert.equal((html.match(/id="escala"/g) || []).length, 1);
  assert.match(html, /data-cartao="escala"/);
});
