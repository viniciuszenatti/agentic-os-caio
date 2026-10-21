#!/usr/bin/env node
// coletar.mjs — junta o que foi MERGEADO no ramo principal de cada repo num período e grava JSON + markdown cru.
// Sem dependências, sem LLM, sem API paga. Só lê: `git fetch` do ramo (atualiza refs remotas) + `gh pr list` (opcional).
//
// Uso:
//   node coletar.mjs                                  # últimos 7 dias, todos os repos da pasta de projetos
//   node coletar.mjs --desde 2026-10-01 --ate 2026-10-15
//   node coletar.mjs --desde v1.2                     # tag/ref: tudo depois dela (só repos que têm a ref)
//   node coletar.mjs meu-app minha-api                # só esses repos (nome na pasta de projetos ou caminho)
//   flags: --pasta <dir>  --ramo <main>  --tarefa-re <regex>  --tarefa-url <url com {id}>
//          --sem-fetch  --sem-gh  --json (só imprime o JSON)  --quieto
//
// Pasta de projetos: --pasta > CHANGELOG_PROJETOS > AGENTIC_OS_PROJETOS > ~/Projects (um repo git por subpasta).
// Ids de tarefa (opcional): --tarefa-re ou CHANGELOG_TAREFA_RE (ex.: 'T-\d{4}', '[A-Z]+-\d+'); link: CHANGELOG_TAREFA_URL.
// Saída: ~/.claude/agentic-os/changelog/<AAAA-MM-DD_HHMM>.md e .json (nunca sobrescreve). AGENTIC_OS_DIR troca a base.
// Nomes da lista ~/.claude/rotinas/nomes-sensiveis.txt saem como "[cliente]" (limpar() do comum.mjs das rotinas).

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOME = homedir()
const AQUI = dirname(fileURLToPath(import.meta.url))

// limpar(): comum.mjs instalado (~/.claude/rotinas) ou o do próprio repo (ferramentas/rotinas). Sem nenhum, não troca nada.
let limpar = s => String(s ?? '')
for (const c of [join(HOME, '.claude/rotinas/comum.mjs'), join(AQUI, '../../rotinas/comum.mjs')]) {
  if (!existsSync(c)) continue
  try { const m = await import(pathToFileURL(c).href); if (typeof m.limpar === 'function') { limpar = m.limpar; break } } catch {}
}

// ---------- argumentos ----------
const argv = process.argv.slice(2)
const opt = {
  repos: [], desde: null, ate: null, fetch: true, gh: true, soJson: false, quieto: false,
  pasta: process.env.CHANGELOG_PROJETOS || process.env.AGENTIC_OS_PROJETOS || join(HOME, 'Projects'),
  ramo: process.env.CHANGELOG_RAMO || 'main',
  tarefaRe: process.env.CHANGELOG_TAREFA_RE || null,
  tarefaUrl: process.env.CHANGELOG_TAREFA_URL || null,
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--desde') opt.desde = argv[++i]
  else if (a === '--ate') opt.ate = argv[++i]
  else if (a === '--pasta') opt.pasta = argv[++i]
  else if (a === '--ramo') opt.ramo = argv[++i]
  else if (a === '--tarefa-re') opt.tarefaRe = argv[++i]
  else if (a === '--tarefa-url') opt.tarefaUrl = argv[++i]
  else if (a === '--sem-fetch') opt.fetch = false
  else if (a === '--sem-gh') opt.gh = false
  else if (a === '--json') opt.soJson = true
  else if (a === '--quieto') opt.quieto = true
  else if (a === '-h' || a === '--help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n')); process.exit(0) }
  else if (a.startsWith('--')) { console.error(`flag desconhecida: ${a}`); process.exit(2) }
  else opt.repos.push(a)
}
opt.pasta = resolve(opt.pasta.replace(/^~(?=$|[\\/])/, HOME))
const SAIDA = join(process.env.AGENTIC_OS_DIR || join(HOME, '.claude/agentic-os'), 'changelog')

let TAREFA_RE = null
if (opt.tarefaRe) {
  try { TAREFA_RE = new RegExp(`\\b(?:${opt.tarefaRe})\\b`, 'g') } catch (e) { console.error(`--tarefa-re inválida: ${e.message}`); process.exit(2) }
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/
const dia = d => d.toISOString().slice(0, 10)
const hoje = new Date()
if (!opt.ate) opt.ate = dia(hoje)
if (!opt.desde) opt.desde = dia(new Date(hoje.getTime() - 7 * 864e5))
if (!DATA_RE.test(opt.ate)) { console.error('--ate precisa ser AAAA-MM-DD'); process.exit(2) }
const modoTag = !DATA_RE.test(opt.desde)
const REF = `origin/${opt.ramo}`

// ---------- utilidades ----------
function rodar(cmd, args, timeout = 60000) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 << 20 }).trim() } }
  catch (e) { return { ok: false, out: '', err: String(e.stderr || e.message).trim().split('\n').slice(-2).join(' | ') } }
}
const git = (repo, args, timeout) => rodar('git', ['-C', repo, ...args], timeout)
const gh = args => rodar('gh', args)
const avisos = []

