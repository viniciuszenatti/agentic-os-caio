import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PADRAO, MODELOS, ESFORCOS, PERMISSOES, ONDES, PAPEIS, validarPapeis, lerPapeis, gravarPapeis,
} from '../central/config/papeis.mjs';

const copia = () => JSON.parse(JSON.stringify(PADRAO));

function fsFalso(arquivos = {}) {
  const ops = [];
  return {
    arquivos, ops,
    async readFile(p) {
      ops.push(['readFile', p]);
      if (!(p in arquivos)) { const e = new Error('não existe'); e.code = 'ENOENT'; throw e; }
      return arquivos[p];
    },
    async writeFile(p, t) { ops.push(['writeFile', p]); arquivos[p] = t; },
    async rename(a, b) { ops.push(['rename', a, b]); arquivos[b] = arquivos[a]; delete arquivos[a]; },
    async unlink(p) { delete arquivos[p]; },
  };
}

test('listas fechadas da spec', () => {
  assert.deepEqual([...MODELOS], ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
  assert.deepEqual([...ESFORCOS], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([...PERMISSOES], ['default', 'acceptEdits', 'plan']);
  assert.deepEqual([...ONDES], ['local', 'nuvem', 'projects']);
  assert.ok(!PERMISSOES.includes('bypassPermissions'));
});

test('PADRAO da arquitetura: orquestrador opus 5.5 medium', () => {
  assert.deepEqual(PADRAO.orquestrador, { modelo: 'claude-opus-5-5', esforco: 'medium', onde: 'local', permissao: 'plan' });
  assert.deepEqual(PAPEIS, ['orquestrador', 'lider', 'executor', 'verificador', 'rapido']);
  assert.equal(PADRAO.verificador.onde, 'nuvem');
  assert.equal(PADRAO.executor.permissao, 'acceptEdits');
  assert.equal(PADRAO.rapido.modelo, 'claude-haiku-5-5');
  assert.deepEqual(validarPapeis(PADRAO), []);
  assert.ok(Object.isFrozen(PADRAO.orquestrador));
});

test('validarPapeis recusa valor fora da lista, bypassPermissions, chave e papel desconhecidos', () => {
  const o = copia();
  o.executor.permissao = 'bypassPermissions';
  o.lider.modelo = 'gpt-5';
  o.rapido.esforco = 'turbo';
  o.verificador.onde = 'marte';
  o.orquestrador.extra = 'x';
  o.intruso = { ...PADRAO.rapido };
  const erros = validarPapeis(o);
  assert.equal(erros.length, 6, erros.join('\n'));
  assert.ok(erros.some((e) => e.includes('bypassPermissions')));
  assert.ok(erros.some((e) => e.includes('intruso')));
});

test('validarPapeis: papel ausente, campo ausente e tipo errado', () => {
  const o = copia();
  delete o.lider;
  delete o.executor.modelo;
  assert.equal(validarPapeis(o).length, 2);
  assert.deepEqual(validarPapeis(null), ['papéis: precisa ser um objeto']);
  assert.deepEqual(validarPapeis([]), ['papéis: precisa ser um objeto']);
  const r = copia(); r.rapido = 'x';
  assert.equal(validarPapeis(r).length, 1);
});

test('lerPapeis: ausente devolve cópia do padrão; inválido lança', async () => {
  const fs = fsFalso();
  const p = await lerPapeis('/x/papeis.json', { fs });
  assert.deepEqual(p, PADRAO);
  p.executor.modelo = 'claude-opus-5-5';
  assert.equal(PADRAO.executor.modelo, 'claude-sonnet-5-5');
  fs.arquivos['/x/papeis.json'] = '{ruim';
  await assert.rejects(lerPapeis('/x/papeis.json', { fs }), /JSON/);
  fs.arquivos['/x/papeis.json'] = JSON.stringify({ ...copia(), rapido: { ...PADRAO.rapido, modelo: 'x' } });
  await assert.rejects(lerPapeis('/x/papeis.json', { fs }), /inválidos/);
});

test('lerPapeis propaga erro que não é ENOENT', async () => {
  const fs = { async readFile() { const e = new Error('sem permissão'); e.code = 'EACCES'; throw e; } };
  await assert.rejects(lerPapeis('/x', { fs }), /sem permissão/);
});

test('gravarPapeis é atômico (tmp + rename) e faz ida e volta', async () => {
  const fs = fsFalso();
  const o = copia(); o.executor.onde = 'projects';
  await gravarPapeis('/x/papeis.json', o, { fs });
  assert.deepEqual(fs.ops.map((op) => op[0]), ['writeFile', 'rename']);
  assert.notEqual(fs.ops[0][1], '/x/papeis.json');
  assert.equal(fs.ops[1][2], '/x/papeis.json');
  assert.deepEqual(Object.keys(fs.arquivos), ['/x/papeis.json']);
  assert.deepEqual(await lerPapeis('/x/papeis.json', { fs }), o);
});

test('gravarPapeis recusa inválido sem tocar no disco', async () => {
  const fs = fsFalso();
  const o = copia(); o.lider.permissao = 'bypassPermissions';
  await assert.rejects(gravarPapeis('/x/papeis.json', o, { fs }), /inválidos/);
  assert.equal(fs.ops.length, 0);
});

test('gravarPapeis limpa o tmp se o rename falhar', async () => {
  const fs = fsFalso();
  fs.rename = async () => { throw new Error('disco cheio'); };
  await assert.rejects(gravarPapeis('/x/papeis.json', copia(), { fs }), /disco cheio/);
  assert.deepEqual(Object.keys(fs.arquivos), []);
});
