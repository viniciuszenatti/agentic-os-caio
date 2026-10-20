/**
 * Testes do C2 (central/planos/registro.mjs). Portados de
 * vendor/escritorio/test-registro*.test.js e test-despacho.test.js, sem a
 * parte de sessões vivas (a Central não usa) e com os estados novos.
 *
 * O disco entra por um dublê em memória; um teste usa o disco de verdade
 * numa pasta temporária para provar que a API de node:fs/promises serve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsReal from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ler, gravar, marcar, estadoDosItens, detalharEstados, progresso, aprovar, descartar, encerrar,
  vazio, conflitantes, emAndamento, ESTADOS_DO_ITEM, EVENTOS,
} from '../central/planos/registro.mjs';
import { lerPlano } from '../central/planos/plano.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const agora = T0;

/** fs em memória com a forma de node:fs/promises. */
function fsFalso(inicial = {}) {
  const arquivos = new Map(Object.entries(inicial));
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    arquivos,
    escritas: [],
    async readFile(p) { if (!arquivos.has(p)) throw enoent(p); return arquivos.get(p); },
    async writeFile(p, dado) { this.escritas.push(p); arquivos.set(p, String(dado)); },
    async rename(de, para) { if (!arquivos.has(de)) throw enoent(de); arquivos.set(para, arquivos.get(de)); arquivos.delete(de); },
    async mkdir() {},
    async rm(p) { arquivos.delete(p); },
  };
}

const CAMINHO = '/reg/plano.json';

const item = (id, extra = {}) => ({
  id, titulo: id, repo: '~/Projects/um', papel: 'executor', area: null, onde: 'local',
  modelo: null, esforco: null, permissao: 'acceptEdits', depende: [], conflita: [],
  porta: null, custo: null, exclusivo: null, prompt: 'faca', ...extra,
});
const plano = (...itens) => ({ titulo: 't', itens, erros: [] });
const aprovado = () => aprovar(vazio('/planos/x.md'), { agora: T0 - 1000 });

// ---- ler / gravar ----

test('registro que nao existe le como vazio e proposto, sem gravar nada', async () => {
  const fs = fsFalso();
  const r = await ler(CAMINHO, { fs });
  assert.deepEqual(r, { plano: null, estado: 'proposto', aprovadoEm: null, estadoEm: null, itens: {} });
  assert.equal(fs.arquivos.size, 0);
});

test('registro {} vazio le como vazio', async () => {
  const r = await ler(CAMINHO, { fs: fsFalso({ [CAMINHO]: '{}' }) });
  assert.equal(r.estado, 'proposto');
  assert.deepEqual(r.itens, {});
});

test('grava, le de volta e guarda sessao, nome e url do item', async () => {
  const fs = fsFalso();
  let r = aprovado();
  r = marcar(r, 'P1', 'disparou', { onde: 'nuvem', sessao: 's-1', nome: 'x-P1', url: 'https://claude.ai/code/s-1' }, { agora });
  await gravar(CAMINHO, r, { fs });
  const lido = await ler(CAMINHO, { fs });
  assert.equal(lido.estado, 'aprovado');
  assert.deepEqual(lido.itens.P1, {
    onde: 'nuvem', sessao: 's-1', nome: 'x-P1', url: 'https://claude.ai/code/s-1',
    disparadoEm: agora, iniciadoEm: null, concluidoEm: null, falhouEm: null, reabertoEm: null, motivo: null,
  });
});

for (const [nome, cru] of [
  ['JSON invalido', '{nao e json'],
  ['JSON que nao e objeto', '[]'],
  ['itens como array', '{"itens": []}'],
  ['itens como string', '{"itens": "x"}'],
  ['item que nao e objeto', '{"itens": {"P1": 3}}'],
  ['sessao vazia', '{"itens": {"P1": {"sessao": ""}}}'],
  ['onde invalido no item', '{"itens": {"P1": {"onde": "marte"}}}'],
  ['marca que nao e numero', '{"itens": {"P1": {"concluidoEm": "ontem"}}}'],
  ['estado do plano inventado', '{"estado": "pausado"}'],
]) {
  test(`registro corrompido recusa em vez de passar por vazio: ${nome}`, async () => {
    await assert.rejects(ler(CAMINHO, { fs: fsFalso({ [CAMINHO]: cru }) }), /corrompido/);
  });
}

