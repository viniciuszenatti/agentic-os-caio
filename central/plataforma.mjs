// Diferenças de sistema operacional num lugar só (Linux, Windows; macOS sem teste).
// Tudo recebe `platform` (e o que mais tocar o mundo) por parâmetro: os testes rodam os dois sistemas em qualquer máquina.
// Regra do repo: nada de shell com texto do usuário. Cada função devolve { cmd, args } para spawn(cmd, args).
import nodePath from 'node:path';
import nodeFs from 'node:fs';
import os from 'node:os';

export const ehWindows = (platform = process.platform) => platform === 'win32';
/** O módulo `path` do sistema pedido (path.win32 ou path.posix). */
export const pathDe = (platform = process.platform) => (ehWindows(platform) ? nodePath.win32 : nodePath.posix);

/** Motivo padrão das peças que não existem num sistema. */
export const indisponivel = (oque, platform = process.platform) =>
  `indisponível no ${ehWindows(platform) ? 'Windows' : platform === 'darwin' ? 'macOS' : platform}: ${oque}`;

/** Separa uma lista de caminhos de variável de ambiente (":" no Linux/macOS, ";" no Windows). */
export function separarCaminhos(texto, platform = process.platform) {
  return String(texto ?? '').split(pathDe(platform).delimiter).map((x) => x.trim()).filter(Boolean);
}

/** Expande "~", "~/x" e "~\x" para o HOME dado. */
export function expandirTil(p, home, platform = process.platform) {
  if (typeof p !== 'string') return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || (ehWindows(platform) && p.startsWith('~\\'))) return pathDe(platform).join(home, p.slice(2));
  return p;
}

/** `filho` fica dentro de `raiz`? Compara por caminho (no Windows sem diferenciar maiúscula, e com "\" ou "/"). */
export function dentroDe(filho, raiz, platform = process.platform) {
  if (typeof filho !== 'string' || typeof raiz !== 'string' || !filho || !raiz) return false;
  const P = pathDe(platform);
  let f = P.resolve(filho), r = P.resolve(raiz);
  if (ehWindows(platform)) { f = f.toLowerCase(); r = r.toLowerCase(); }
  if (f === r) return true;
  return f.startsWith(r.endsWith(P.sep) ? r : r + P.sep);
}

/** Caminho com "/" (Windows aceita): para citar caminhos em texto que vai a um shell (o prompt das sessões). */
export const barrasNormais = (p, platform = process.platform) => (ehWindows(platform) ? String(p).replace(/\\/g, '/') : String(p));

/** Pasta onde o Claude Code guarda os scratchpads das sessões. */
export function pastaScratch({ platform = process.platform, tmpdir = os.tmpdir(), uid = process.getuid?.() } = {}) {
  if (ehWindows(platform)) return pathDe(platform).join(tmpdir, 'claude');
  return `/tmp/claude-${uid ?? 1000}`;
}

/**
 * Ambiente dos processos filhos. No Linux mantém o PATH curto e previsível de sempre;
 * no Windows o PATH do sistema fica como está (é lá que estão node, git e o claude) e só HOME/USERPROFILE seguem o HOME da Central.
 */
