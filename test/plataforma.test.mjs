// Helpers de sistema operacional (central/plataforma.mjs). O `platform` é injetado: os casos de Windows rodam no Linux e vice-versa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  acharNoPath, ambienteFilho, barrasNormais, comandoAbrir, comandoTerminal, dentroDe, expandirTil, indisponivel,
  pastaScratch, pathDe, pidVivo, recursos, resolverClaude, separarCaminhos, spawnComClaude,
} from '../central/plataforma.mjs';
import { validarRepo, embrulhar, argvLocal } from '../central/lancar/lancar.mjs';

// fs falso: só statSync/readFileSync/existsSync sobre um mapa de arquivos
function fsFalso(arquivos = {}) {
  return {
    statSync(p) { if (!(p in arquivos)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => true }; },
    readFileSync(p) { if (!(p in arquivos)) throw new Error('ENOENT'); return arquivos[p]; },
    existsSync: (p) => p in arquivos,
  };
}

test('pathDe e separarCaminhos seguem o sistema pedido', () => {
  assert.equal(pathDe('win32'), path.win32);
  assert.equal(pathDe('linux'), path.posix);
  assert.deepEqual(separarCaminhos('~/Projects:~/code', 'linux'), ['~/Projects', '~/code']);
  // no Windows ":" faz parte de "C:\": a lista usa ";"
  assert.deepEqual(separarCaminhos('~/Projects;D:\\code; ', 'win32'), ['~/Projects', 'D:\\code']);
  assert.deepEqual(separarCaminhos('', 'win32'), []);
});

test('expandirTil aceita ~/ em todo sistema e ~\\ só no Windows', () => {
  assert.equal(expandirTil('~/Projects/x', '/home/voce', 'linux'), '/home/voce/Projects/x');
  assert.equal(expandirTil('~', '/home/voce', 'linux'), '/home/voce');
  assert.equal(expandirTil('~\\x', '/home/voce', 'linux'), '~\\x');
  assert.equal(expandirTil('~/Projects/x', 'C:\\Users\\voce', 'win32'), 'C:\\Users\\voce\\Projects\\x');
  assert.equal(expandirTil('~\\Projects', 'C:\\Users\\voce', 'win32'), 'C:\\Users\\voce\\Projects');
});

test('dentroDe: prefixo de pasta inteira; no Windows sem diferenciar maiúscula e com / ou \\', () => {
  assert.ok(dentroDe('/home/voce/.claude/x.md', '/home/voce/.claude', 'linux'));
  assert.ok(!dentroDe('/home/voce/.claude-mem/x.md', '/home/voce/.claude', 'linux'));
  assert.ok(!dentroDe('/home/voce/.Claude/x.md', '/home/voce/.claude', 'linux'));
  assert.ok(dentroDe('c:\\users\\voce\\.claude\\x.md', 'C:\\Users\\voce\\.claude', 'win32'));
  assert.ok(dentroDe('C:/Users/voce/.claude/x.md', 'C:\\Users\\voce\\.claude\\', 'win32'));
  assert.ok(!dentroDe('C:\\Users\\voce\\.claude-mem\\x.md', 'C:\\Users\\voce\\.claude', 'win32'));
  assert.ok(!dentroDe('D:\\Users\\voce\\.claude\\x.md', 'C:\\Users\\voce\\.claude', 'win32'));
  assert.ok(!dentroDe('', '/x', 'linux'));
});

test('barrasNormais troca \\ por / só no Windows', () => {
  assert.equal(barrasNormais('C:\\a\\b.md', 'win32'), 'C:/a/b.md');
  assert.equal(barrasNormais('/a/b\\c', 'linux'), '/a/b\\c');
});

test('pastaScratch: /tmp/claude-<uid> no Linux, %TEMP%\\claude no Windows', () => {
  assert.equal(pastaScratch({ platform: 'linux', uid: 1000 }), '/tmp/claude-1000');
  assert.equal(pastaScratch({ platform: 'win32', tmpdir: 'C:\\Users\\voce\\AppData\\Local\\Temp' }), 'C:\\Users\\voce\\AppData\\Local\\Temp\\claude');
});

