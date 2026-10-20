import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALA_PADRAO, EIXOS, validarEscala, calcularEscala, tendenciaEscala } from '../central/score/escala.mjs';
import { PESOS_PADRAO, DIMENSOES, calcular } from '../central/score/score.mjs';

const nota = (r, chave) => r.eixos.find((e) => e.chave === chave).nota;
const so = (chave, fonte, pesos) => nota(calcularEscala({ [chave]: fonte }, pesos), chave);
const degraus = (...lista) => ({ degraus: lista.map(([multiplicador, p95Ms, extra]) => ({ multiplicador, p95Ms, ...extra })) });

test('5 eixos com os pesos da arquitetura, somando 100', () => {
  assert.deepEqual(EIXOS.map((e) => e.chave), ['carga', 'dados', 'estado-infra', 'custo-unidade', 'manutencao']);
  assert.deepEqual({ ...ESCALA_PADRAO.pesos }, { carga: 35, dados: 25, 'estado-infra': 20, 'custo-unidade': 10, manutencao: 10 });
  assert.equal(ESCALA_PADRAO.alvos.p95Ms, 800);
  assert.deepEqual(validarEscala(ESCALA_PADRAO), []);
  assert.match(validarEscala({ pesos: { ...ESCALA_PADRAO.pesos, carga: 30 } }).join(), /somam 95/);
  assert.ok(validarEscala({ pesos: { ...ESCALA_PADRAO.pesos, seguranca: 0 } }).length > 0);
  assert.throws(() => calcularEscala({}, { pesos: { carga: 100 } }));
});

test('a escala fica à parte: o score continua com 7 dimensões e os mesmos pesos', () => {
  assert.equal(DIMENSOES.length, 7);
  assert.deepEqual(Object.values(PESOS_PADRAO.pesos), [20, 20, 15, 15, 15, 10, 5]);
  const r = calcular({ seguranca: {} });
  assert.ok(!('eixos' in r));
  assert.ok(!r.dimensoes.some((d) => EIXOS.some((e) => e.chave === d.chave)));
});

test('Carga: 100 no 10×, 70 no 5×, 40 no 2×, 10 no 1×, 0 se falha no 1×', () => {
  assert.equal(so('carga', degraus([1, 200], [2, 300], [5, 500], [10, 790])), 100);
  assert.equal(so('carga', degraus([1, 200], [2, 300], [5, 500], [10, 2100])), 70);
  assert.equal(so('carga', degraus([1, 200], [2, 300], [5, 900])), 40);
  assert.equal(so('carga', degraus([1, 200], [2, 300, { falhou: true }])), 10);
  assert.equal(so('carga', degraus([1, 1200])), 0);
  assert.equal(so('carga', degraus([1, 100, { falhou: true }])), 0);
});

test('Carga: para no primeiro degrau que falha; sem 1× = sem dado; alvo configurável', () => {
  assert.equal(so('carga', degraus([1, 200], [2, 900], [5, 300], [10, 300])), 10);
  assert.equal(so('carga', degraus([1, 200], [2, 300])), 40, 'mediu só até 2×');
  assert.equal(so('carga', degraus([2, 300])), null);
  assert.equal(so('carga', { degraus: [] }), null);
  const pesos = { pesos: { ...ESCALA_PADRAO.pesos }, alvos: { p95Ms: 1000 } };
  assert.equal(so('carga', degraus([1, 200], [2, 300], [5, 900], [10, 950]), pesos), 100);
});

test('Dados: −8 por achado em tabela que cresce, −3 nos demais, piso 0', () => {
  assert.equal(so('dados', { achados: [] }), 100);
  assert.equal(so('dados', { achados: [{ tabelaCresce: true }, { tabelaCresce: false }, {}] }), 100 - 8 - 3 - 3);
  assert.equal(so('dados', { achados: Array.from({ length: 13 }, () => ({ tabelaCresce: true })) }), 0);
});

test('Estado e infra: −15 por serviço sem réplica, −5 por estado em memória', () => {
  assert.equal(so('estado-infra', {}), 100);
  assert.equal(so('estado-infra', { servicosSemReplica: [{ servico: 'web' }], estadoEmMemoria: [{}, {}] }), 75);
  assert.equal(so('estado-infra', { servicosSemReplica: Array(7).fill({}) }), 0);
});

test('Custo por unidade: −20 por chamada sem teto, −10 por chamada em loop', () => {
  assert.equal(so('custo-unidade', {}), 100);
  assert.equal(so('custo-unidade', { chamadasSemTeto: [{}], chamadasEmLoop: [{}, {}] }), 60);
  assert.equal(so('custo-unidade', { chamadasSemTeto: Array(6).fill({}) }), 0);
});

