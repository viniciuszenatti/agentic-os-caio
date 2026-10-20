// Sugestões dos verificadores: a Central só MOSTRA (não existe tracker embutido); líderes vêm das áreas que você criou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { criarRotasPlanos } from '../central/rotas-planos.mjs';

test('sugestão do relatório aparece na lista; não há ação de criar tarefa', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-sug-'));
  const verif = path.join(home, 'verif', 'verificador-seguranca');
  fs.mkdirSync(verif, { recursive: true });
  fs.writeFileSync(path.join(verif, '2026-10-20.md'), [
    '# Segurança', '', '## Tarefas sugeridas', '```json',
    JSON.stringify([
      { titulo: 'Porta 5433 do Postgres exposta no DEV', tipo: 'bug', area: 'infra', severidade: 1, resumo: 'Fechar a porta.', recurso: 'dev:5433', missao: ['nmap não acha 5433'] },
      { titulo: '...' },
    ]), '```', '',
  ].join('\n'));
  const dirs = { planos: path.join(home, 'planos'), dados: path.join(home, 'dados'), home, verificadores: path.join(home, 'verif') };
  fs.mkdirSync(dirs.dados, { recursive: true });
  const rotas = criarRotasPlanos({ mod: {}, fs, spawn, dirs });

  const lista = (await rotas.get('/api/sugestoes', new URLSearchParams())).corpo;
  assert.equal(lista.length, 1, 'o placeholder "..." do modelo fica de fora');
  assert.equal(lista[0].titulo, 'Porta 5433 do Postgres exposta no DEV');
  assert.equal(lista[0].severidade, 1);
  assert.equal('criada' in lista[0], false);
  assert.equal(rotas.temAcao('criar-tarefa'), false, 'criar tarefa é ponto de extensão, não vem pronto');
  fs.rmSync(home, { recursive: true, force: true });
});

test('líderes: áreas saem dos diários e dos agentes lider-<area>; o lider-exemplo não conta', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-lid-'));
  const lideres = path.join(home, 'lideres');
  fs.mkdirSync(lideres, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(lideres, 'web.md'), '# Líder web\n\n- **Etapa:** testes\n- **Atualizado:** 2026-10-20 10:00\n- **Fazendo:** login, #12\n');
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'lider-dados.md'), '---\nname: lider-dados\n---\n');
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'lider-exemplo.md'), '---\nname: lider-exemplo\n---\n');
  const sessoes = async () => [{ nome: 'lider-web', status: 'idle' }];
  const rotas = criarRotasPlanos({ mod: { lancar: { sessoes } }, fs, spawn, dirs: { planos: home, dados: home, home, lideres } });
  const r = (await rotas.get('/api/lideres', new URLSearchParams())).corpo;
  assert.deepEqual(r.map((x) => x.area), ['dados', 'web']);
  const web = r.find((x) => x.area === 'web');
  assert.equal(web.etapa, 'testes');
  assert.deepEqual(web.fazendo, ['login', '#12']);
  assert.equal(web.sessao.nome, 'lider-web');
  assert.equal(r.find((x) => x.area === 'dados').temDiario, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('remover-sessao roda claude rm e abrir-terminal abre o konsole em claude attach, ambos validados', async () => {
  const chamadas = [];
  const { EventEmitter } = await import('node:events');
  const spawnFalso = (cmd, args, o) => { chamadas.push([cmd, ...args, o?.detached ? '(destacado)' : '']); const f = new EventEmitter(); f.stdout = new EventEmitter(); f.stderr = new EventEmitter(); f.unref = () => {}; setImmediate(() => f.emit('close', 0)); return f; };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-term-'));
  const rotas = criarRotasPlanos({ mod: {}, fs, spawn: spawnFalso, dirs: { planos: home, dados: home, home } });
  assert.equal((await rotas.post('remover-sessao', { id: '9e19c103' })).code, 200);
  assert.deepEqual(chamadas.at(-1).slice(0, 3), ['claude', 'rm', '9e19c103']);
  assert.equal((await rotas.post('abrir-terminal', { nome: '2026-10-20-teste-fase0-t1' })).code, 200);
  assert.deepEqual(chamadas.at(-1), ['konsole', '-e', 'claude', 'attach', '2026-10-20-teste-fase0-t1', '(destacado)']);
  assert.equal((await rotas.post('abrir-terminal', { nome: 'x; rm -rf ~' })).code, 400);
  assert.equal((await rotas.post('remover-sessao', { id: '../x' })).code, 400);
  fs.rmSync(home, { recursive: true, force: true });
});