test('ambienteFilho: PATH curto no Linux; no Windows o PATH do sistema fica e USERPROFILE segue o HOME', () => {
  const lin = ambienteFilho({ PATH: '/x', A: '1' }, '/home/voce', 'linux');
  assert.equal(lin.PATH, '/home/voce/.local/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(lin.HOME, '/home/voce');
  assert.equal(lin.A, '1');
  const win = ambienteFilho({ Path: 'C:\\Windows;C:\\node', A: '1' }, 'C:\\Users\\voce', 'win32');
  assert.equal(win.Path, 'C:\\Windows;C:\\node');
  assert.equal(win.PATH, undefined, 'não cria um PATH paralelo ao Path');
  assert.equal(win.USERPROFILE, 'C:\\Users\\voce');
  assert.equal(win.HOME, 'C:\\Users\\voce');
});

test('pidVivo: /proc no Linux, kill(pid, 0) nos outros; pid inválido é falso', () => {
  const fs = { existsSync: (p) => p === '/proc/42' };
  assert.equal(pidVivo(42, { platform: 'linux', fs }), true);
  assert.equal(pidVivo(43, { platform: 'linux', fs }), false);
  const sinais = [];
  const kill = (pid, s) => { sinais.push([pid, s]); if (pid === 7) throw Object.assign(new Error('x'), { code: 'ESRCH' }); if (pid === 8) throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  assert.equal(pidVivo(6, { platform: 'win32', kill }), true);
  assert.equal(pidVivo(7, { platform: 'win32', kill }), false);
  assert.equal(pidVivo(8, { platform: 'win32', kill }), true, 'EPERM = existe, só não é meu');
  assert.deepEqual(sinais[0], [6, 0], 'sinal 0 só pergunta, não mata');
  assert.equal(pidVivo(1, { platform: 'win32', kill }), false);
  assert.equal(pidVivo('12', { platform: 'linux', fs }), false);
  assert.equal(pidVivo(process.pid), true, 'o próprio processo está vivo no sistema de verdade');
});

test('comandoAbrir: argv sem shell em cada sistema', () => {
  assert.deepEqual(comandoAbrir('/a b/x.md', 'linux'), { cmd: 'setsid', args: ['-f', 'xdg-open', '/a b/x.md'] });
  assert.deepEqual(comandoAbrir('C:\\a & b\\x.md', 'win32'), { cmd: 'explorer.exe', args: ['C:\\a & b\\x.md'] });
  assert.deepEqual(comandoAbrir('/x.md', 'darwin'), { cmd: 'open', args: ['/x.md'] });
});

test('comandoTerminal: konsole -e no Linux, wt new-tab no Windows, CENTRAL_TERMINAL troca', () => {
  const argv = ['claude', 'attach', 'plano-p1'];
  assert.deepEqual(comandoTerminal(argv, { platform: 'linux' }), { cmd: 'konsole', args: ['-e', ...argv] });
  assert.deepEqual(comandoTerminal(argv, { platform: 'linux', terminal: 'gnome-terminal' }), { cmd: 'gnome-terminal', args: ['-e', ...argv] });
  assert.deepEqual(comandoTerminal(argv, { platform: 'win32' }), { cmd: 'wt.exe', args: ['new-tab', ...argv] });
  assert.deepEqual(comandoTerminal(argv, { platform: 'win32', terminal: 'C:\\x\\wt.exe' }), { cmd: 'C:\\x\\wt.exe', args: ['new-tab', ...argv] });
  assert.deepEqual(comandoTerminal(argv, { platform: 'win32', terminal: 'alacritty.exe' }), { cmd: 'alacritty.exe', args: argv });
});

test('acharNoPath: PATHEXT no Windows (Path com qualquer caixa), PATH simples no Linux', () => {
  const W = path.win32;
  const fs = fsFalso({ [W.join('C:\\bin', 'claude.CMD')]: '', [W.join('D:\\app', 'git.exe')]: '' });
  assert.equal(acharNoPath('git', { platform: 'win32', env: { Path: 'C:\\bin;"D:\\app"', PATHEXT: '.COM;.EXE;.CMD' }, fs }), 'D:\\app\\git.exe');
  assert.equal(acharNoPath('claude', { platform: 'win32', env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' }, fs }), null, 'PATHEXT vem minúsculo; o fs falso diferencia caixa');
  const fs2 = fsFalso({ 'C:\\bin\\claude.cmd': '' });
  assert.equal(acharNoPath('claude', { platform: 'win32', env: { PATH: 'C:\\bin' }, fs: fs2 }), 'C:\\bin\\claude.cmd');
  const fs3 = fsFalso({ '/usr/bin/claude': '' });
  assert.equal(acharNoPath('claude', { platform: 'linux', env: { PATH: '/opt:/usr/bin' }, fs: fs3 }), '/usr/bin/claude');
  assert.equal(acharNoPath('nada', { platform: 'linux', env: { PATH: '/usr/bin' }, fs: fs3 }), null);
});

test('resolverClaude: Linux usa "claude"; Windows prefere claude.exe e troca o .cmd do npm por node + cli.js', () => {
  assert.deepEqual(resolverClaude({ platform: 'linux' }), { cmd: 'claude', prefixo: [] });
  const exe = fsFalso({ 'C:\\Users\\voce\\.local\\bin\\claude.exe': '' });
  assert.deepEqual(resolverClaude({ platform: 'win32', env: { Path: 'C:\\Users\\voce\\.local\\bin', PATHEXT: '.EXE;.CMD' }, fs: exe }),
    { cmd: 'C:\\Users\\voce\\.local\\bin\\claude.exe', prefixo: [] });
  const npm = 'C:\\Users\\voce\\AppData\\Roaming\\npm';
  const cli = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  const fsNpm = fsFalso({ [`${npm}\\claude.cmd`]: '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n', [cli]: '' });
  assert.deepEqual(resolverClaude({ platform: 'win32', env: { PATH: npm }, fs: fsNpm, node: 'C:\\node\\node.exe' }), { cmd: 'C:\\node\\node.exe', prefixo: [cli] });
  const soCmd = fsFalso({ 'C:\\x\\claude.cmd': 'qualquer coisa' });
  assert.match(resolverClaude({ platform: 'win32', env: { PATH: 'C:\\x' }, fs: soCmd }).erro, /exigiria shell/);
  assert.match(resolverClaude({ platform: 'win32', env: { PATH: '' }, fs: fsFalso() }).erro, /não encontrado/);
});

test('spawnComClaude: troca só o "claude", nunca liga shell, e falha clara sem executável', () => {
  const chamadas = [];
  const spawn = (cmd, args, o) => { chamadas.push({ cmd, args, o }); return {}; };
  const fs = fsFalso({ 'C:\\b\\claude.exe': '' });
  const s = spawnComClaude(spawn, { platform: 'win32', env: { PATH: 'C:\\b' }, fs });
  s('git', ['status'], { cwd: 'C:\\r' });
  s('claude', ['-p', 'olá & del *'], { cwd: 'C:\\r', shell: true });
  assert.deepEqual(chamadas[0], { cmd: 'git', args: ['status'], o: { cwd: 'C:\\r' } });
  assert.equal(chamadas[1].cmd, 'C:\\b\\claude.exe');
  assert.deepEqual(chamadas[1].args, ['-p', 'olá & del *'], 'o texto vai como UM argumento');
  assert.equal(chamadas[1].o.shell, false);
  const sem = spawnComClaude(spawn, { platform: 'win32', env: { PATH: '' }, fs: fsFalso() });
  assert.throws(() => sem('claude', ['agents']), /não encontrado/);
  const lin = spawnComClaude(spawn, { platform: 'linux' });
  lin('claude', ['agents']);
  assert.equal(chamadas.at(-1).cmd, 'claude');
});

test('recursos e indisponivel: o que degrada em cada sistema', () => {
  const l = recursos('linux'), w = recursos('win32');
  assert.equal(l.capacidade && l.diagnostico && l.modoBuild && l.rotinasSystemd && l.nuvem, true);
  assert.equal(w.nome, 'Windows');
  assert.equal(w.capacidade || w.diagnostico || w.modoBuild || w.rotinasSystemd || w.nuvem || w.deckHeadless, false);
  assert.equal(w.abrir && w.terminal, true);
  assert.equal(indisponivel('x', 'win32'), 'indisponível no Windows: x');
});

test('lançador no Windows: repo com letra de unidade e caixa diferente; prompt cita caminhos com /', () => {
  const home = 'C:\\Users\\voce';
  assert.equal(validarRepo('~/Projects/app', { home, platform: 'win32' }), 'C:\\Users\\voce\\Projects\\app');
  assert.equal(validarRepo('c:\\users\\voce\\projects\\app', { home, platform: 'win32' }), 'c:\\users\\voce\\projects\\app');
  assert.throws(() => validarRepo('D:\\Projects\\app', { home, platform: 'win32' }), /fora das pastas/);
  assert.throws(() => validarRepo('~/Projects/../.ssh', { home, platform: 'win32' }), /fora das pastas/);
  assert.equal(validarRepo('D:\\code\\x', { home, platform: 'win32', raizes: ['~/Projects', 'D:\\code'] }), 'D:\\code\\x');
  const t = embrulhar({ id: 'P1', prompt: 'faça', onde: 'local' }, { planoArquivo: 'C:\\Users\\voce\\.claude\\agentic-os\\planos\\p.md', marcador: 'C:\\os\\central\\planos\\marcar.mjs', platform: 'win32' });
  assert.ok(t.includes('node "C:/os/central/planos/marcar.mjs" iniciou "C:/Users/voce/.claude/agentic-os/planos/p.md" P1'));
  // no Linux a barra invertida continua sendo recusada (o shell a interpretaria)
  assert.throws(() => embrulhar({ id: 'P1', prompt: 'faça', onde: 'local' }, { planoArquivo: '/a\\b.md', platform: 'linux' }), /shell/);
  const argv = argvLocal({ id: 'P2', repo: '~/Projects/app', prompt: 'x' }, { modelo: 'claude-sonnet-5-5', esforco: 'low', permissao: 'default' },
    { home, planoArquivo: 'C:\\p\\2026-10-20-win.md', marcador: 'C:\\m.mjs', platform: 'win32' });
  assert.equal(argv[0], 'claude');
  assert.match(argv.at(-1), /"C:\/p\/2026-10-20-win\.md" P2/);
});