test('sessao null e valida: item concluido a mao, sem sessao', async () => {
  const r = await ler(CAMINHO, { fs: fsFalso({ [CAMINHO]: '{"itens": {"P1": {"sessao": null, "concluidoEm": 5}}}' }) });
  assert.equal(r.itens.P1.concluidoEm, 5);
});

test('erro de leitura que nao e ENOENT recusa, em vez de dizer "nada rodando"', async () => {
  const fs = fsFalso();
  fs.readFile = async () => { throw Object.assign(new Error('sem permissão'), { code: 'EACCES' }); };
  await assert.rejects(ler(CAMINHO, { fs }), /não consegui ler/);
});

test('gravar escreve num temporario com o pid e troca de nome: nao sobra .tmp', async () => {
  const fs = fsFalso();
  await gravar(CAMINHO, aprovado(), { fs, pid: 4242 });
  assert.deepEqual(fs.escritas, [`${CAMINHO}.4242.tmp`]);
  assert.deepEqual([...fs.arquivos.keys()], [CAMINHO]);
});

test('rename que falha apaga o temporario e propaga o erro', async () => {
  const fs = fsFalso();
  fs.rename = async () => { throw Object.assign(new Error('disco cheio'), { code: 'ENOSPC' }); };
  await assert.rejects(gravar(CAMINHO, aprovado(), { fs, pid: 1 }), /disco cheio/);
  assert.equal(fs.arquivos.size, 0);
});

test('gravar recusa escrever por cima do registro de outro plano, e o original sobrevive', async () => {
  const fs = fsFalso();
  await gravar(CAMINHO, aprovado(), { fs });
  const antes = fs.arquivos.get(CAMINHO);
  await assert.rejects(gravar(CAMINHO, vazio('/outro/x.md'), { fs }), /é o registro de \/planos\/x.md/);
  assert.equal(fs.arquivos.get(CAMINHO), antes);
});

test('gravar recusa por cima de registro corrompido', async () => {
  await assert.rejects(gravar(CAMINHO, aprovado(), { fs: fsFalso({ [CAMINHO]: 'lixo' }) }), /corrompido/);
});

test('duas escritas de itens DIFERENTES nao se apagam', async () => {
  const fs = fsFalso();
  await gravar(CAMINHO, aprovado(), { fs });
  const a = await ler(CAMINHO, { fs });
  const b = await ler(CAMINHO, { fs });
  await gravar(CAMINHO, marcar(a, 'P1', 'disparou', {}, { agora }), { fs });
  await gravar(CAMINHO, marcar(b, 'P2', 'disparou', {}, { agora: agora + 1 }), { fs });
  const lido = await ler(CAMINHO, { fs });
  assert.deepEqual(Object.keys(lido.itens).sort(), ['P1', 'P2']);
});

test('quem leu antes nao apaga a conclusao que chegou no meio', async () => {
  const fs = fsFalso();
  let r = marcar(aprovado(), 'P1', 'disparou', {}, { agora });
  await gravar(CAMINHO, r, { fs });
  const quadro = await ler(CAMINHO, { fs }); // a Central leu
  const sessao = await ler(CAMINHO, { fs });
  await gravar(CAMINHO, marcar(sessao, 'P1', 'concluiu', {}, { agora: agora + 60_000 }), { fs }); // a sessão concluiu
  await gravar(CAMINHO, marcar(quadro, 'P2', 'disparou', {}, { agora: agora + 30_000 }), { fs }); // a Central grava P2
  const lido = await ler(CAMINHO, { fs });
  assert.equal(lido.itens.P1.concluidoEm, agora + 60_000);
  assert.equal(lido.itens.P2.disparadoEm, agora + 30_000);
});

test('a sessao que leu antes do encerramento e conclui depois nao reabre o plano', async () => {
  const fs = fsFalso();
  await gravar(CAMINHO, marcar(aprovado(), 'P1', 'disparou', {}, { agora }), { fs });
  const sessao = await ler(CAMINHO, { fs });
  const central = await ler(CAMINHO, { fs });
  await gravar(CAMINHO, encerrar(central, { agora: agora + 10 }), { fs });
  await gravar(CAMINHO, marcar(sessao, 'P1', 'concluiu', {}, { agora: agora + 20 }), { fs });
  const lido = await ler(CAMINHO, { fs });
  assert.equal(lido.estado, 'encerrado');
  assert.equal(lido.itens.P1.concluidoEm, agora + 20);
});