export function ambienteFilho(env, home, platform = process.platform) {
  if (ehWindows(platform)) return { ...env, HOME: home, USERPROFILE: home };
  return { ...env, HOME: home, PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin` };
}

/** Processo está vivo? Linux: /proc/<pid>. Outros: process.kill(pid, 0) (não mata, só pergunta). */
export function pidVivo(pid, { platform = process.platform, fs = nodeFs, kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (platform === 'linux') return fs.existsSync(`/proc/${pid}`);
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Comando que abre um arquivo/pasta no programa padrão, sem shell. */
export function comandoAbrir(caminho, platform = process.platform) {
  if (ehWindows(platform)) return { cmd: 'explorer.exe', args: [caminho] };
  if (platform === 'darwin') return { cmd: 'open', args: [caminho] };
  return { cmd: 'setsid', args: ['-f', 'xdg-open', caminho] };
}

/**
 * Comando que abre um terminal novo já rodando `argv` (ex.: claude attach <nome>).
 * `terminal` vem de CENTRAL_TERMINAL. Linux: konsole/gnome-terminal etc. com "-e"; Windows: Windows Terminal (wt.exe).
 */
export function comandoTerminal(argv, { platform = process.platform, terminal } = {}) {
  if (ehWindows(platform)) {
    const t = terminal || 'wt.exe';
    return { cmd: t, args: /(^|[\\/])wt(\.exe)?$/i.test(t) ? ['new-tab', ...argv] : argv };
  }
  if (platform === 'darwin' && !terminal) return { cmd: 'open', args: ['-a', 'Terminal', ...argv] };
  return { cmd: terminal || 'konsole', args: ['-e', ...argv] };
}

/**
 * Acha um executável no PATH como o sistema acharia, sem shell.
 * Windows: testa PATHEXT (.COM;.EXE;.BAT;.CMD…). Devolve o caminho completo ou null.
 */
export function acharNoPath(nome, { platform = process.platform, env = process.env, fs = nodeFs } = {}) {
  const P = pathDe(platform);
  const pathVar = ehWindows(platform) ? (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '') : (env.PATH ?? '');
  const exts = ehWindows(platform)
    ? (P.extname(nome) ? [''] : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()))
    : [''];
  const ehArquivo = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const pastas = P.isAbsolute(nome) ? [''] : separarCaminhos(pathVar, platform).map((d) => d.replace(/^"|"$/g, ''));
  for (const d of pastas) {
    for (const e of exts) {
      const f = d ? P.join(d, nome + e) : nome + e;
      if (ehArquivo(f)) return f;
    }
  }
  return null;
}

/**
 * Como rodar o `claude` neste sistema, sem shell.
 * - Linux/macOS: "claude" (o PATH resolve).
 * - Windows, instalação nativa: claude.exe direto.
 * - Windows, instalação por npm: claude.cmd é um atalho de lote; rodar .cmd exigiria shell:true (o cmd.exe reinterpreta
 *   o texto do prompt). Em vez disso, roda o cli.js do pacote com o próprio node: { cmd: node, prefixo: [cli.js] }.
 * Devolve { cmd, prefixo } ou { erro }.
 */
export function resolverClaude({ platform = process.platform, env = process.env, fs = nodeFs, node = process.execPath } = {}) {
  if (!ehWindows(platform)) return { cmd: 'claude', prefixo: [] };
  const P = pathDe(platform);
  const achado = acharNoPath('claude', { platform, env, fs });
  if (!achado) return { erro: 'claude não encontrado no PATH (instale o Claude Code para Windows)' };
  const ext = P.extname(achado).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { cmd: achado, prefixo: [] };
  if (ext === '.cmd' || ext === '.bat') {
    const pasta = P.dirname(achado);
    const candidatos = [
      P.join(pasta, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      P.join(pasta, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ];
    // o atalho do npm cita o script: "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"
    try {
      const m = fs.readFileSync(achado, 'utf8').match(/%~?dp0%?\\?([^"\r\n]+?\.(?:c?js|mjs))"/i);
      if (m) candidatos.unshift(P.join(pasta, m[1]));
    } catch {}
    for (const c of candidatos) { try { if (fs.statSync(c).isFile()) return { cmd: node, prefixo: [c] }; } catch {} }
    return { erro: `achei ${achado}, que é um atalho .cmd; rodá-lo exigiria shell. Instale o Claude Code nativo (claude.exe)` };
  }
  return { erro: `não sei rodar ${achado} sem shell` };
}

/**
 * Embrulha um spawn para que "claude" vire o executável certo do sistema (ver resolverClaude).
 * Os outros comandos passam como estão. Resolve uma vez e guarda.
 */
export function spawnComClaude(spawn, opcoes = {}) {
  let resolvido = null;
  return (cmd, args = [], o = {}) => {
    if (cmd !== 'claude') return spawn(cmd, args, o);
    resolvido ??= resolverClaude(opcoes);
    if (resolvido.erro) throw new Error(resolvido.erro);
    return spawn(resolvido.cmd, [...resolvido.prefixo, ...args], { ...o, shell: false });
  };
}

/** O que existe em cada sistema (a página mostra "indisponível no Windows" a partir daqui). */
export function recursos(platform = process.platform) {
  const linux = platform === 'linux';
  return {
    plataforma: platform,
    nome: ehWindows(platform) ? 'Windows' : platform === 'darwin' ? 'macOS' : linux ? 'Linux' : platform,
    capacidade: linux,      // lê /proc e /sys
    diagnostico: linux,     // diagnostico.sh (bash, /proc, systemd)
    modoBuild: linux,       // pausa timers do systemd
    rotinasSystemd: linux,  // timers e serviço como unidades do systemd
    nuvem: !ehWindows(platform), // claude --cloud precisa de pseudo-terminal (pty.py usa o pty do Python)
    deckHeadless: !ehWindows(platform), // o deck grava a saída por bash
    abrir: true,
    terminal: true,
  };
}
