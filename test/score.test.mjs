import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PESOS_PADRAO, DIMENSOES, validarPesos, calcular, tendencia } from '../central/score/score.mjs';

const nota = (r, chave) => r.dimensoes.find((d) => d.chave === chave).nota;
const so = (chave, fonte, pesos) => nota(calcular({ [chave]: fonte }, pesos), chave);
const comAlvos = (alvos) => ({ pesos: { ...PESOS_PADRAO.pesos }, alvos: { ...PESOS_PADRAO.alvos, ...alvos } });

test('o score continua com 7 dimensões e os mesmos pesos (docs/arquitetura.md)', () => {
  assert.deepEqual(DIMENSOES.map((d) => d.chave), ['seguranca', 'bugs', 'velocidade', 'apis', 'testes', 'fluxo', 'ambientes']);
  assert.deepEqual({ ...PESOS_PADRAO.pesos }, { seguranca: 20, bugs: 20, velocidade: 15, apis: 15, testes: 15, fluxo: 10, ambientes: 5 });
  assert.deepEqual({ ...PESOS_PADRAO.alvos }, { lighthouse: 90, apiMs: 800, diasParado: 7 });
  const r = calcular({});
  assert.equal(r.dimensoes.length, 7);
  assert.deepEqual(r.dimensoes.map((d) => d.peso), [20, 20, 15, 15, 15, 10, 5]);
});

test('pesos padrão somam 100 e validarPesos recusa outra soma', () => {
  assert.deepEqual(validarPesos(PESOS_PADRAO), []);
  const ruim = { pesos: { ...PESOS_PADRAO.pesos, ambientes: 6 } };
  assert.match(validarPesos(ruim).join(), /somam 101/);
  assert.match(validarPesos({ pesos: { ...PESOS_PADRAO.pesos, extra: 0 } }).join(), /desconhecido/);
  const semUm = { pesos: { ...PESOS_PADRAO.pesos } }; delete semUm.pesos.fluxo;
  assert.ok(validarPesos(semUm).length > 0);
  assert.ok(validarPesos({ pesos: { ...PESOS_PADRAO.pesos, testes: 15.5, fluxo: 9.5 } }).length > 0);
  assert.ok(validarPesos({ pesos: { ...PESOS_PADRAO.pesos }, alvos: { apiMs: -1 } }).length > 0);
  assert.ok(validarPesos({ pesos: { ...PESOS_PADRAO.pesos }, alvos: { qualquer: 1 } }).length > 0);
  assert.ok(validarPesos(null).length > 0);
  assert.throws(() => calcular({}, ruim), /100/);
});

test('Segurança: −25 crítico, −10 alto, −3 médio, piso 0', () => {
  assert.equal(so('seguranca', { criticos: 0, altos: 0, medios: 0 }), 100);
  assert.equal(so('seguranca', { criticos: 1, altos: 2, medios: 3 }), 100 - 25 - 20 - 9);
  assert.equal(so('seguranca', { criticos: 5 }), 0);
});

test('Bugs: −15 urgente, −5 normal, −2 achado de interface, piso 0', () => {
  assert.equal(so('bugs', {}), 100);
  assert.equal(so('bugs', { urgentes: 1, normais: 2, achadosInterface: 3 }), 100 - 15 - 10 - 6);
  assert.equal(so('bugs', { urgentes: 10 }), 0);
});

test('Velocidade: média do Lighthouse; 100 a partir do alvo (configurável)', () => {
  assert.equal(so('velocidade', { paginas: [{ performance: 80 }, { performance: 71 }] }), 76);
  assert.equal(so('velocidade', { paginas: [{ performance: 90 }, { performance: 92 }] }), 100);
  assert.equal(so('velocidade', { paginas: [{ performance: 85 }] }, comAlvos({ lighthouse: 80 })), 100);
  assert.equal(so('velocidade', { paginas: [] }), null);
});

test('APIs: 100 × dentro do alvo ÷ total; alvo configurável', () => {
  const procs = { processos: [{ nome: 'login', ms: 300 }, { nome: 'funil', ms: 800 }, { nome: 'envio', ms: 1500 }, { nome: 'cadastro', ms: 2000 }] };
  assert.equal(so('apis', procs), 50);
  assert.equal(so('apis', procs, comAlvos({ apiMs: 1500 })), 75);
  assert.equal(so('apis', { processos: [] }), null);
});

test('Testes: 100 × verdes ÷ total, −20 se a principal está vermelha', () => {
  assert.equal(so('testes', { verdes: 10, total: 10 }), 100);
  assert.equal(so('testes', { verdes: 3, total: 4 }), 75);
  assert.equal(so('testes', { verdes: 3, total: 4, principalVermelha: true }), 55);
  assert.equal(so('testes', { verdes: 0, total: 4, principalVermelha: true }), 0);
  assert.equal(so('testes', { verdes: 0, total: 0 }), null);
});

test('Fluxo: −10 por tarefa parada há mais que o alvo de dias', () => {
  const f = { fazendo: [{ id: 'T-1', diasParado: 8 }, { id: 'T-2', diasParado: 7 }, { id: 'T-3', diasParado: 20 }] };
  assert.equal(so('fluxo', f), 80);
  assert.equal(so('fluxo', f, comAlvos({ diasParado: 3 })), 70);
  assert.equal(so('fluxo', { fazendo: [] }), 100);
  assert.equal(so('fluxo', { fazendo: Array.from({ length: 12 }, () => ({ diasParado: 30 })) }), 0);
});