// ---------- descobrir repos ----------
function reposPadrao() {
  let nomes = []
  try { nomes = readdirSync(opt.pasta) } catch { console.error(`pasta de projetos não existe: ${opt.pasta} (use --pasta ou AGENTIC_OS_PROJETOS)`); process.exit(2) }
  return nomes
    .filter(n => !n.startsWith('wt-') && n !== 'bancadas' && !n.startsWith('.') && !n.startsWith('_'))
    .map(n => join(opt.pasta, n))
    .filter(p => existsSync(join(p, '.git')) && statSync(p).isDirectory())
    // repo cujo nome bate com a lista de nomes sensíveis fica fora do padrão (passe o nome para incluir)
    .filter(p => { if (limpar(basename(p)) !== basename(p)) { avisos.push('1 repo com nome sensível fora do padrão (passe o nome para incluir)'); return false } return true })
}
let repos = opt.repos.length ? opt.repos.map(r => existsSync(r) ? resolve(r) : join(opt.pasta, r)) : reposPadrao()

const vistos = new Set()
repos = repos.filter(r => {
  if (!existsSync(join(r, '.git'))) { avisos.push(`${basename(r)}: não é repo git — pulado`); return false }
  const url = git(r, ['remote', 'get-url', 'origin'])
  if (!url.ok) { avisos.push(`${basename(r)}: sem remote origin — pulado`); return false }
  const chave = url.out.replace(/\.git$/, '').toLowerCase()
  if (vistos.has(chave)) return false // mesmo remote em duas pastas (clone + worktree)
  vistos.add(chave)
  return true
})

// ---------- conventional commit ----------
const TIPOS = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore', 'ci', 'build', 'style', 'revert']
const ORDEM = [...TIPOS, 'outro']
const ROTULO = { feat: 'Novidades', fix: 'Correções', perf: 'Desempenho', refactor: 'Refatoração', docs: 'Documentação', test: 'Testes', chore: 'Manutenção', ci: 'CI', build: 'Build', style: 'Estilo', revert: 'Reversões', outro: 'Outros' }
const PUBLICO = new Set(['feat', 'fix', 'perf']) // candidatos ao bloco "Clientes/usuários"
const SINONIMO = { feature: 'feat', bugfix: 'fix', hotfix: 'fix', doc: 'docs', tests: 'test' }