test('gravar e ler funcionam com o node:fs/promises de verdade, criando a pasta', async () => {
  const pasta = await fsReal.mkdtemp(path.join(os.tmpdir(), 'central-reg-'));
  try {
    const caminho = path.join(pasta, 'aninhada', 'plano.json');
    await gravar(caminho, marcar(aprovado(), 'P1', 'disparou', { sessao: 's' }, { agora }), { fs: fsReal });
    const lido = await ler(caminho, { fs: fsReal });
    assert.equal(lido.itens.P1.sessao, 's');
    assert.deepEqual(await fsReal.readdir(path.join(pasta, 'aninhada')), ['plano.json']);
  } finally {
    await fsReal.rm(pasta, { recursive: true, force: true });
  }
});

// ---- estado do plano ----

test('plano nasce proposto; aprovar grava a data', () => {
  const r = aprovar(vazio('/p.md'), { agora });
  assert.equal(r.estado, 'aprovado');
  assert.equal(r.aprovadoEm, agora);
});

test('proposto pode ser descartado; descartado nao volta a aprovado', () => {
  const r = descartar(vazio(), { agora });
  assert.equal(r.estado, 'descartado');
  assert.throws(() => aprovar(r, { agora }), /descartado e não pode ir para aprovado/);
});

test('so plano aprovado e encerrado; proposto nao', () => {
  assert.throws(() => encerrar(vazio(), { agora }), /proposto/);
  assert.equal(encerrar(aprovado(), { agora }).estado, 'encerrado');
});

test('so plano aprovado dispara item', () => {
  assert.throws(() => marcar(vazio(), 'P1', 'disparou', {}, { agora }), /só plano aprovado/);
  assert.throws(() => marcar(descartar(vazio()), 'P1', 'entregou-projects', {}, { agora }), /descartado/);
});

// ---- marcar ----

test('marcar e pura: o registro recebido nao muda', () => {
  const r = aprovado();
  const copia = structuredClone(r);
  const novo = marcar(r, 'P1', 'disparou', {}, { agora });
  assert.deepEqual(r, copia);
  assert.notEqual(novo, r);
});

test('evento desconhecido, id torto, onde invalido e sessao vazia recusam', () => {
  assert.throws(() => marcar(aprovado(), 'P1', 'explodiu', {}, { agora }), /evento desconhecido/);
  assert.throws(() => marcar(aprovado(), 'P1a', 'disparou', {}, { agora }), /fora do formato/);
  assert.throws(() => marcar(aprovado(), 'P1', 'disparou', { onde: 'marte' }, { agora }), /onde "marte"/);
  assert.throws(() => marcar(aprovado(), 'P1', 'iniciou', { sessao: '' }, { agora }), /sessão inválida/);
});

test('os eventos e estados sao listas fechadas', () => {
  assert.deepEqual(EVENTOS, ['disparou', 'iniciou', 'concluiu', 'falhou', 'entregou-projects', 'reabriu']);
  assert.deepEqual(ESTADOS_DO_ITEM, ['bloqueado', 'pronto', 'disparado', 'iniciado', 'concluido', 'entregue-projects', 'falhou']);
});

test('disparar de novo zera as marcas: e uma execucao nova', () => {
  let r = marcar(aprovado(), 'P1', 'concluiu', {}, { agora });
  r = marcar(r, 'P1', 'disparou', { sessao: 's2' }, { agora: agora + 5 });
  assert.equal(r.itens.P1.concluidoEm, null);
  assert.equal(r.itens.P1.iniciadoEm, null);
  assert.equal(r.itens.P1.disparadoEm, agora + 5);
  assert.equal(r.itens.P1.sessao, 's2');
});

test('iniciar duas vezes pela mesma sessao nao mexe: a primeira marca vale', () => {
  let r = marcar(aprovado(), 'P1', 'iniciou', { sessao: 's' }, { agora });
  r = marcar(r, 'P1', 'iniciou', { sessao: 's' }, { agora: agora + 99 });
  assert.equal(r.itens.P1.iniciadoEm, agora);
});

