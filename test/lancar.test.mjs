import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  argvLocal, argvNuvem, argvParar, argvMensagemNuvem, embrulhar, textoProjects,
  lancar, sessoes, validarRepo, nomeDaSessao, lerSaidaBg, lerSaidaNuvem, criterioDePronto,
} from '../central/lancar/lancar.mjs';
import { executar, caminhoDoRegistro } from '../central/planos/marcar.mjs';

const HOME = '/home/teste';
const OPC = { home: HOME, platform: 'linux', planoArquivo: '/home/teste/planos/2026-10-20-login.md' };
const PAPEL = { modelo: 'claude-sonnet-5-5', esforco: 'medium', permissao: 'acceptEdits' };
const ITEM = { id: 'P1', titulo: 'Corrigir login', repo: '~/Projects/meu-app', prompt: 'Corrija o login. Pronto = testes verdes.' };

// Dublê de spawn: grava as chamadas e responde com a saída dada.
function dubleSpawn({ stdout = '', stderr = '', codigo = 0, erro = null, nunca = false } = {}) {
  const chamadas = [];
  const spawn = (cmd, args, opts) => {
    chamadas.push({ cmd, args, opts });
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.morto = true; };
    if (!nunca) {
      setImmediate(() => {
        if (erro) { p.emit('error', erro); return; }
        if (stdout) p.stdout.emit('data', Buffer.from(stdout));
        if (stderr) p.stderr.emit('data', Buffer.from(stderr));
        p.emit('close', codigo);
      });
    }
    return p;
  };
  return { spawn, chamadas };
}

const CWD = '/home/teste/Projects/meu-app';

// ------------------------------------------------------------ argv

