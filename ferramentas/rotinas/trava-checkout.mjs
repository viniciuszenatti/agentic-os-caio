#!/usr/bin/env node
// Hook PreToolUse (Bash): barra comando que troca o HEAD ou mexe no working tree inteiro quando OUTRA sessão viva
// do Claude está no MESMO checkout (mesmo toplevel do git). Evita a colisão de HEAD: sessão B troca a branch
// e os commits da sessão A caem na branch errada.
// Não pergunta (sessão não-interativa nega em vez de perguntar): nega com o motivo e o caminho (worktree).
// Escape consciente: acrescentar o comentário `# trava-ok` ao comando. Sai 0 em qualquer erro (nunca trava à toa).
import { readFileSync, readdirSync, realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

// Comandos que mudam o HEAD ou o working tree inteiro (não: status/log/diff/add/commit/push/fetch/`checkout -- arquivo`).
const PERIGO = [
  /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\b(?![^;&|]*\s--\s)/,
  /\bgit\s+(?:-C\s+\S+\s+)?(?:rebase|pull|merge|stash|cherry-pick|revert|am)\b/,
  /\bgit\s+(?:-C\s+\S+\s+)?reset\s+--(?:hard|merge|keep)\b/,
  /\bgh\s+pr\s+checkout\b/,
]

export function trocaHead(cmd) {
  if (/#\s*trava-ok\b/.test(cmd)) return false
  // `git checkout -- arq` e `git checkout <ref> -- arq` só restauram arquivo
  return PERIGO.some(re => re.test(cmd))
}

const topo = cwd => {
  try { return realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { return null }
}

// Pasta ATUAL da sessão: o registro guarda só a de início; o fim do transcript tem a atual.
function pastaAtual(s) {
  try {
    const arq = join(homedir(), '.claude/projects', s.cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${s.sessionId}.jsonl`)
    const tam = statSync(arq).size, n = Math.min(tam, 96 << 10), buf = Buffer.alloc(n), fd = openSync(arq, 'r')
    try { readSync(fd, buf, 0, n, tam - n) } finally { closeSync(fd) }
    const m = [...buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)].pop()
    return m ? JSON.parse(`"${m[1]}"`) : s.cwd
  } catch { return s.cwd }
}

export function vizinhos(meuTopo, minhaSessao) {
  const d = join(homedir(), '.claude/sessions'), out = []
  let fs = []; try { fs = readdirSync(d) } catch {}
  for (const f of fs.filter(f => f.endsWith('.json'))) {
    try {
      const s = JSON.parse(readFileSync(join(d, f), 'utf8'))
      if (!s.cwd || !s.pid || s.sessionId === minhaSessao) continue
      process.kill(s.pid, 0)
      if (topo(pastaAtual(s)) === meuTopo || topo(s.cwd) === meuTopo) out.push(s)
    } catch {}
  }
  return out
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    const e = JSON.parse(readFileSync(0, 'utf8') || '{}')
    const cmd = e.tool_input?.command || ''
    if (e.tool_name === 'Bash' && trocaHead(cmd)) {
      const alvo = cmd.match(/\bgit\s+-C\s+(\S+)/)?.[1]?.replace(/^~/, homedir()) || e.cwd
      const meu = alvo && topo(alvo)
      const outros = meu ? vizinhos(meu, e.session_id) : []
      if (outros.length) {
        const quem = outros.map(s => `"${s.name || s.sessionId?.slice(0, 8) || s.pid}"`).join(', ')
        const motivo = `trava-checkout: ${outros.length} outra(s) sessão(ões) viva(s) no mesmo checkout ${meu} (${quem}). ` +
          'Trocar branch/rebase/pull/stash/reset aqui muda o HEAD delas também e os commits caem na branch errada. ' +
          `Faça o trabalho num worktree próprio: git -C ${meu} worktree add ../${meu.split('/').pop()}-<frente> -b <branch>. ` +
          'Se o dono do repositório autorizou mesmo assim, repita o comando com o comentário "# trava-ok" no fim.'
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: motivo } }))
      }
    }
  } catch {}
  process.exit(0)
}