test('iniciar por OUTRA sessao e execucao nova: troca a sessao e zera a conclusao', () => {
  let r = marcar(aprovado(), 'P1', 'concluiu', { sessao: 'a' }, { agora });
  r = marcar(r, 'P1', 'iniciou', { sessao: 'b' }, { agora: agora + 1 });
  assert.equal(r.itens.P1.sessao, 'b');
  assert.equal(r.itens.P1.concluidoEm, null);
  assert.equal(r.itens.P1.iniciadoEm, agora + 1);
});

test('concluir sem ter iniciado grava as duas marcas juntas', () => {
  const r = marcar(aprovado(), 'P1', 'concluiu', {}, { agora });
  assert.equal(r.itens.P1.iniciadoEm, agora);
  assert.equal(r.itens.P1.concluidoEm, agora);
});

test('concluir duas vezes nao mexe: a primeira data sobrevive', () => {
  let r = marcar(aprovado(), 'P1', 'concluiu', {}, { agora });
  r = marcar(r, 'P1', 'concluiu', {}, { agora: agora + 9 });
  assert.equal(r.itens.P1.concluidoEm, agora);
});

test('falhou grava a hora e o motivo; item concluido nao volta a falhar', () => {
  let r = marcar(aprovado(), 'P1', 'falhou', { motivo: 'teste vermelho' }, { agora });
  assert.equal(r.itens.P1.falhouEm, agora);
  assert.equal(r.itens.P1.motivo, 'teste vermelho');
  r = marcar(r, 'P1', 'concluiu', {}, { agora: agora + 1 });
  assert.equal(r.itens.P1.falhouEm, null);
  r = marcar(r, 'P1', 'falhou', { motivo: 'x' }, { agora: agora + 2 });
  assert.equal(r.itens.P1.falhouEm, null);
});

// ---- estado de cada item e as travas ----

test('caminho feliz: nada bloqueia', () => {
  assert.deepEqual(estadoDosItens(plano(item('P1')), aprovado(), { agora }), { P1: 'pronto' });
});

test('as marcas dao o estado: disparado, iniciado, concluido, falhou', () => {
  let r = aprovado();
  r = marcar(r, 'P1', 'disparou', {}, { agora });
  r = marcar(r, 'P2', 'iniciou', { sessao: 's' }, { agora });
  r = marcar(r, 'P3', 'concluiu', {}, { agora });
  r = marcar(r, 'P4', 'falhou', { motivo: 'm' }, { agora });
  const p = plano(item('P1'), item('P2'), item('P3'), item('P4'));
  assert.deepEqual(estadoDosItens(p, r, { agora }), { P1: 'disparado', P2: 'iniciado', P3: 'concluido', P4: 'falhou' });
});

test('depende de item nunca disparado bloqueia e diz qual', () => {
  const d = detalharEstados(plano(item('P1'), item('P2', { depende: ['P1'] })), aprovado(), { agora });
  assert.equal(d.P2.estado, 'bloqueado');
  assert.equal(d.P2.motivo, 'depende de P1, que ainda não foi disparada');
});

test('depende de item em andamento ou que falhou bloqueia, cada um com a sua frase', () => {
  const p = plano(item('P1'), item('P2', { depende: ['P1'] }));
  let r = marcar(aprovado(), 'P1', 'disparou', {}, { agora });
  assert.match(detalharEstados(p, r).P2.motivo, /foi disparada e ainda não começou/);
  r = marcar(r, 'P1', 'iniciou', { sessao: 's' }, { agora });
  assert.match(detalharEstados(p, r).P2.motivo, /está em andamento/);
  r = marcar(r, 'P1', 'falhou', { motivo: 'build quebrou' }, { agora });
  assert.equal(detalharEstados(p, r).P2.motivo, 'depende de P1, que falhou (build quebrou)');
});

test('dependencia concluida libera', () => {
  const p = plano(item('P1'), item('P2', { depende: ['P1'] }));
  const r = marcar(aprovado(), 'P1', 'concluiu', {}, { agora });
  assert.equal(estadoDosItens(p, r).P2, 'pronto');
});

