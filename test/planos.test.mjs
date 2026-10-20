/**
 * Testes do C1 (central/planos/plano.mjs). Os que vêm do escritório
 * (vendor/escritorio/test-plano.test.js) foram portados para o formato novo:
 * lerPlano devolve { titulo, itens, erros }, `modo` saiu e `onde` entrou.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  lerAtributos, limparTitulo, lerPlano, conferir, conferirItens, conferirCercas, aplicarPapel,
  CHAVES, ONDES, PERMISSOES, PERMISSAO_PADRAO,
} from '../central/planos/plano.mjs';

const PAPEIS = {
  orquestrador: { modelo: 'claude-opus-5-5', esforco: 'medium', onde: 'local', permissao: 'plan' },
  lider: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'default' },
  executor: { modelo: 'claude-sonnet-5-5', esforco: 'medium', onde: 'local', permissao: 'acceptEdits' },
  verificador: { modelo: 'claude-sonnet-5-5', esforco: 'low', onde: 'nuvem', permissao: 'default' },
  rapido: { modelo: 'claude-haiku-5-5', esforco: 'low', onde: 'local', permissao: 'default' },
};

const DOC = [
  '# Prompts — fila das próximas sessões',
  '',
  '## P1 — Reservar 124 a 127 no CHANGELOG *(Ana · repo `meu-repo` · ~15 min)*',
  '',
  '```prompt id=P1 repo=~/Projects/meu-repo porta="merge na main" custo=zero',
  'Reservar no CHANGELOG os numeros 124 a 127.',
  '',
  'PASSOS: conferir, acrescentar, abrir PR.',
  '```',
  '',
  '## P3 — Executar a #503: registro de ferramentas',
  '',
  '```prompt id=P3 repo=~/Projects/meu-repo depende=P1 conflita=P4,P6 modelo=claude-opus-5-5',
  'Executar o plano da #503.',
  '```',
  '',
  '```',
  'bloco comum: nao e prompt e nao pode virar item',
  '```',
].join('\n');

const um = (cabecalho, corpo = 'faca') => ['## P1 — x', '', `\`\`\`prompt ${cabecalho}`, corpo, '```'].join('\n');

// ---- leitura (portado do escritório) ----

test('le os atributos do cabecalho, inclusive valor com espaco entre aspas', () => {
  const a = lerAtributos(' id=P1 repo=~/Projects/um porta="merge na main" custo=zero');
  assert.deepEqual(a, { id: 'P1', repo: '~/Projects/um', porta: 'merge na main', custo: 'zero' });
});

test('o titulo perde o id, o travessao e o parentetico em italico', () => {
  const bruto = 'P1 — Reservar 124 a 127 no CHANGELOG *(Ana · repo `meu-repo` · ~15 min)*';
  assert.equal(limparTitulo(bruto, 'P1'), 'Reservar 124 a 127 no CHANGELOG');
});

test('o titulo do plano e o primeiro # do documento', () => {
  assert.equal(lerPlano(DOC).titulo, 'Prompts — fila das próximas sessões');
});

test('cada bloco prompt vira um item, na ordem do documento', () => {
  assert.deepEqual(lerPlano(DOC).itens.map((i) => i.id), ['P1', 'P3']);
});

test('o item traz repo, dependencia, conflito, porta e o prompt inteiro', () => {
  const [p1, p3] = lerPlano(DOC).itens;
  assert.equal(p1.repo, '~/Projects/meu-repo');
  assert.equal(p1.porta, 'merge na main');
  assert.equal(p1.custo, 'zero');
  assert.equal(p1.titulo, 'Reservar 124 a 127 no CHANGELOG');
  assert.deepEqual(p1.depende, []);
  assert.equal(p1.prompt, 'Reservar no CHANGELOG os numeros 124 a 127.\n\nPASSOS: conferir, acrescentar, abrir PR.');
  assert.deepEqual(p3.depende, ['P1']);
  assert.deepEqual(p3.conflita, ['P4', 'P6']);
  assert.equal(p3.modelo, 'claude-opus-5-5');
});

test('porta, custo e exclusivo ausentes sao null (contrato C1)', () => {
  const [, p3] = lerPlano(DOC).itens;
  assert.equal(p3.porta, null);
  assert.equal(p3.custo, null);
  assert.equal(p3.exclusivo, null);
});

test('a linha do bloco fica guardada para a mensagem de erro', () => {
  assert.equal(lerPlano(DOC).itens[0].linha, 5);
});

test('bloco de codigo comum nao vira item, nem o exemplo dentro de cerca maior', () => {
  const doc = [
    '## Como escrever', '', '````',
    '```prompt id=P9 repo=cx', 'exemplo', '```',
    '````', '',
    '## P1 — real', '', '```prompt id=P1 repo=cx', 'faca', '```',
  ].join('\n');
  assert.deepEqual(lerPlano(doc).itens.map((i) => i.id), ['P1']);
});

test('documento sem bloco nenhum devolve lista vazia, nao explode', () => {
  assert.deepEqual(lerPlano('# so texto\n\nnada aqui').itens, []);
  assert.deepEqual(lerPlano(undefined).itens, []);
});

test('cerca sem fechamento sai marcada, em vez de engolir o resto do documento', () => {
  const doc = [
    '## P1 — um', '', '```prompt id=P1 repo=cx', 'faca isto', '',
    '## P2 — dois', '', '```prompt id=P2 repo=cy', 'faca aquilo',
  ].join('\n');
  const { itens } = lerPlano(doc);
  assert.equal(itens.length, 1);
  assert.equal(itens[0].fechado, false);
});

test('prompt com bloco de codigo dentro sobrevive inteiro, com cerca maior', () => {
  const doc = ['## P1 — um', '', '````prompt id=P1 repo=cx', 'rode:', '```bash', 'npm test', '```', 'depois abra o PR', '````'].join('\n');
  const [p1] = lerPlano(doc).itens;
  assert.equal(p1.prompt, 'rode:\n```bash\nnpm test\n```\ndepois abra o PR');
  assert.equal(p1.fechado, true);
});

test('cerca recuada continua sendo cerca', () => {
  const doc = ['## P1 — um', '', '  ```prompt id=P1 repo=cx', 'faca isto', '  ```'].join('\n');
  assert.deepEqual(lerPlano(doc).itens.map((i) => i.id), ['P1']);
});

test('chave que o formato nao conhece fica guardada, e nao vira gate apagado', () => {
  const [p] = lerPlano(um('id=P1 repo=cx depnde=P3')).itens;
  assert.deepEqual(p.extras, { depnde: 'P3' });
  assert.deepEqual(p.depende, []);
});

test('modo= do escritorio nao existe mais: cai em extras e a conferencia reclama', () => {
  const plano = lerPlano(um('id=P1 repo=cx modo=fundo'));
  assert.deepEqual(plano.itens[0].extras, { modo: 'fundo' });
  assert.ok(conferir(plano).some((p) => p.includes('chave "modo" não existe')));
});

test('lista aceita espaco depois da virgula sem perder o segundo item', () => {
  assert.deepEqual(lerPlano(um('id=P1 repo=cx depende=P3, P7')).itens[0].depende, ['P3', 'P7']);
});

test('valor sem aspas para na proxima chave, em vez de engoli-la', () => {
  assert.deepEqual(lerAtributos(' id=P1 repo=cx porta=merge, onde=nuvem'),
    { id: 'P1', repo: 'cx', porta: 'merge', onde: 'nuvem' });
  assert.deepEqual(lerAtributos(' depende=P3, P7, conflita=P2'), { depende: 'P3, P7', conflita: 'P2' });
});

test('caminho e valor com virgula decimal nao viram lista', () => {
  const a = lerAtributos(' repo=~/Projects/meu-repo custo=US$0,015');
  assert.equal(a.repo, '~/Projects/meu-repo');
  assert.equal(a.custo, 'US$0,015');
});

test('id com metacaractere nao derruba a leitura antes da conferencia falar', () => {
  assert.equal(limparTitulo('P(1 — titulo', 'P(1'), 'titulo');
});

test('marca de feito antes do id, travessao curto e underline no meio', () => {
  assert.equal(limparTitulo('✅ P1 — Reservar', 'P1'), 'Reservar');
  assert.equal(limparTitulo('P1 – Reservar', 'P1'), 'Reservar');
  assert.equal(limparTitulo('P4 — F1 `tenant_channel`: aprovar', 'P4'), 'F1 tenant_channel: aprovar');
});

test('cabecalho dentro de bloco de exemplo nao vira titulo do proximo item', () => {
  const doc = ['## P1 — verdadeiro', '', '```markdown', '## P9 — exemplo', '```', '', '```prompt id=P1 repo=cx', 'faca', '```'].join('\n');
  assert.equal(lerPlano(doc).itens[0].titulo, 'verdadeiro');
});

test('documento com CRLF le igual', () => {
  assert.deepEqual(lerPlano(DOC.replace(/\n/g, '\r\n')).itens.map((i) => i.id), ['P1', 'P3']);
});

test('toda chave conhecida vira campo do item, e nenhuma sobra em extras', () => {
  const cabecalho = CHAVES.map((c) => `${c}=x1`).join(' ');
  const [it] = lerPlano(['## t', '', '```prompt ' + cabecalho, 'y', '```'].join('\n')).itens;
  assert.deepEqual(it.extras, {});
  for (const chave of CHAVES) {
    const valor = it[chave];
    assert.deepEqual(Array.isArray(valor) ? valor : [valor], ['x1'], `${chave} nao carregou o valor`);
  }
});

// ---- chaves novas ----

test('chaves novas papel, area, onde e esforco sao lidas do cabecalho', () => {
  const [p] = lerPlano(um('id=P1 repo=cx papel=verificador area=web onde=projects esforco=high')).itens;
  assert.equal(p.papel, 'verificador');
  assert.equal(p.area, 'web');
  assert.equal(p.onde, 'projects');
  assert.equal(p.esforco, 'high');
  assert.deepEqual(p.extras, {});
});

test('sem papel= o item e executor, roda local e com acceptEdits', () => {
  const [p] = lerPlano(um('id=P1 repo=cx')).itens;
  assert.equal(p.papel, 'executor');
  assert.equal(p.onde, 'local');
  assert.equal(p.permissao, PERMISSAO_PADRAO);
  assert.equal(p.modelo, null);
  assert.equal(p.area, null);
});

test('com papeis, o item herda modelo, esforco, onde e permissao do papel', () => {
  const [p] = lerPlano(um('id=P1 repo=cx papel=verificador'), { papeis: PAPEIS }).itens;
  assert.equal(p.modelo, 'claude-sonnet-5-5');
  assert.equal(p.esforco, 'low');
  assert.equal(p.onde, 'nuvem');
  assert.equal(p.permissao, 'default');
});

test('o que o bloco declara vence o papel', () => {
  const [p] = lerPlano(um('id=P1 repo=cx papel=verificador onde=local esforco=max modelo=claude-opus-5-5'), { papeis: PAPEIS }).itens;
  assert.equal(p.onde, 'local');
  assert.equal(p.esforco, 'max');
  assert.equal(p.modelo, 'claude-opus-5-5');
  assert.equal(p.permissao, 'default');
});

test('aplicarPapel depois da leitura da o mesmo que ler com papeis', () => {
  const texto = um('id=P1 repo=cx papel=rapido onde=nuvem');
  assert.deepEqual(aplicarPapel(lerPlano(texto).itens[0], PAPEIS), lerPlano(texto, { papeis: PAPEIS }).itens[0]);
});

// ---- conferência (portado do escritório) ----

const item = (id, extra = {}) => ({
  id, titulo: id, repo: '~/Projects/um', papel: 'executor', area: null, onde: 'local',
  modelo: null, esforco: null, permissao: PERMISSAO_PADRAO, depende: [], conflita: [],
  porta: null, custo: null, exclusivo: null, prompt: 'faca X', extras: {}, declarado: [],
  fechado: true, linha: 1, ...extra,
});

test('plano bom nao tem problema nenhum', () => {
  assert.deepEqual(conferirItens([item('P1'), item('P2', { depende: ['P1'] })]), []);
});

test('cerca que nao fecha e recusada', () => {
  const problemas = conferirItens([item('P1', { fechado: false, linha: 12 })]);
  assert.ok(problemas.some((p) => p.includes('linha 12') && p.includes('não fecha')));
});

test('chave desconhecida e recusada pelo nome', () => {
  const problemas = conferirItens([item('P4', { extras: { depnde: 'P3' } })]);
  assert.ok(problemas.some((p) => p.includes('"depnde"') && p.includes('depende')));
});

test('documento sem bloco nenhum e erro, e nao um quadro vazio', () => {
  assert.deepEqual(conferirItens([]), ['nenhum bloco de prompt neste documento: é um plano?']);
});

test('acusa id repetido, id fora do formato e bloco sem id', () => {
  const problemas = conferirItens([item('P1'), item('P1'), item('xyz'), item('', { linha: 9 })]);
  assert.ok(problemas.some((p) => p.includes('P1 repetido')));
  assert.ok(problemas.some((p) => p.includes('"xyz" fora do formato')));
  assert.ok(problemas.some((p) => p.includes('linha 9') && p.includes('sem id')));
});

test('id repetido aponta sempre para a primeira ocorrencia', () => {
  const problemas = conferirItens([item('P1', { linha: 5 }), item('P1', { linha: 9 }), item('P1', { linha: 13 })]);
  assert.ok(problemas.includes('linha 9: id P1 repetido (já aparece na linha 5)'));
  assert.ok(problemas.includes('linha 13: id P1 repetido (já aparece na linha 5)'));
});

test('acusa bloco sem repo e repo que nao existe', () => {
  assert.ok(conferirItens([item('P1', { repo: '' })]).includes('P1: falta repo='));
  const problemas = conferirItens([item('P1')], { repoExiste: () => false });
  assert.ok(problemas.some((p) => p.includes('~/Projects/um') && p.includes('não existe')));
});

test('acusa prompt vazio e apontamento para item de fora, cada um com a sua palavra', () => {
  const problemas = conferirItens([item('P1', { prompt: '', depende: ['P9'], conflita: ['P8'] }), item('P2')]);
  assert.ok(problemas.some((p) => p.includes('P1') && p.includes('vazio')));
  assert.ok(problemas.includes('P1: depende de P9, que não existe neste plano'));
  assert.ok(problemas.includes('P1: conflita com P8, que não existe neste plano'));
});

test('exclusivo inventado e recusado; vazio e o padrao', () => {
  assert.ok(conferirItens([item('P1', { exclusivo: 'sala' })]).includes('P1: exclusivo "sala" não existe (use repo)'));
  assert.deepEqual(conferirItens([item('P1', { exclusivo: 'repo' })]), []);
});

test('permissao inventada e recusada, e bypassPermissions nao passa', () => {
  assert.ok(conferirItens([item('P1', { permissao: 'turbo' })])
    .includes(`P1: permissão "turbo" não existe (use ${PERMISSOES.join(', ')})`));
  assert.ok(conferirItens([item('P1', { permissao: 'bypassPermissions' })]).some((p) => p.includes('bypassPermissions')));
});

test('acusa ciclo em depende', () => {
  const problemas = conferirItens([item('P1', { depende: ['P2'] }), item('P2', { depende: ['P1'] })]);
  assert.ok(problemas.some((p) => p.startsWith('ciclo em depende:')));
});

// ---- conferência das chaves novas ----

test('onde invalido e recusado com a lista dos validos', () => {
  const plano = lerPlano(um('id=P1 repo=cx onde=marte'));
  assert.ok(conferir(plano).includes(`P1: onde "marte" não existe (use ${ONDES.join(', ')})`));
});

test('onde invalido herdado do papel tambem e recusado', () => {
  const papeis = { ...PAPEIS, executor: { ...PAPEIS.executor, onde: 'vscode' } };
  assert.ok(conferir(lerPlano(um('id=P1 repo=cx')), { papeis }).some((p) => p.includes('onde "vscode"')));
});

test('os tres onde validos passam', () => {
  for (const onde of ONDES) assert.deepEqual(conferir(lerPlano(um(`id=P1 repo=cx onde=${onde}`))), [], onde);
});

test('papel que nao existe no papeis.json e recusado', () => {
  const problemas = conferir(lerPlano(um('id=P1 repo=cx papel=astronauta')), { papeis: PAPEIS });
  assert.ok(problemas.some((p) => p.startsWith('P1: papel "astronauta" não existe no papeis.json')));
});

test('sem papeis.json o papel nao e conferido', () => {
  assert.deepEqual(conferir(lerPlano(um('id=P1 repo=cx papel=astronauta'))), []);
});

test('modelo e esforco fora da lista fechada sao recusados', () => {
  const problemas = conferir(lerPlano(um('id=P1 repo=cx modelo=gpt-4 esforco=turbo')));
  assert.ok(problemas.some((p) => p.includes('modelo "gpt-4" não existe')));
  assert.ok(problemas.some((p) => p.includes('esforço "turbo" não existe')));
});

test('area fora do formato e recusada', () => {
  assert.ok(conferir(lerPlano(um('id=P1 repo=cx area=Web/App'))).some((p) => p.includes('area "Web/App"')));
  assert.deepEqual(conferir(lerPlano(um('id=P1 repo=cx area=web-app'))), []);
});

test('repoExiste e injetado em conferir', () => {
  const vistos = [];
  conferir(lerPlano(um('id=P1 repo=~/Projects/x')), { repoExiste: (p) => { vistos.push(p); return true; } });
  assert.deepEqual(vistos, ['~/Projects/x']);
});

// ---- cercas ----

test('palavra errada na cerca e apontada pelo nome', () => {
  const doc = ['## P2 — dois', '', '```prmopt id=P2 repo=cy', 'faca', '```'].join('\n');
  assert.deepEqual(conferirCercas(doc, []), ['linha 3: a cerca de P2 diz "prmopt", e não "prompt"']);
});

test('item comido por cerca aberta antes dele e acusado, com a linha', () => {
  const doc = [
    '## P1 — um', '', '```prompt id=P1 repo=cx', 'faca', '```', '',
    '## Nota', '', '```', 'cerca comum que ninguem fechou', '',
    '## P2 — dois', '', '```prompt id=P2 repo=cy', 'faca', '```',
  ].join('\n');
  assert.deepEqual(lerPlano(doc).erros,
    ['linha 14: a cerca de P2 não virou item -- provavelmente uma cerca aberta antes dela engoliu o bloco']);
});

test('id citado dentro de valor entre aspas nao vira id fantasma', () => {
  const doc = ['## P2 — x', '', '```prompt porta="avisar id=P9 antes" id=P2 repo=cx', 'y', '```'].join('\n');
  assert.deepEqual(lerPlano(doc).erros, []);
});

test('a porta unica devolve os dois tipos de problema, cercas primeiro', () => {
  const doc = ['## P1 — um', '', '```prmopt id=P1 repo=cx', 'faca', '```'].join('\n');
  const problemas = conferir(lerPlano(doc));
  assert.match(problemas[0], /a cerca de P1 diz "prmopt"/);
  assert.match(problemas[1], /nenhum bloco de prompt/);
});

test('conferir aguenta ser chamado sem o que e opcional', () => {
  assert.deepEqual(conferir(lerPlano(um('id=P1 repo=cx'))), []);
  assert.deepEqual(conferir(undefined), ['nenhum bloco de prompt neste documento: é um plano?']);
});

// ---- o exemplo ----

test('o plano de exemplo passa na conferencia com os papeis padrao', async () => {
  const texto = await readFile(new URL('../central/planos/exemplo.md', import.meta.url), 'utf8');
  const plano = lerPlano(texto, { papeis: PAPEIS });
  assert.deepEqual(conferir(plano, { papeis: PAPEIS }), []);
  assert.deepEqual(plano.itens.map((i) => i.id), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.deepEqual(plano.itens.map((i) => i.onde), ['local', 'local', 'nuvem', 'projects', 'local']);
});
