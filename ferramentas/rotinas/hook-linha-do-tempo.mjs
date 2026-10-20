#!/usr/bin/env node
// Hook de comando (settings.json) para SessionEnd e PreCompact. Sem IA, rápido, nunca bloqueia (sai 0 sempre).
// SessionEnd → 1 linha em ~/.claude/rotinas/linha-do-tempo/AAAA-MM-DD.jsonl (motivo do fim + próximo passo).
// PreCompact → passagem mecânica em ~/.claude/handoffs/ antes de o compact apagar o contexto.
import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const HOME = homedir()
const dia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const git = (cwd, ...a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim() } catch { return '' } }

try {
  const e = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const { lerSessao } = await import('./linha-do-tempo.mjs')
  const s = e.transcript_path ? (() => { try { return lerSessao(e.transcript_path, 384 << 10, 64 << 10) } catch { return null } })() : null
  const cwd = s?.pasta || e.cwd || HOME
  const agora = new Date()

  if (e.hook_event_name === 'SessionEnd') {
    const pasta = join(HOME, '.claude/rotinas/linha-do-tempo')
    mkdirSync(pasta, { recursive: true })
    appendFileSync(join(pasta, `${dia(agora)}.jsonl`), JSON.stringify({
      sessao: e.session_id, fim: agora.toISOString(), motivo: e.reason || null,
      inicio: s?.inicio || null, pasta: cwd, branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') || s?.branch || null,
      titulo: s?.titulo || null, proximo: s?.proximo || null,
    }) + '\n')
  }

  if (e.hook_event_name === 'PreCompact') {
    const pasta = join(HOME, '.claude/handoffs')
    mkdirSync(pasta, { recursive: true })
    const arq = join(pasta, `${dia(agora)}-${basename(cwd)}-${String(e.session_id || 'sessao').slice(0, 8)}-compact.md`)
    const status = git(cwd, 'status', '--short')
    const diff = git(cwd, 'diff', '--stat', 'HEAD')
    const log = git(cwd, 'log', '-5', '--format=%h %s')
    const md = `# Passagem automática (antes do compact ${e.trigger || ''})\n\n` +
      `- **Quando:** ${agora.toLocaleString('pt-BR')}\n- **Sessão:** ${s?.titulo || ''} · \`${e.session_id || ''}\`\n` +
      `- **Pasta:** \`${cwd}\` · branch \`${git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') || s?.branch || '?'}\`\n` +
      `- **Retomar:** \`cd ${(s?.pastaInicio || cwd).replace(HOME, '~')} && claude --resume ${e.session_id || ''}\`\n\n` +
      `## Último pedido\n\n${s?.pedido || '(não achei)'}\n\n## Próximo passo (da última resposta)\n\n${s?.proximo || '(a última resposta não tinha "Próximo")'}\n\n` +
      `## Arquivos sem commit\n\n\`\`\`\n${status || '(nada)'}\n\`\`\`\n\n## Diff\n\n\`\`\`\n${diff || '(nada)'}\n\`\`\`\n\n## Últimos commits\n\n\`\`\`\n${log || '(sem git)'}\n\`\`\`\n\n` +
      `_Gerado por ~/.claude/rotinas/hook-linha-do-tempo.mjs (sem IA)._\n`
    writeFileSync(arq, md)
  }
} catch {}
process.exit(0)