test('conflito declarado de um lado so vale para os dois', () => {
  const itens = [item('P1', { conflita: ['P2'] }), item('P2')];
  assert.deepEqual(conflitantes(itens, 'P2'), ['P1']);
  assert.deepEqual(conflitantes([{ id: 'P1' }, { id: 'P2' }], 'P1'), []);
});

test('conflito com item em andamento bloqueia; concluido ou falho nao', () => {
  const p = plano(item('P1', { conflita: ['P2'] }), item('P2'));
  let r = marcar(aprovado(), 'P2', 'iniciou', { sessao: 's' }, { agora });
  assert.equal(detalharEstados(p, r).P1.motivo, 'conflita com P2, que está em andamento');
  r = marcar(r, 'P2', 'concluiu', {}, { agora });
  assert.equal(estadoDosItens(p, r).P1, 'pronto');
  r = marcar(marcar(aprovado(), 'P2', 'disparou', {}, { agora }), 'P2', 'falhou', {}, { agora });
  assert.equal(estadoDosItens(p, r).P1, 'pronto');
});

test('exclusivo=repo bloqueia enquanto outro item do plano roda na mesma pasta', () => {
  const p = plano(item('P1', { exclusivo: 'repo' }), item('P2'), item('P3', { repo: '~/Projects/outro' }));
  let r = marcar(aprovado(), 'P3', 'disparou', {}, { agora });
  assert.equal(estadoDosItens(p, r).P1, 'pronto');
  r = marcar(r, 'P2', 'disparou', {}, { agora });
  const d = detalharEstados(p, r);
  assert.equal(d.P1.estado, 'bloqueado');
  assert.match(d.P1.motivo, /exclusivo=repo/);
});

test('porta e custo nao bloqueiam: viram aviso', () => {
  const d = detalharEstados(plano(item('P1', { porta: 'merge na main', custo: 'zero' })), aprovado());
  assert.equal(d.P1.estado, 'pronto');
  assert.deepEqual(d.P1.avisos, ['porta única: merge na main', 'custo: zero']);
});

test('plano proposto calcula as travas: pronto = dispara quando aprovar', () => {
  const p = plano(item('P1'), item('P2', { depende: ['P1'] }));
  assert.deepEqual(estadoDosItens(p, vazio()), { P1: 'pronto', P2: 'bloqueado' });
});

test('plano descartado ou encerrado bloqueia o que nao saiu do lugar, e mantem o historico', () => {
  const p = plano(item('P1'), item('P2'));
  const r = encerrar(marcar(aprovado(), 'P1', 'concluiu', {}, { agora }), { agora });
  assert.deepEqual(estadoDosItens(p, r), { P1: 'concluido', P2: 'bloqueado' });
  assert.equal(detalharEstados(p, descartar(vazio())).P1.motivo, 'o plano foi descartado');
});

test('detalharEstados diz ha quantos minutos o item esta no estado', () => {
  const r = marcar(aprovado(), 'P1', 'disparou', {}, { agora });
  assert.equal(detalharEstados(plano(item('P1')), r, { agora: agora + 7 * 60_000 }).P1.minutos, 7);
});

// ---- nuvem e Projects ----

test('item da nuvem concluido: guarda a url, conclui sem iniciou e libera a dependente', () => {
  const p = plano(item('P1', { onde: 'nuvem' }), item('P2', { depende: ['P1'] }));
  let r = marcar(aprovado(), 'P1', 'disparou', { onde: 'nuvem', sessao: 'cse_1', url: 'https://claude.ai/code/cse_1' }, { agora });
  assert.equal(estadoDosItens(p, r).P1, 'disparado');
  // a nuvem não alcança a máquina: o fim vem da Central, que viu o PR da branch
  r = marcar(r, 'P1', 'concluiu', {}, { agora: agora + 3_600_000 });
  assert.equal(r.itens.P1.onde, 'nuvem');
  assert.equal(r.itens.P1.url, 'https://claude.ai/code/cse_1');
  assert.equal(r.itens.P1.iniciadoEm, agora + 3_600_000);
  assert.deepEqual(estadoDosItens(p, r), { P1: 'concluido', P2: 'pronto' });
});

