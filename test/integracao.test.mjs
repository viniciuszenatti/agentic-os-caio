// N7: costura dos módulos REAIS (sem stubs): plano → aprovar → argv lançado → marcar.mjs → progresso.
import { createRequire } from 'node:module';
const require_events = () => createRequire(import.meta.url)('node:events');
// O único dublê é o spawn (nada chama o claude de verdade).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { carregarModulos, criarRotasPlanos } from '../central/rotas-planos.mjs';
import { execFileSync } from 'node:child_process';

function spawnFalso(log) {
  return (cmd, args, opcoes = {}) => {
    log.push({ cmd, args, cwd: opcoes.cwd });
    const filho = new EventEmitter();
    filho.stdout = new EventEmitter();
    filho.stderr = new EventEmitter();
    filho.kill = () => {};
    let saida = '';
    if (cmd === 'git') saida = args.includes('status') ? '' : args.includes('remote') ? (log.remoto ?? 'https://github.com/fulano/repo-a.git\n') : 'abc123\n';
    else if (args[0] === '--bg') saida = 'Started background session bg_local_1\n';
    else if (cmd === 'python3') saida = 'Created cloud session: x\nView: https://claude.ai/code/session_01AbcDef?from=cli&m=0\nResume with: claude --teleport session_01AbcDef\n';
    setImmediate(() => {
      if (saida) filho.stdout.emit('data', Buffer.from(saida));
      filho.emit('close', 0);
      filho.emit('exit', 0);
    });
    return filho;
  };
}

test('plano real: aprovar dispara local (bg) e nuvem (pty), marcar.mjs atualiza o progresso', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-n7-'));
  const repo = path.join(home, 'Projects', 'repo-a');
  fs.mkdirSync(repo, { recursive: true });
  const dirs = { planos: path.join(home, 'planos'), dados: path.join(home, 'dados'), home };
  fs.mkdirSync(dirs.planos, { recursive: true });
  fs.mkdirSync(dirs.dados, { recursive: true });
  // sem nuvem-repos.json nenhum repo vai para a nuvem; aqui o dono do repo-a tem o app do Claude
  fs.writeFileSync(path.join(dirs.dados, 'nuvem-repos.json'), JSON.stringify({ comApp: ['fulano/*'] }));
  const arquivo = '2026-10-20-n7.md';
  fs.writeFileSync(path.join(dirs.planos, arquivo), [
    '# Plano N7',
    '## Item local',
    '```prompt id=P1 repo=~/Projects/repo-a papel=executor area=web onde=local',
    'faça o item local',
    '```',
    '## Item nuvem',
    '```prompt id=P2 repo=~/Projects/repo-a papel=executor area=web onde=nuvem',
    'faça o item na nuvem',
    '```',
    '',
  ].join('\n'));

  const log = [];
  const spawn = spawnFalso(log);
  const spawnPty = (cmd, args, o) => spawn('python3', ['-I', 'pty.py', '120', '--', cmd, ...args], o);
  const marcador = fileURLToPath(new URL('../central/planos/marcar.mjs', import.meta.url));
  const mod = await carregarModulos();
  for (const k of Object.keys(mod)) assert.ok(mod[k], `módulo real ${k} carregou`);
  const rotas = criarRotasPlanos({ mod, fs, spawn, spawnPty, marcador, dirs, raizes: ['~/Projects'] });

  const conf = await rotas.get('/api/plano', new URLSearchParams({ arquivo }));
  assert.equal(conf.code, 200, JSON.stringify(conf.corpo));
  assert.deepEqual(conf.corpo.erros, [], 'o plano real passa no conferir');

  const r = await rotas.post('aprovar-plano', { arquivo, onde: {} });
  assert.equal(r.code, 200, JSON.stringify(r.corpo));
  const porId = Object.fromEntries(r.corpo.disparados.map((d) => [d.id, d]));
  assert.equal(porId.P1.ok, true, JSON.stringify(porId.P1));
  assert.equal(porId.P2.ok, true, JSON.stringify(porId.P2));
  assert.equal(porId.P2.url?.startsWith('https://claude.ai/code/session_01AbcDef'), true);

  const bg = log.find((c) => c.cmd === 'claude' && c.args[0] === '--bg');
  assert.ok(bg, 'item local lançado com claude --bg');
  const prompt = bg.args.at(-1);
  assert.equal((prompt.match(/marcar\.mjs/g) || []).length >= 1, true, 'prompt local embrulhado com o marcar.mjs');
  // no Windows o prompt cita o caminho com "/" (o node aceita; "\\" seria escape para o shell)
  assert.ok(prompt.includes(process.platform === 'win32' ? marcador.replace(/\\/g, '/') : marcador), 'marcador com caminho absoluto, alcançável de outro repo');
  assert.equal(prompt.split('faça o item local').length - 1, 1, 'prompt embrulhado uma vez só');
  const nuvem = log.find((c) => c.cmd === 'python3');
  assert.ok(nuvem && nuvem.args.includes('--cloud'), 'item da nuvem vai pelo pseudo-terminal');

  const regArq = path.join(dirs.planos, '2026-10-20-n7.registro.json');
  assert.ok(fs.existsSync(regArq), 'registro ao lado do plano');

  // a sessão local marcaria o início e o fim pelo marcar.mjs real
  const planoAbs = path.join(dirs.planos, arquivo);
  for (const evento of ['iniciou', 'concluiu']) {
    const saida = execFileSync(process.execPath, [marcador, evento, planoAbs, 'P1'], { encoding: 'utf8' });
    assert.match(saida, /P1 (iniciado|concluído)/);
  }

  const depois = await rotas.get('/api/plano', new URLSearchParams({ arquivo }));
  assert.equal(depois.corpo.estados.P1, 'concluido');
  assert.equal(depois.corpo.progresso.pct, 50);
  fs.rmSync(home, { recursive: true, force: true });
});