test('Ambientes: 100 × checagens ok ÷ total', () => {
  assert.equal(so('ambientes', { ok: 47, total: 48 }), 98);
  assert.equal(so('ambientes', { ok: 0, total: 0 }), null);
});

test('geral é a média ponderada com todas as dimensões', () => {
  const r = calcular({
    seguranca: { criticos: 0, altos: 1, medios: 0 }, // 90 × 20
    bugs: { normais: 4 }, // 80 × 20
    velocidade: { paginas: [{ performance: 70 }] }, // 70 × 15
    apis: { processos: [{ ms: 100 }, { ms: 900 }] }, // 50 × 15
    testes: { verdes: 1, total: 1 }, // 100 × 15
    fluxo: { fazendo: [] }, // 100 × 10
    ambientes: { ok: 1, total: 2 }, // 50 × 5
  });
  assert.equal(r.geral, Math.round((90 * 20 + 80 * 20 + 70 * 15 + 50 * 15 + 100 * 15 + 100 * 10 + 50 * 5) / 100));
  assert.equal(r.maisPuxa, 'apis');
  assert.ok(r.dimensoes.every((d) => typeof d.motivo === 'string' && d.motivo));
});

test('"sem dado" fica fora da média e os pesos são redistribuídos', () => {
  const r = calcular({ seguranca: { criticos: 2 }, testes: { verdes: 1, total: 1 } });
  // segurança 50 (peso 20) e testes 100 (peso 15): 7000/35 = 200
  assert.equal(r.geral, Math.round((50 * 20 + 100 * 15) / 35));
  const sem = r.dimensoes.filter((d) => d.nota === null);
  assert.equal(sem.length, 5);
  assert.ok(sem.every((d) => d.pesoEfetivo === 0 && d.motivo.startsWith('sem dado')));
  const efetivo = r.dimensoes.reduce((s, d) => s + d.pesoEfetivo, 0);
  assert.ok(Math.abs(efetivo - 100) < 1e-9);
  assert.ok(Math.abs(r.dimensoes[0].pesoEfetivo - (100 * 20) / 35) < 1e-9);
  assert.equal(r.dimensoes[0].peso, 20, 'o peso configurado não muda');
});

test('nenhuma fonte = geral null, sem nota falsa', () => {
  const r = calcular({});
  assert.equal(r.geral, null);
  assert.equal(r.maisPuxa, null);
  assert.ok(r.dimensoes.every((d) => d.nota === null));
});

test('pesos customizados mudam a geral', () => {
  const pesos = { pesos: { seguranca: 50, bugs: 50, velocidade: 0, apis: 0, testes: 0, fluxo: 0, ambientes: 0 } };
  const r = calcular({ seguranca: {}, bugs: { urgentes: 2 }, testes: { verdes: 0, total: 1 } }, pesos);
  assert.equal(r.geral, 85);
});

test('tendência: sobe, desce, estável, sem histórico e sem dado', () => {
  const hist = [
    { data: '2026-10-18', geral: 70, dimensoes: { seguranca: 80, bugs: 90, testes: null } },
    { data: '2026-10-19', geral: 75, dimensoes: { seguranca: 70, bugs: 90, testes: 100 } },
    { data: '2026-10-20', geral: 78, dimensoes: { seguranca: 85, bugs: 90, testes: 100, apis: 40 } },
  ];
  const t = tendencia(hist);
  assert.deepEqual(t.geral, { atual: 78, anterior: 75, delta: 3, direcao: 'sobe', seta: '↑' });
  assert.equal(t.dimensoes.seguranca.direcao, 'sobe');
  assert.equal(t.dimensoes.bugs.direcao, 'estavel');
  assert.equal(t.dimensoes.testes.direcao, 'estavel');
  assert.equal(t.dimensoes.apis.direcao, 'sem-historico');
  assert.equal(t.dimensoes.fluxo.direcao, 'sem-dado');
  assert.equal(Object.keys(t.dimensoes).length, 7);
  const queda = tendencia([{ geral: 90 }, { geral: 60 }]);
  assert.equal(queda.geral.direcao, 'desce');
  assert.equal(queda.geral.delta, -30);
  assert.equal(queda.geral.seta, '↓');
});

test('tendência pula o dia sem dado e lê score.jsonl em texto (e a saída de calcular)', () => {
  const r1 = calcular({ seguranca: { criticos: 1 } });
  const r2 = calcular({ seguranca: {} });
  const texto = [
    JSON.stringify({ data: '2026-10-18', ...r1 }),
    'linha quebrada',
    JSON.stringify({ data: '2026-10-19', geral: null, dimensoes: { seguranca: null } }),
    '',
    JSON.stringify({ data: '2026-10-20', ...r2 }),
  ].join('\n');
  const t = tendencia(texto);
  assert.deepEqual(t.dimensoes.seguranca, { atual: 100, anterior: 75, delta: 25, direcao: 'sobe', seta: '↑' });
  assert.equal(t.geral.anterior, 75);
  assert.equal(tendencia([]).geral.direcao, 'sem-dado');
});