test('argvLocal monta o --bg com nome, modelo, esforço, permissão e prompt único', () => {
  const argv = argvLocal(ITEM, PAPEL, OPC);
  assert.deepEqual(argv.slice(0, 10), ['claude', '--bg', '--name', '2026-10-20-login-p1',
    '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--permission-mode', 'acceptEdits']);
  assert.equal(argv.length, 11);
  assert.match(argv[10], /Corrija o login/);
  assert.match(argv[10], /marcar\.mjs" iniciou "\/home\/teste\/planos\/2026-10-20-login\.md" P1/);
});

test('argvLocal: o item sobrescreve o papel', () => {
  const argv = argvLocal({ ...ITEM, modelo: 'claude-opus-5-5', esforco: 'high', permissao: 'plan' }, PAPEL, OPC);
  assert.equal(argv[5], 'claude-opus-5-5');
  assert.equal(argv[7], 'high');
  assert.equal(argv[9], 'plan');
});

test('validação: id, modelo, esforço, permissão, bypassPermissions e repo', () => {
  assert.throws(() => argvLocal({ ...ITEM, id: 'P1a' }, PAPEL, OPC), /id inválido/);
  assert.throws(() => argvLocal({ ...ITEM, id: '1P' }, PAPEL, OPC), /id inválido/);
  assert.throws(() => argvLocal({ ...ITEM, modelo: 'gpt-4' }, PAPEL, OPC), /modelo inválido/);
  assert.throws(() => argvLocal({ ...ITEM, esforco: 'ultra' }, PAPEL, OPC), /esforço inválido/);
  assert.throws(() => argvLocal({ ...ITEM, permissao: 'bypassPermissions' }, PAPEL, OPC), /bypassPermissions é proibida/);
  assert.throws(() => argvLocal({ ...ITEM, permissao: 'tudo' }, PAPEL, OPC), /permissão inválido/);
  assert.throws(() => argvLocal({ ...ITEM, repo: '/etc' }, PAPEL, OPC), /fora das pastas/);
  assert.throws(() => argvLocal({ ...ITEM, repo: '~/Projects/../.ssh' }, PAPEL, OPC), /fora das pastas/);
  assert.throws(() => argvLocal({ ...ITEM, repo: '~/Projects2/x' }, PAPEL, OPC), /fora das pastas/);
  assert.throws(() => argvLocal({ ...ITEM, prompt: '  ' }, PAPEL, OPC), /prompt vazio/);
  assert.throws(() => argvLocal(ITEM, PAPEL, { home: HOME, platform: 'linux' }), /planoArquivo é obrigatório/);
  assert.throws(() => argvLocal(ITEM, PAPEL, { ...OPC, planoArquivo: '/x/$(rm -rf ~).md' }), /shell/);
});

test('validarRepo aceita ~/Projects e subpastas, e raízes configuráveis', () => {
  assert.equal(validarRepo('~/Projects/x', { home: HOME, platform: 'linux' }), '/home/teste/Projects/x');
  assert.equal(validarRepo('/home/teste/Projects', { home: HOME, platform: 'linux' }), '/home/teste/Projects');
  assert.equal(validarRepo('~/Projects/central-agentes', { home: HOME, platform: 'linux', raizes: ['~/Projects'] }),
    '/home/teste/Projects/central-agentes');
});

test('nomeDaSessao vira slug sem acento', () => {
  assert.equal(nomeDaSessao({ id: 'N2' }, '/a/Plano Ação Já.md'), 'plano-acao-ja-n2');
  assert.equal(nomeDaSessao({ id: 'N2' }), 'plano-n2');
});

test('argvNuvem monta o --cloud com o prompt de branch', () => {
  const argv = argvNuvem(ITEM, OPC);
  assert.equal(argv.length, 3);
  assert.deepEqual(argv.slice(0, 2), ['claude', '--cloud']);
  assert.match(argv[2], /branch `plano\/P1`/);
  assert.match(argv[2], /git push -u origin plano\/P1/);
  assert.doesNotMatch(argv[2], /marcar\.mjs/);
  assert.throws(() => argvNuvem({ ...ITEM, repo: '/tmp/x' }, OPC), /fora das pastas/);
});

test('argvParar e argvMensagemNuvem validam id e texto', () => {
  assert.deepEqual(argvParar('abc123'), ['claude', 'stop', 'abc123']);
  assert.throws(() => argvParar('--all'), /sessão inválido/);
  assert.throws(() => argvParar('a b'), /sessão inválido/);
  assert.deepEqual(argvMensagemNuvem('session_01X4tMmwt8T4f6tD4vdyq4yZ', 'olá'),
    ['claude', '-p', 'olá', '--cloud', 'session_01X4tMmwt8T4f6tD4vdyq4yZ', '--output-format', 'json']);
  assert.throws(() => argvMensagemNuvem('abc', 'olá'), /sessão inválido/);
  assert.throws(() => argvMensagemNuvem('session_01X', '--dangerously-skip-permissions'), /não pode começar/);
  assert.throws(() => argvMensagemNuvem('session_01X', ''), /vazio/);
});

// ------------------------------------------------------------ embrulhar

test('embrulhar local: iniciou antes, concluiu depois, prompt intacto no meio', () => {
  const t = embrulhar({ ...ITEM, onde: 'local' }, { planoArquivo: '/p/plano.md' });
  const ini = t.indexOf('node "central/planos/marcar.mjs" iniciou "/p/plano.md" P1');
  const meio = t.indexOf('Corrija o login.');
  const fim = t.indexOf('node "central/planos/marcar.mjs" concluiu "/p/plano.md" P1');
  assert.ok(ini >= 0 && meio > ini && fim > meio, t);
});

test('embrulhar nuvem e projects: commit + push na branch plano/<id>', () => {
  for (const onde of ['nuvem', 'projects']) {
    const t = embrulhar({ ...ITEM, onde });
    assert.match(t, /commit/);
    assert.match(t, /push na branch `plano\/P1`/);
    assert.doesNotMatch(t, /marcar\.mjs/);
  }
  assert.throws(() => embrulhar({ ...ITEM, onde: 'marte' }), /onde inválido/);
});

// ------------------------------------------------------------ textoProjects

test('textoProjects: objetivo + um bloco por item com título, repo, prompt e critério', () => {
  const t = textoProjects({ titulo: 'Login novo', objetivo: 'Trocar o login do app' }, [
    ITEM,
    { id: 'P2', titulo: 'Testes', repo: '~/Projects/app', prompt: 'Escreva os testes.', depende: ['P1'], pronto: 'suíte verde' },
  ]);
  assert.match(t, /^# Login novo/);
  assert.match(t, /Objetivo do plano: Trocar o login do app/);
  assert.match(t, /Item 1 de 2: P1 · Corrigir login/);
  assert.match(t, /Repo: ~\/Projects\/meu-app/);
  assert.match(t, /Critério de pronto: testes verdes/);
  assert.match(t, /Item 2 de 2: P2 · Testes/);
  assert.match(t, /Critério de pronto: suíte verde/);
  assert.match(t, /Só comece depois de: P1/);
  assert.match(t, /Escreva os testes\./);
  assert.throws(() => textoProjects({ titulo: 'x' }, []), /nenhum item/);
});

test('criterioDePronto cai no padrão quando o prompt não diz', () => {
  assert.match(criterioDePronto({ id: 'P3', prompt: 'faça X' }), /branch plano\/P3/);
});

// ------------------------------------------------------------ leitura de saída

const SAIDA_CLOUD = [
  'Created cloud session: Corrigir login',
  'View: https://claude.ai/code/session_01X4tMmwt8T4f6tD4vdyq4yZ?from=cli&m=0',
  'Resume with: claude --teleport session_01X4tMmwt8T4f6tD4vdyq4yZ',
].join('\n');

test('lerSaidaNuvem: formato real, com cores de PTY, só teleport, erro de TTY e inesperado', () => {
  const r = lerSaidaNuvem(SAIDA_CLOUD);
  assert.deepEqual(r, { ok: true, id: 'session_01X4tMmwt8T4f6tD4vdyq4yZ',
    url: 'https://claude.ai/code/session_01X4tMmwt8T4f6tD4vdyq4yZ', titulo: 'Corrigir login' });
  const pty = '\x1b[32mCreated cloud session:\x1b[0m X\r\nView: \x1b[4mhttps://claude.ai/code/session_01AbC?from=cli\x1b[0m\r\n';
  assert.equal(lerSaidaNuvem(pty).id, 'session_01AbC');
  assert.equal(lerSaidaNuvem('Resume with: claude --teleport session_01Zz9').url, 'https://claude.ai/code/session_01Zz9');
  const tty = lerSaidaNuvem('Error: --cloud requires an interactive terminal.');
  assert.equal(tty.ok, false);
  assert.match(tty.motivo, /terminal interativo/);
  const nada = lerSaidaNuvem('Something went wrong');
  assert.equal(nada.ok, false);
  assert.match(nada.motivo, /saída inesperada.*Something went wrong/);
});

test('lerSaidaBg: formatos plausíveis e saída inesperada', () => {
  const casos = [
    ['{"id":"bg_7f3a9c"}', 'bg_7f3a9c'],
    ['{"session_id":"cd76abfb-c853-43a4-9d50-8e2467c5a033","name":"x"}', 'cd76abfb-c853-43a4-9d50-8e2467c5a033'],
    ['Started background session cd76abfb-c853-43a4-9d50-8e2467c5a033', 'cd76abfb-c853-43a4-9d50-8e2467c5a033'],
    ['Session ID: a1b2c3d4', 'a1b2c3d4'],
    ['Started background session abc123def\nAttach with: claude attach abc123def', 'abc123def'],
    ['id=xyz789abc', 'xyz789abc'],
    ['7f3a9c21\n', '7f3a9c21'],
    ['\x1b[2mbackground session\x1b[0m: k9k9k9k9\r\n', 'k9k9k9k9'],
  ];
  for (const [saida, id] of casos) assert.deepEqual(lerSaidaBg(saida), { ok: true, id }, saida);
  for (const ruim of ['', 'Usage: claude [options]\nunknown option --bg', 'ok']) {
    const r = lerSaidaBg(ruim);
    assert.equal(r.ok, false, ruim);
    assert.match(r.motivo, /saída inesperada do claude --bg/);
  }
});

// ------------------------------------------------------------ lancar

test('lancar --bg: chama o spawn sem shell, no cwd validado, e lê o id', async () => {
  const d = dubleSpawn({ stdout: 'Started background session abc123def\n' });
  const argv = argvLocal(ITEM, PAPEL, OPC);
  const r = await lancar(argv, { spawn: d.spawn, cwd: '~/Projects/meu-app', home: HOME, platform: 'linux' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'abc123def');
  assert.equal(d.chamadas.length, 1);
  assert.equal(d.chamadas[0].cmd, 'claude');
  assert.deepEqual(d.chamadas[0].args, argv.slice(1));
  assert.equal(d.chamadas[0].opts.cwd, CWD);
  assert.equal(d.chamadas[0].opts.shell, false);
});

test('lancar --cloud usa o spawnPty quando há, e lê id e URL', async () => {
  const comum = dubleSpawn({ stderr: 'Error: --cloud requires an interactive terminal.', codigo: 1 });
  const pty = dubleSpawn({ stdout: SAIDA_CLOUD });
  const r = await lancar(argvNuvem(ITEM, OPC), { spawn: comum.spawn, spawnPty: pty.spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.equal(comum.chamadas.length, 0);
  assert.equal(pty.chamadas.length, 1);
  assert.equal(r.ok, true);
  assert.equal(r.id, 'session_01X4tMmwt8T4f6tD4vdyq4yZ');
  assert.equal(r.url, 'https://claude.ai/code/session_01X4tMmwt8T4f6tD4vdyq4yZ');
});

test('lancar --cloud sem PTY: ok:false com motivo claro', async () => {
  const d = dubleSpawn({ stderr: 'Error: --cloud requires an interactive terminal.\n', codigo: 1 });
  const r = await lancar(argvNuvem(ITEM, OPC), { spawn: d.spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /exige terminal interativo/);
  assert.match(r.saida, /requires an interactive terminal/);
});

test('lancar: mensagem para a nuvem lê o JSON de confirmação', async () => {
  const d = dubleSpawn({ stdout: '{"ok":true,"session_id":"session_01X","url":"https://claude.ai/code/session_01X"}' });
  const r = await lancar(argvMensagemNuvem('session_01X', 'continua'), { spawn: d.spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'session_01X');
  const ruim = dubleSpawn({ stdout: 'nada' });
  const r2 = await lancar(argvMensagemNuvem('session_01X', 'continua'), { spawn: ruim.spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.equal(r2.ok, false);
});

test('lancar: código de saída, erro de spawn, saída inesperada e timeout viram ok:false', async () => {
  const argv = argvLocal(ITEM, PAPEL, OPC);
  const c1 = await lancar(argv, { spawn: dubleSpawn({ stderr: 'boom', codigo: 3 }).spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.equal(c1.ok, false);
  assert.match(c1.motivo, /código 3: boom/);
  const c2 = await lancar(argv, { spawn: dubleSpawn({ erro: new Error('ENOENT') }).spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.match(c2.motivo, /não foi possível iniciar o claude: ENOENT/);
  const c3 = await lancar(argv, { spawn: dubleSpawn({ stdout: 'hmm' }).spawn, cwd: CWD, home: HOME, platform: 'linux' });
  assert.match(c3.motivo, /saída inesperada/);
  const c4 = await lancar(argv, { spawn: dubleSpawn({ nunca: true }).spawn, cwd: CWD, home: HOME, platform: 'linux', timeoutMs: 20 });
  assert.match(c4.motivo, /não terminou/);
  const c5 = await lancar(argv, { spawn: () => { throw new Error('sem permissão'); }, cwd: CWD, home: HOME, platform: 'linux' });
  assert.match(c5.motivo, /sem permissão/);
});

test('lancar recusa antes de chamar o spawn: cwd fora, argv forjado, bypass, sem spawn', async () => {
  const d = dubleSpawn({ stdout: 'abc123def' });
  const argv = argvLocal(ITEM, PAPEL, OPC);
  assert.match((await lancar(argv, { spawn: d.spawn, cwd: '/etc', home: HOME, platform: 'linux' })).motivo, /fora das pastas/);
  assert.match((await lancar(['rm', '-rf', '/'], { spawn: d.spawn, cwd: CWD, home: HOME, platform: 'linux' })).motivo, /argv inválido/);
  assert.match((await lancar(['claude', '--permission-mode', 'bypassPermissions', 'x'], { spawn: d.spawn, cwd: CWD, home: HOME, platform: 'linux' })).motivo, /proibida/);
  assert.match((await lancar(argv, { cwd: CWD, home: HOME, platform: 'linux' })).motivo, /spawn não informado/);
  assert.equal(d.chamadas.length, 0);
});

// ------------------------------------------------------------ sessoes

test('sessoes: roda claude agents --json e normaliza os campos', async () => {
  const d = dubleSpawn({ stdout: JSON.stringify([
    { id: 'a1', name: 'plano-p1', cwd: '/x', status: 'running' },
    { sessionId: 'b2', name: 'lider-web', cwd: '/y', status: 'waiting', waitingFor: 'permissão de Bash' },
    { id: 'c3', status: 'waiting' },
  ]) });
  const s = await sessoes({ spawn: d.spawn });
  assert.deepEqual(d.chamadas[0].args, ['agents', '--json']);
  assert.deepEqual(s[0], { id: 'a1', nome: 'plano-p1', cwd: '/x', status: 'running', esperando: false, motivoEspera: null });
  assert.equal(s[1].id, 'b2');
  assert.equal(s[1].esperando, true);
  assert.equal(s[1].motivoEspera, 'permissão de Bash');
  assert.equal(s[2].esperando, true);
  assert.equal(s[2].nome, null);
});

test('sessoes aceita objeto com lista e falha com motivo em saída ruim', async () => {
  const d = dubleSpawn({ stdout: '{"agents":[{"id":"z9","status":"idle"}]}' });
  assert.equal((await sessoes({ spawn: d.spawn }))[0].id, 'z9');
  await assert.rejects(sessoes({ spawn: dubleSpawn({ stdout: 'não é json' }).spawn }), /saída inesperada do claude agents/);
  await assert.rejects(sessoes({ spawn: dubleSpawn({ stderr: 'erro', codigo: 1 }).spawn }), /código 1/);
});

// ------------------------------------------------------------ marcar.mjs (com dublê do C2)

function dubleRegistro() {
  const gravados = [];
  return {
    gravados,
    async ler(caminho) { return { plano: caminho, estado: 'aprovado', itens: {} }; },
    marcar(reg, id, evento, dados, { agora }) {
      return { ...reg, itens: { ...reg.itens, [id]: { evento, ...dados, em: agora } } };
    },
    async gravar(caminho, reg) { gravados.push({ caminho, reg }); },
  };
}

test('marcar iniciou grava sessão e hora no registro ao lado do plano', async () => {
  const registro = dubleRegistro();
  const agora = new Date(2026, 9, 20, 10, 31).getTime();
  const r = await executar(['iniciou', '/p/plano.md', 'P1'],
    { registro, fs: {}, env: { CLAUDE_CODE_SESSION_ID: 'cd76abfb-c853' }, agora: () => agora });
  assert.equal(r.codigo, 0);
  assert.equal(r.saida, 'P1 iniciado · sessão cd76abfb · 20/10 10:31');
  // path.resolve: no Windows "/p" vira "D:\\p" (a unidade atual)
  assert.equal(registro.gravados[0].caminho, path.resolve('/p/plano.registro.json'));
  assert.deepEqual(registro.gravados[0].reg.itens.P1, { evento: 'iniciou', sessao: 'cd76abfb-c853', em: agora });
});

test('marcar concluiu e falhou com motivo', async () => {
  const registro = dubleRegistro();
  assert.equal((await executar(['concluiu', '/p/plano.md', 'P1'], { registro, fs: {} })).codigo, 0);
  const f = await executar(['falhou', '/p/plano.md', 'P2', 'teste', 'quebrou'], { registro, fs: {} });
  assert.match(f.saida, /^P2 falhou · teste quebrou/);
  assert.equal(registro.gravados[1].reg.itens.P2.motivo, 'teste quebrou');
});

test('marcar recusa evento, id e plano inválidos, e relata erro do registro', async () => {
  const registro = dubleRegistro();
  assert.equal((await executar(['disparou', '/p/plano.md', 'P1'], { registro, fs: {} })).codigo, 2);
  assert.equal((await executar(['iniciou', '/p/plano.md', 'P1a'], { registro, fs: {} })).codigo, 2);
  assert.equal((await executar(['iniciou', '/p/plano.txt', 'P1'], { registro, fs: {} })).codigo, 2);
  assert.equal((await executar([], { registro, fs: {} })).codigo, 2);
  assert.equal(registro.gravados.length, 0);
  const quebrado = { ...registro, marcar() { throw new Error('item P9 não existe'); } };
  const r = await executar(['iniciou', '/p/plano.md', 'P9'], { registro: quebrado, fs: {} });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /item P9 não existe/);
});

test('caminhoDoRegistro troca .md por .registro.json', () => {
  assert.equal(caminhoDoRegistro('/a/b/2026-10-20-x.md'), path.resolve('/a/b/2026-10-20-x.registro.json'));
});