test('entregue ao Projects: estado proprio, em andamento para os conflitos, e conta no % so ao concluir', () => {
  const p = plano(item('P1', { onde: 'projects' }), item('P2', { conflita: ['P1'] }), item('P3', { depende: ['P1'] }));
  let r = marcar(aprovado(), 'P1', 'entregou-projects', {}, { agora });
  assert.equal(r.itens.P1.onde, 'projects');
  assert.ok(emAndamento(r.itens.P1));
  const d = detalharEstados(p, r);
  assert.deepEqual([d.P1.estado, d.P2.estado, d.P3.estado], ['entregue-projects', 'bloqueado', 'bloqueado']);
  assert.match(d.P3.motivo, /Claude Projects/);
  assert.deepEqual(progresso(p, r), { concluidos: 0, total: 3, pct: 0 });
  r = marcar(r, 'P1', 'concluiu', {}, { agora: agora + 1 }); // botão "Concluído no Projects"
  assert.equal(estadoDosItens(p, r).P1, 'concluido');
  assert.deepEqual(progresso(p, r), { concluidos: 1, total: 3, pct: 33 });
});

test('disparou com onde=projects tambem vira entregue-projects', () => {
  const r = marcar(aprovado(), 'P1', 'disparou', { onde: 'projects' }, { agora });
  assert.equal(estadoDosItens(plano(item('P1')), r).P1, 'entregue-projects');
});

// ---- progresso ----

test('progresso em %: inteiro, arredonda para baixo, 100 so com tudo concluido', () => {
  const p = plano(item('P1'), item('P2'), item('P3'));
  let r = aprovado();
  assert.deepEqual(progresso(p, r), { concluidos: 0, total: 3, pct: 0 });
  r = marcar(r, 'P1', 'concluiu', {}, { agora });
  r = marcar(r, 'P2', 'concluiu', {}, { agora });
  assert.deepEqual(progresso(p, r), { concluidos: 2, total: 3, pct: 66 });
  r = marcar(r, 'P3', 'concluiu', {}, { agora });
  assert.deepEqual(progresso(p, r), { concluidos: 3, total: 3, pct: 100 });
});

test('progresso ignora id que so existe no registro, e nao conta falhou nem em andamento', () => {
  const p = plano(item('P1'), item('P2'));
  let r = marcar(aprovado(), 'P9', 'concluiu', {}, { agora });
  r = marcar(r, 'P1', 'falhou', {}, { agora });
  r = marcar(r, 'P2', 'iniciou', {}, { agora });
  assert.deepEqual(progresso(p, r), { concluidos: 0, total: 2, pct: 0 });
});

test('plano sem itens tem progresso 0, sem dividir por zero', () => {
  assert.deepEqual(progresso(plano(), aprovado()), { concluidos: 0, total: 0, pct: 0 });
});

// ---- de ponta a ponta com o exemplo ----

test('o plano de exemplo anda do proposto ao 100%', async () => {
  const texto = await fsReal.readFile(new URL('../central/planos/exemplo.md', import.meta.url), 'utf8');
  const p = lerPlano(texto);
  let r = vazio('/planos/exemplo.md');
  assert.deepEqual(estadoDosItens(p, r), { P1: 'pronto', P2: 'bloqueado', P3: 'bloqueado', P4: 'bloqueado', P5: 'bloqueado' });
  r = aprovar(r, { agora });
  r = marcar(r, 'P1', 'disparou', {}, { agora });
  r = marcar(r, 'P1', 'concluiu', {}, { agora });
  assert.deepEqual(estadoDosItens(p, r), { P1: 'concluido', P2: 'pronto', P3: 'pronto', P4: 'bloqueado', P5: 'bloqueado' });
  r = marcar(r, 'P2', 'disparou', {}, { agora });
  // P3 conflita com P2 em andamento
  assert.equal(estadoDosItens(p, r).P3, 'bloqueado');
  r = marcar(r, 'P2', 'concluiu', {}, { agora });
  r = marcar(r, 'P3', 'disparou', { onde: 'nuvem' }, { agora });
  r = marcar(r, 'P3', 'concluiu', {}, { agora });
  r = marcar(r, 'P4', 'entregou-projects', {}, { agora });
  assert.equal(progresso(p, r).pct, 60);
  r = marcar(r, 'P4', 'concluiu', {}, { agora });
  r = marcar(r, 'P5', 'concluiu', {}, { agora });
  assert.deepEqual(progresso(p, r), { concluidos: 5, total: 5, pct: 100 });
});