test('Manutenção: −5 por achado, piso 0', () => {
  assert.equal(so('manutencao', { achados: [] }), 100);
  assert.equal(so('manutencao', { achados: [{}, {}, {}] }), 85);
  assert.equal(so('manutencao', { achados: Array(30).fill({}) }), 0);
});

test('geral ponderada; "sem dado" sai da média', () => {
  const tudo = calcularEscala({
    carga: degraus([1, 100], [2, 100], [5, 100], [10, 3000]), // 70 × 35
    dados: { achados: [{ tabelaCresce: true }] }, // 92 × 25
    'estado-infra': { estadoEmMemoria: [{}] }, // 95 × 20
    'custo-unidade': {}, // 100 × 10
    manutencao: { achados: [{}] }, // 95 × 10
  });
  assert.equal(tudo.geral, Math.round((70 * 35 + 92 * 25 + 95 * 20 + 100 * 10 + 95 * 10) / 100));
  const parcial = calcularEscala({ dados: { achados: [{}, {}] }, manutencao: { achados: [] } });
  assert.equal(parcial.geral, Math.round((94 * 25 + 100 * 10) / 35));
  assert.equal(parcial.eixos.filter((e) => e.nota === null).length, 3);
  assert.ok(Math.abs(parcial.eixos.reduce((s, e) => s + e.pesoEfetivo, 0) - 100) < 1e-9);
  const nada = calcularEscala({});
  assert.equal(nada.geral, null);
  assert.equal(nada.primeiroGargalo, null);
});

test('primeiroGargalo da Carga em linguagem direta, com arquivo:linha', () => {
  const r = calcularEscala({
    carga: degraus([1, 100], [2, 100], [5, 400], [10, 2100, {
      fluxo: 'o envio de mensagem', motivo: 'cada envio abre uma conexão nova com o banco',
      arquivo: 'src/app/api/mensagens/route.ts', linha: 42,
    }]),
    dados: { achados: [{ tabelaCresce: false }] },
  });
  assert.equal(r.primeiroGargalo.eixo, 'carga');
  assert.equal(r.primeiroGargalo.local, 'src/app/api/mensagens/route.ts:42');
  assert.equal(r.primeiroGargalo.texto,
    'Aguenta 5×; no 10× o envio de mensagem passa de 2,1 s no p95 (alvo 800 ms) porque cada envio abre uma conexão nova com o banco. (src/app/api/mensagens/route.ts:42)');
});

test('primeiroGargalo: falha no 1× e degrau não medido', () => {
  const r = calcularEscala({ carga: degraus([1, 1500, { fluxo: 'o login' }]) });
  assert.match(r.primeiroGargalo.texto, /^Não aguenta nem 1×: o login passa de 1,5 s/);
  assert.equal(r.primeiroGargalo.local, null);
  const r2 = calcularEscala({ carga: degraus([1, 100], [2, 100]) });
  assert.equal(r2.primeiroGargalo.texto, 'Aguenta 2×; o degrau de 5× ainda não foi medido.');
});

test('primeiroGargalo vai para o eixo que mais tira pontos', () => {
  const r = calcularEscala({
    carga: degraus([1, 100], [2, 100], [5, 100], [10, 100]),
    'estado-infra': { servicosSemReplica: [{ servico: 'meu-servico', descricao: 'fila guardada em variável', arquivo: 'app/fila.py', linha: 10 }] },
    manutencao: { achados: [{ descricao: 'arquivo com 1.200 linhas', arquivo: 'a.ts' }] },
  });
  assert.equal(r.primeiroGargalo.eixo, 'estado-infra');
  assert.equal(r.primeiroGargalo.texto, 'O serviço meu-servico não pode rodar com 2 réplicas: fila guardada em variável. (app/fila.py:10)');
  const tudoBem = calcularEscala({ carga: degraus([1, 1], [2, 1], [5, 1], [10, 1]), dados: { achados: [] } });
  assert.equal(tudoBem.geral, 100);
  assert.equal(tudoBem.primeiroGargalo, null);
});

test('tendência da escala lê escala.jsonl', () => {
  const r1 = calcularEscala({ manutencao: { achados: [{}] } });
  const r2 = calcularEscala({ manutencao: { achados: [{}, {}, {}] } });
  const texto = [JSON.stringify({ data: '2026-10-19', ...r1 }), JSON.stringify({ data: '2026-10-20', ...r2 })].join('\n');
  const t = tendenciaEscala(texto);
  assert.deepEqual(t.eixos.manutencao, { atual: 85, anterior: 95, delta: -10, direcao: 'desce', seta: '↓' });
  assert.equal(t.geral.direcao, 'desce');
  assert.equal(Object.keys(t.eixos).length, 5);
  assert.equal(t.eixos.carga.direcao, 'sem-dado');
});