function parse(subject) {
  const m = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/)
  if (!m) return { tipo: 'outro', escopo: null, quebra: false, assunto: subject }
  let tipo = m[1].toLowerCase(); tipo = SINONIMO[tipo] || tipo
  return { tipo: TIPOS.includes(tipo) ? tipo : 'outro', escopo: m[2] || null, quebra: !!m[3] || /BREAKING CHANGE/.test(subject), assunto: m[4] }
}
const tarefas = txt => TAREFA_RE ? [...new Set(txt.match(TAREFA_RE) || [])] : []
// refs a issue de outro repo: dono/repo#123 ou repo#123
const refsIssue = txt => [...new Set((txt.match(/\b[\w.-]+(?:\/[\w.-]+)?#\d+\b/g) || []))]

// ---------- coleta por repo ----------
const resultado = []
for (const repo of repos) {
  const nome = basename(repo)
  const r = { repo: nome, github: null, entregas: [], avisos: [] }
  const url = git(repo, ['remote', 'get-url', 'origin']).out
  const gm = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)
  r.github = gm ? gm[1] : null

  if (opt.fetch) {
    const f = git(repo, ['fetch', '--quiet', '--no-tags', 'origin', opt.ramo], 90000)
    if (!f.ok) r.avisos.push(`fetch falhou (${f.err}) — usando ${REF} local`)
  }
  if (!git(repo, ['rev-parse', '--verify', '-q', REF]).ok) { avisos.push(`${nome}: sem ${REF} — pulado (use --ramo)`); continue }

  let faixa, desdeData = opt.desde
  if (modoTag) {
    if (!git(repo, ['rev-parse', '--verify', '-q', opt.desde]).ok) { avisos.push(`${nome}: sem a ref ${opt.desde} — pulado`); continue }
    faixa = [`${opt.desde}..${REF}`]
    desdeData = git(repo, ['log', '-1', '--format=%cs', opt.desde]).out
  } else {
    faixa = [REF, `--since=${opt.desde} 00:00`, `--until=${opt.ate} 23:59:59`]
  }

  // PRs mergeados pelo gh (título + número + url), indexados pelo SHA do merge
  const prPorSha = new Map(), prPorNum = new Map()
  if (opt.gh && r.github) {
    const p = gh(['pr', 'list', '--repo', r.github, '--state', 'merged', '--base', opt.ramo, '--search', `merged:${desdeData}..${opt.ate}`, '--limit', '300', '--json', 'number,title,url,mergedAt,mergeCommit,headRefName'])
    if (p.ok) {
      for (const pr of JSON.parse(p.out || '[]')) {
        prPorNum.set(pr.number, pr)
        if (pr.mergeCommit?.oid) prPorSha.set(pr.mergeCommit.oid, pr)
      }
    } else r.avisos.push(`gh indisponível (${p.err}) — PR só pelo texto do merge`)
  }

  // caminho de primeiro pai: cada merge = um PR; commit direto = entrega solta
  const SEP = '\x1f'
  const log = git(repo, ['log', '--first-parent', `--format=%H${SEP}%P${SEP}%cs${SEP}%an${SEP}%s${SEP}%b\x1e`, ...faixa])
  if (!log.ok) { r.avisos.push(`git log falhou: ${log.err}`); resultado.push(r); continue }
  const linhas = log.out.split('\x1e').map(s => s.trim()).filter(Boolean)

  for (const ln of linhas) {
    const [sha, pais, data, autor, subject, corpo = ''] = ln.split(SEP)
    const paisL = pais.split(' ')
    const merge = paisL.length > 1
    let pr = prPorSha.get(sha) || null
    const numTexto = (subject.match(/Merge pull request #(\d+)/) || subject.match(/\(#(\d+)\)\s*$/) || [])[1]
    if (!pr && numTexto) pr = prPorNum.get(Number(numTexto)) || { number: Number(numTexto), title: null, url: r.github ? `https://github.com/${r.github}/pull/${numTexto}` : null }

    let commits = []
    if (merge) {
      const c = git(repo, ['log', '--no-merges', `--format=%h${SEP}%s${SEP}%b\x1e`, `${paisL[0]}..${paisL[1]}`])
      commits = c.out.split('\x1e').map(s => s.trim()).filter(Boolean).map(x => {
        const [h, s, b = ''] = x.split(SEP)
        return { sha: h, ...parse(limpar(s)), tarefas: tarefas(s + ' ' + b), issues: refsIssue(s + ' ' + b) }
      })
    }

    let titulo = pr?.title || (merge && corpo ? corpo.split('\n')[0] : subject)
    if (/^Merge (pull request|branch|remote)/.test(titulo) && commits[0]) titulo = `${commits[0].tipo}${commits[0].escopo ? `(${commits[0].escopo})` : ''}: ${commits[0].assunto}`
    titulo = limpar(titulo)
    const p = parse(titulo)
    if (p.tipo === 'outro' && commits.length) { // título sem conventional: herda o tipo mais "alto" dos commits
      p.tipo = commits.map(c => c.tipo).sort((a, b) => ORDEM.indexOf(a) - ORDEM.indexOf(b))[0]
      p.escopo = p.escopo || commits.find(c => c.escopo)?.escopo || null
    }
    const txtTudo = [titulo, subject, corpo, pr?.headRefName || '', ...commits.map(c => c.assunto)].join(' ')
    const ts = [...new Set([...tarefas(txtTudo), ...commits.flatMap(c => c.tarefas)])]
    r.entregas.push({
      sha: sha.slice(0, 8), data, autor: limpar(autor), tipo: p.tipo, escopo: p.escopo, quebra: p.quebra, titulo: p.assunto,
      pr: pr ? { numero: pr.number, url: pr.url, ramo: pr.headRefName ? limpar(pr.headRefName) : null } : null,
      tarefas: ts.map(id => ({ id, url: opt.tarefaUrl ? opt.tarefaUrl.replace('{id}', id) : null })),
      issues: [...new Set([...refsIssue(txtTudo), ...commits.flatMap(c => c.issues)])],
      publico: PUBLICO.has(p.tipo),
      commits: commits.map(({ tarefas: _t, issues: _i, ...c }) => c),
    })
  }
  resultado.push(r)
}

// ---------- contagens ----------
const porTipo = {}, porRepo = {}
let totalEntregas = 0, totalCommits = 0
for (const r of resultado) {
  porRepo[r.repo] = { entregas: r.entregas.length, prs: r.entregas.filter(e => e.pr).length, commits: r.entregas.reduce((n, e) => n + Math.max(1, e.commits.length), 0), porTipo: {} }
  for (const e of r.entregas) {
    porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1
    porRepo[r.repo].porTipo[e.tipo] = (porRepo[r.repo].porTipo[e.tipo] || 0) + 1
  }
  totalEntregas += porRepo[r.repo].entregas; totalCommits += porRepo[r.repo].commits
}
const comAlgo = resultado.filter(r => r.entregas.length)

const json = {
  geradoEm: new Date().toISOString(), periodo: { desde: opt.desde, ate: opt.ate, modo: modoTag ? 'tag' : 'data', ramo: opt.ramo },
  totais: { entregas: totalEntregas, commits: totalCommits, publicas: resultado.reduce((n, r) => n + r.entregas.filter(e => e.publico).length, 0), repos: comAlgo.length, reposLidos: resultado.length },
  porTipo, porRepo, avisos: [...avisos, ...resultado.flatMap(r => r.avisos.map(a => `${r.repo}: ${a}`))], repos: comAlgo,
}

// ---------- markdown cru ----------
const L = []
const tiposUsados = ORDEM.filter(t => porTipo[t])
L.push(`# Changelog cru — ${opt.desde} → ${opt.ate} (${REF})`, '')
L.push(`> Gerado por \`coletar.mjs\` da skill changelog em ${json.geradoEm.slice(0, 16).replace('T', ' ')} UTC. **Rascunho bruto**: o Claude reescreve em "Time" e "Clientes/usuários".`)
L.push(`> ${totalEntregas} entregas (PR ou commit direto) · ${totalCommits} commits · ${json.totais.publicas} candidatas ao bloco Clientes (feat/fix/perf) · ${comAlgo.length} de ${resultado.length} repos com movimento.`, '')
if (tiposUsados.length) {
  L.push('| Repo | Entregas | ' + tiposUsados.join(' | ') + ' |')
  L.push('|---|---|' + tiposUsados.map(() => '---').join('|') + '|')
  for (const r of comAlgo) L.push(`| ${r.repo} | ${porRepo[r.repo].entregas} | ` + tiposUsados.map(t => porRepo[r.repo].porTipo[t] || '').join(' | ') + ' |')
  L.push('')
}
for (const r of comAlgo) {
  L.push(`## \`${r.repo}\``, '')
  for (const t of ORDEM) {
    const es = r.entregas.filter(e => e.tipo === t)
    if (!es.length) continue
    L.push(`### ${ROTULO[t]} (${t})`, '')
    for (const e of es) {
      const pr = e.pr ? (e.pr.url ? `[#${e.pr.numero}](${e.pr.url})` : `#${e.pr.numero}`) : `\`${e.sha}\``
      const tf = e.tarefas.map(x => x.url ? `[${x.id}](${x.url})` : x.id).join(' ')
      const is = e.issues.join(' ')
      L.push(`- ${e.escopo ? `**${e.escopo}**: ` : ''}${e.quebra ? '⚠️ BREAKING ' : ''}${e.titulo} — ${pr} · ${e.data}${tf ? ' · ' + tf : ''}${is ? ' · ' + is : ''}${e.commits.length > 1 ? ` · ${e.commits.length} commits` : ''}`)
    }
    L.push('')
  }
}
if (json.avisos.length) { L.push('## Avisos da coleta', ''); for (const a of json.avisos) L.push(`- ${a}`); L.push('') }
const md = limpar(L.join('\n')) // passada final: nada da lista sensível sai do script

mkdirSync(SAIDA, { recursive: true })
const p2 = n => String(n).padStart(2, '0')
const carimbo = `${opt.ate}_${p2(hoje.getHours())}${p2(hoje.getMinutes())}`
let base = join(SAIDA, carimbo), k = 1
while (existsSync(base + '.md')) base = join(SAIDA, `${carimbo}-${++k}`)
writeFileSync(base + '.md', md)
const jsonTxt = limpar(JSON.stringify(json, null, 2))
writeFileSync(base + '.json', jsonTxt)

if (opt.soJson) { console.log(jsonTxt); process.exit(0) }
if (!opt.quieto) {
  console.log(`período ${opt.desde} → ${opt.ate} (${REF}) · ${totalEntregas} entregas · ${totalCommits} commits · ${json.totais.publicas} públicas`)
  if (tiposUsados.length) console.log('por tipo: ' + tiposUsados.map(t => `${t} ${porTipo[t]}`).join(' · '))
  for (const r of comAlgo) console.log(limpar(`  ${r.repo.padEnd(22)} ${String(porRepo[r.repo].entregas).padStart(3)} entregas (${porRepo[r.repo].prs} PR) · ` + Object.entries(porRepo[r.repo].porTipo).map(([t, n]) => `${t} ${n}`).join(' · ')))
  if (json.avisos.length) console.log(limpar('avisos: ' + json.avisos.join(' | ')))
  console.log(`md:   ${base}.md\njson: ${base}.json`)
}
