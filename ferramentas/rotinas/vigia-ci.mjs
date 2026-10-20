#!/usr/bin/env node
// Vigia de CI: lista os SEUS PRs abertos (gh --author @me) em cada repo GitHub da pasta de projetos
// (~/Projects ou AGENTIC_OS_PROJETOS) e avisa só quando um PR MUDA para "falhou" (ou volta a verde
// depois de falhar). Só leitura (gh pr list). Precisa do gh CLI logado.
// Grava ~/.claude/rotinas/estado/vigia-ci.json (itens: {chave, repo, numero, titulo, url, branch, situacao, falhos[]}).
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJETOS, sh, lerEstado, gravarEstado, notificar, listar } from './comum.mjs'

const ROTINA = 'vigia-ci'

// Repos-mãe (pasta com .git DIRETÓRIO — worktree tem .git arquivo), fora wt-* e bancadas; remote GitHub; sem duplicar.
const repos = new Map()
for (const d of listar(PROJETOS)) {
  if (d.startsWith('wt-') || d === 'bancadas') continue
  const g = join(PROJETOS, d, '.git')
  if (!existsSync(g) || !statSync(g).isDirectory()) continue
  const url = sh('git', ['-C', join(PROJETOS, d), 'remote', 'get-url', 'origin']).out
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)
  if (m && !repos.has(m[1])) repos.set(m[1], d)
}

const FALHA = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
function situacao(rollup = []) {
  if (!rollup.length) return 'sem-checks'
  let pend = false
  const falhos = []
  for (const c of rollup) {
    const r = c.conclusion || c.state || ''
    if (FALHA.has(r)) falhos.push(c.name || c.context || '?')
    else if ((c.status && c.status !== 'COMPLETED') || r === 'PENDING' || r === 'EXPECTED') pend = true
  }
  if (falhos.length) return { s: 'falhou', falhos }
  return pend ? 'rodando' : 'verde'
}

const anterior = Object.fromEntries((lerEstado(ROTINA)?.itens || []).map(i => [i.chave, i.situacao]))
const itens = [], erros = [], mudancas = []
for (const [repo] of repos) {
  const r = sh('gh', ['pr', 'list', '-R', repo, '--author', '@me', '--state', 'open', '--json', 'number,title,url,headRefName,statusCheckRollup', '--limit', '50'])
  if (!r.ok) { erros.push(`${repo}: ${r.err}`); continue }
  for (const pr of JSON.parse(r.out || '[]')) {
    const sit = situacao(pr.statusCheckRollup)
    const s = typeof sit === 'string' ? sit : sit.s
    const chave = `${repo}#${pr.number}`
    const antes = anterior[chave]
    const item = { chave, repo, numero: pr.number, titulo: pr.title, url: pr.url, branch: pr.headRefName, situacao: s, falhos: sit.falhos || [], antes: antes ?? null }
    itens.push(item)
    if (antes && antes !== 'falhou' && s === 'falhou') mudancas.push({ ...item, tipo: 'falhou' })
    if (antes === 'falhou' && s === 'verde') mudancas.push({ ...item, tipo: 'verde' })
  }
}

const c = k => itens.filter(i => i.situacao === k).length
const resumo = `${itens.length} PR(s) abertos em ${repos.size} repos: ${c('falhou')} falhou, ${c('rodando')} rodando, ${c('verde')} verde, ${c('sem-checks')} sem checks; ${mudancas.length} mudança(s)` + (erros.length ? `; ${erros.length} erro(s)` : '')
gravarEstado(ROTINA, { ok: !erros.length, resumo, itens, mudancas, erros, repos: [...repos.keys()] })

for (const m of mudancas) {
  if (m.tipo === 'falhou') notificar('Vigia CI', `CI falhou: ${m.repo.split('/')[1]} #${m.numero}`, `${m.titulo}\nCheck: ${m.falhos.slice(0, 3).join(', ')}\n${m.url}`, true)
  else notificar('Vigia CI', `CI voltou a verde: ${m.repo.split('/')[1]} #${m.numero}`, `${m.titulo}\n${m.url}`)
}
console.log(resumo)
for (const i of itens) console.log(`${{ falhou: '[falhou] ', rodando: '[rodando]', verde: '[verde]  ' }[i.situacao] || '[-]      '} ${i.chave} [${i.branch}] ${i.titulo.slice(0, 60)}${i.falhos.length ? ' — ' + i.falhos.join(', ') : ''}`)
for (const e of erros) console.log('ERRO ' + e)