test('disparo automático: P2 (depende de P1) só sai quando P1 conclui, e uma vez só', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-tick-'));
  fs.mkdirSync(path.join(home, 'Projects', 'repo-a'), { recursive: true });
  const dirs = { planos: path.join(home, 'planos'), dados: path.join(home, 'dados'), home };
  fs.mkdirSync(dirs.planos, { recursive: true });
  fs.mkdirSync(dirs.dados, { recursive: true });
  const arquivo = '2026-10-20-tick.md';
  fs.writeFileSync(path.join(dirs.planos, arquivo), [
    '# Plano tick',
    '## Primeiro',
    '```prompt id=P1 repo=~/Projects/repo-a papel=executor area=web onde=local',
    'primeiro',
    '```',
    '## Segundo',
    '```prompt id=P2 repo=~/Projects/repo-a papel=executor area=web onde=local depende=P1',
    'segundo',
    '```',
    '',
  ].join('\n'));
  const log = [];
  const spawn = spawnFalso(log);
  const marcador = fileURLToPath(new URL('../central/planos/marcar.mjs', import.meta.url));
  const rotas = criarRotasPlanos({ mod: await carregarModulos(), fs, spawn, marcador, dirs, raizes: ['~/Projects'] });
  const bgs = () => log.filter((c) => c.cmd === 'claude' && c.args[0] === '--bg').map((c) => c.args.at(-1));

  assert.deepEqual(await rotas.tick(), [], 'plano proposto não dispara sozinho');
  const r = await rotas.post('aprovar-plano', { arquivo, onde: {} });
  assert.deepEqual(r.corpo.disparados.map((d) => d.id), ['P1']);
  assert.deepEqual(await rotas.tick(), [], 'P2 ainda bloqueado');

  const planoAbs = path.join(dirs.planos, arquivo);
  for (const evento of ['iniciou', 'concluiu']) execFileSync(process.execPath, [marcador, evento, planoAbs, 'P1'], { encoding: 'utf8' });

  const f = await rotas.tick();
  assert.deepEqual(f.map((x) => x.disparados.map((d) => d.id)), [['P2']]);
  assert.equal(bgs().filter((p) => p.includes('segundo')).length, 1);
  assert.deepEqual(await rotas.tick(), [], 'não redispara');
  assert.equal(bgs().filter((p) => p.includes('segundo')).length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('trava da nuvem: repo sem o app do GitHub (outra-org) não dispara e o seletor recebe o motivo', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-nuvem-'));
  fs.mkdirSync(path.join(home, 'Projects', 'repo-a'), { recursive: true });
  const dirs = { planos: path.join(home, 'planos'), dados: path.join(home, 'dados'), home };
  fs.mkdirSync(dirs.planos, { recursive: true });
  fs.mkdirSync(dirs.dados, { recursive: true });
  const arquivo = '2026-10-20-nuvem.md';
  fs.writeFileSync(path.join(dirs.planos, arquivo), ['# Plano', '## Item', '```prompt id=P1 repo=~/Projects/repo-a papel=executor area=web onde=nuvem', 'faça', '```', ''].join('\n'));
  const log = [];
  log.remoto = 'https://github.com/outra-org/meu-app.git\n';
  const spawn = spawnFalso(log);
  const rotas = criarRotasPlanos({ mod: await carregarModulos(), fs, spawn, spawnPty: spawn, dirs, raizes: ['~/Projects'] });

  const v = await rotas.get('/api/plano', new URLSearchParams({ arquivo }));
  assert.equal(v.corpo.nuvem.P1.ok, false);
  assert.match(v.corpo.nuvem.P1.motivo, /outra-org\/meu-app não tem o app do Claude/);

  const r = await rotas.post('aprovar-plano', { arquivo, onde: {} });
  assert.equal(r.corpo.disparados[0].ok, false);
  assert.match(r.corpo.disparados[0].motivo, /app do Claude/);
  assert.ok(!log.some((c) => c.cmd === 'python3' || c.args.includes('--cloud')), 'não chegou a chamar o --cloud');

  // quando o dono instalar, uma linha em nuvem-repos.json libera
  fs.writeFileSync(path.join(dirs.dados, 'nuvem-repos.json'), JSON.stringify({ comApp: ['fulano/*', 'outra-org/*'] }));
  const v2 = await rotas.get('/api/plano', new URLSearchParams({ arquivo }));
  assert.equal(v2.corpo.nuvem.P1.ok, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('tentar de novo: item que falhou volta a pronto e dispara; item que não falhou é recusado', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'central-retry-'));
  fs.mkdirSync(path.join(home, 'Projects', 'repo-a'), { recursive: true });
  const dirs = { planos: path.join(home, 'planos'), dados: path.join(home, 'dados'), home };
  fs.mkdirSync(dirs.planos, { recursive: true });
  fs.mkdirSync(dirs.dados, { recursive: true });
  const arquivo = '2026-10-20-retry.md';
  fs.writeFileSync(path.join(dirs.planos, arquivo), ['# Plano', '## Um', '```prompt id=P1 repo=~/Projects/repo-a papel=executor area=web onde=local', 'um', '```', ''].join('\n'));
  const log = [];
  let falhar = true;
  const base = spawnFalso(log);
  const spawn = (cmd, args, o) => {
    if (cmd === 'claude' && args[0] === '--bg' && falhar) {
      const { EventEmitter } = require_events();
      const f = new EventEmitter(); f.stdout = new EventEmitter(); f.stderr = new EventEmitter(); f.kill = () => {};
      setImmediate(() => { f.stderr.emit('data', Buffer.from('Workspace not trusted.\n')); f.emit('close', 1); f.emit('exit', 1); });
      log.push({ cmd, args }); return f;
    }
    return base(cmd, args, o);
  };
  const marcador = fileURLToPath(new URL('../central/planos/marcar.mjs', import.meta.url));
  const rotas = criarRotasPlanos({ mod: await carregarModulos(), fs, spawn, marcador, dirs, raizes: ['~/Projects'] });

  const r = await rotas.post('aprovar-plano', { arquivo, onde: {} });
  assert.equal(r.corpo.disparados[0].ok, false);
  let v = await rotas.get('/api/plano', new URLSearchParams({ arquivo }));
  assert.equal(v.corpo.estados.P1, 'falhou');
  assert.match(v.corpo.registro.itens.P1.motivo, /not trusted/);

  falhar = false;
  const t = await rotas.post('tentar-de-novo', { arquivo, id: 'P1' });
  assert.equal(t.code, 200, JSON.stringify(t.corpo));
  assert.equal(t.corpo.disparado.ok, true);
  v = await rotas.get('/api/plano', new URLSearchParams({ arquivo }));
  assert.equal(v.corpo.estados.P1, 'disparado');
  assert.equal((await rotas.post('tentar-de-novo', { arquivo, id: 'P1' })).code, 409, 'só item com falha');
  fs.rmSync(home, { recursive: true, force: true });
});
