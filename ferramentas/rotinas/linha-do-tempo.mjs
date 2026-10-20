#!/usr/bin/env node
// Linha do tempo das sessões do Claude, lida direto dos transcripts (~/.claude/projects/*/<id>.jsonl).
// Não depende de hook: funciona para trás. O hook (hook-linha-do-tempo.mjs) só acrescenta o motivo do fim.
// Sem IA, só leitura fora de estado/.
// Uso: node linha-do-tempo.mjs              → linha do tempo de hoje (grava estado/linha-do-tempo.json)
//      node linha-do-tempo.mjs 2026-10-19   → de outro dia (não grava estado)
//      node linha-do-tempo.mjs --ultimas 5  → últimas 5 sessões com o comando de retomar
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOME, ROT, sh, gravarEstado, listar, limpar, dia } from './comum.mjs'

process.env.GIT_OPTIONAL_LOCKS = '0'
const PROJ = join(HOME, '.claude/projects')
export const LDT = join(ROT, 'linha-do-tempo')

function pedaco(arq, inicio, n) {
  const buf = Buffer.alloc(n), fd = openSync(arq, 'r')
  try { readSync(fd, buf, 0, n, inicio) } finally { closeSync(fd) }
  return buf.toString('utf8')
}
const linhasJson = txt => txt.split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

function textoAssistente(j) {
  const c = j?.message?.content
  if (!Array.isArray(c)) return ''
  return c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim()
}
function textoUsuario(j) {
  if (j.type !== 'user' || j.toolUseResult || j.isMeta) return ''
  const c = j.message?.content
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  return /^</.test(t.trim()) ? '' : t.trim()
}

// "Próximos: 1) … · 2) …" (mod proximos-passos) vence "**Próximo:** …" do Resumo.
export function extrairProximo(txt) {
  if (!txt) return ''
  const linhas = txt.split('\n').map(l => l.trim()).filter(Boolean)
  const a = [...linhas].reverse().find(l => /^`?Próximos:/i.test(l))
  if (a) return a.replace(/`/g, '').replace(/^Próximos:\s*/i, '').split(/\s·\s/)[0].replace(/^1\)\s*/, '').trim()
  const b = [...linhas].reverse().find(l => /^(?:\d\.\s*|[-*]\s*)?\*\*Próximo:?\*\*:?/i.test(l))
  return b ? b.replace(/^(?:\d\.\s*|[-*]\s*)?\*\*Próximo:?\*\*:?\s*/i, '').trim() : ''
}

// Lê uma sessão: início/fim, pastas, branch, título, último pedido, última resposta e o próximo passo.
export function lerSessao(arq, cauda = 4 << 20, cabeca = 256 << 10) {
  const st = statSync(arq)
  const cab = linhasJson(pedaco(arq, 0, Math.min(st.size, cabeca)))
  const n = Math.min(st.size, cauda)
  const fim = linhasJson(pedaco(arq, st.size - n, n))
  const comTs = cab.filter(j => j.timestamp && j.cwd)
  if (!comTs.length) return null
  const ini = comTs[0]
  let ult = null, resposta = '', titulo = '', pedido = '', branch = ini.gitBranch || '', cwd = ini.cwd, ultTs = ini.timestamp, entrada = ini.entrypoint || ''
  for (const j of fim) {
    if (j.timestamp && j.cwd) { ult = j; cwd = j.cwd; ultTs = j.timestamp; if (j.gitBranch) branch = j.gitBranch }
    if (j.type === 'assistant' && !j.isSidechain) { const t = textoAssistente(j); if (t) resposta = t }
    if (j.type === 'custom-title') titulo = j.customTitle || titulo
    else if (j.type === 'ai-title' && !/custom/.test(titulo)) titulo = titulo || j.aiTitle
    const u = textoUsuario(j); if (u) pedido = u
  }
  // custom-title vence ai-title: segunda passada só para ele
  for (const j of fim) if (j.type === 'custom-title' && j.customTitle) titulo = j.customTitle
  if (!titulo) for (const j of fim) if (j.type === 'ai-title' && j.aiTitle) titulo = j.aiTitle
  if (!pedido) for (const j of cab) { const u = textoUsuario(j); if (u) { pedido = u; break } }
  if (!resposta && !pedido) return null
  return {
    id: basename(arq, '.jsonl'),
    inicio: ini.timestamp, fim: ultTs,
    pastaInicio: ini.cwd, pasta: cwd, branch: branch === 'HEAD' ? '' : branch,
    titulo: titulo || '', pedido: pedido.replace(/\s+/g, ' ').slice(0, 160),
    proximo: extrairProximo(resposta).slice(0, 200),
    headless: /sdk|print/i.test(entrada),
  }
}

// Transcripts principais (não os de subagente, que ficam em <id>/subagents/) mexidos depois de `desdeMs`.
function transcripts(desdeMs) {
  const out = []
  for (const p of listar(PROJ)) {
    let fs; try { fs = readdirSync(join(PROJ, p)) } catch { continue }
    for (const f of fs) {
      if (!f.endsWith('.jsonl')) continue
      const arq = join(PROJ, p, f)
      let m; try { m = statSync(arq).mtimeMs } catch { continue }
      if (m >= desdeMs) out.push({ arq, m })
    }
  }
  return out.sort((a, b) => b.m - a.m)
}

// Sessões vivas (pid de pé) e nomes: ~/.claude/sessions/<pid>.json
export function registroSessoes() {
  const d = join(HOME, '.claude/sessions'), nomes = {}, vivas = new Set()
  for (const f of listar(d).filter(f => f.endsWith('.json'))) {
    try {
      const s = JSON.parse(readFileSync(join(d, f), 'utf8'))
      if (!s.sessionId) continue
      if (s.name) nomes[s.sessionId] = s.name
      try { process.kill(s.pid, 0); vivas.add(s.sessionId) } catch {}
    } catch {}
  }
  return { nomes, vivas }
}

// Motivo do fim gravado pelo hook SessionEnd (linha-do-tempo/AAAA-MM-DD.jsonl).
function fimsDoHook(dias) {
  const m = {}
  for (const d of dias) {
    const f = join(LDT, `${d}.jsonl`)
    if (!existsSync(f)) continue
    for (const j of linhasJson(readFileSync(f, 'utf8'))) if (j.sessao) m[j.sessao] = j
  }
  return m
}

// Commits das branches locais (sem remotos), lidos UMA vez por repo e filtrados por janela de cada sessão.
const _raiz = new Map(), _log = new Map()
function raizDe(pasta) {
  if (!_raiz.has(pasta)) { const r = sh('git', ['-C', pasta, 'rev-parse', '--show-toplevel'], { timeout: 5000 }); _raiz.set(pasta, r.ok ? r.out : null) }
  return _raiz.get(pasta)
}
function commits(pasta, desde, ate) {
  const raiz = raizDe(pasta)
  if (!raiz) return { repo: null, lista: [] }
  if (!_log.has(raiz)) {
    const r = sh('git', ['-C', raiz, 'log', '--branches', '--since=15 days ago', '--format=%h%x00%cI%x00%s'], { timeout: 15000 })
    _log.set(raiz, r.out ? r.out.split('\n').map(l => { const [sha, quando, msg] = l.split('\0'); return { sha, t: Date.parse(quando), msg } }) : [])
  }
  const a = Date.parse(desde), b = Date.parse(ate)
  return { repo: basename(raiz), lista: _log.get(raiz).filter(c => c.t >= a && c.t <= b).map(c => ({ sha: c.sha, msg: limpar(c.msg) })) }
}

const resumir = (s, { nomes, vivas }, hook) => {
  const c = commits(s.pasta, s.inicio, new Date(Date.parse(s.fim) + 60000).toISOString())
  const h = hook[s.id]
  return {
    ...s,
    titulo: limpar(s.titulo), pedido: limpar(s.pedido), proximo: limpar(s.proximo),
    nome: limpar(nomes[s.id] || ''), viva: vivas.has(s.id),
    repo: c.repo, commits: c.lista.slice(0, 8), totalCommits: c.lista.length,
    motivoFim: h?.motivo || null,
    retomar: `cd ${s.pastaInicio.replace(HOME, '~')} && claude --resume ${s.id}`,
  }
}

export function sessoesDoDia(d) {
  const ini = new Date(d + 'T00:00:00').getTime(), fim = ini + 86400000
  const reg = registroSessoes(), hook = fimsDoHook([d])
  return transcripts(ini).map(t => lerSessao(t.arq)).filter(s => s && !s.headless && Date.parse(s.fim) >= ini && Date.parse(s.inicio) < fim)
    .sort((a, b) => a.inicio.localeCompare(b.inicio)).map(s => resumir(s, reg, hook))
}

export function ultimasSessoes(n = 5, ignorar = null) {
  const reg = registroSessoes()
  const hoje = new Date(), ontem = new Date(Date.now() - 86400000)
  const hook = fimsDoHook([dia(hoje), dia(ontem)])
  const out = []
  for (const t of transcripts(Date.now() - 14 * 86400000)) {
    if (out.length >= n) break
    if (ignorar && basename(t.arq, '.jsonl') === ignorar) continue
    const s = lerSessao(t.arq)
    if (s && !s.headless) out.push(resumir(s, reg, hook))
  }
  return out
}

const hhmm = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const hora = (iso, d) => (d && dia(new Date(iso)) !== d ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' : '') + hhmm(iso)
export const rotulo = s => s.titulo || s.nome || s.pedido.slice(0, 60) || s.id.slice(0, 8)

// Markdown da linha do tempo (usado no fechamento e no diário).
export function linhaDoTempoMd(lista, { mascarar = x => x, d = null } = {}) {
  if (!lista.length) return 'Nenhuma sessão do Claude no dia.\n'
  let md = '| Hora | Sessão | Repo | Saiu | Próximo |\n|---|---|---|---|---|\n'
  const cel = t => mascarar(String(t || '')).replace(/\|/g, '/').replace(/\n/g, ' ')
  for (const s of lista) {
    const saiu = s.totalCommits ? `${s.totalCommits} commit(s): ${s.commits.slice(0, 2).map(c => c.msg.slice(0, 50)).join('; ')}` : '—'
    md += `| ${hora(s.inicio, d)}–${hora(s.fim, d)} | ${cel(rotulo(s)).slice(0, 70)} | ${s.repo || '—'} | ${cel(saiu)} | ${cel(s.proximo).slice(0, 90) || '—'} |\n`
  }
  return md
}

// --- CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2)
  if (a[0] === '--ultimas') {
    const ls = ultimasSessoes(Number(a[1]) || 5)
    for (const s of ls) {
      console.log(`\n■ ${rotulo(s)}${s.viva ? '  [viva]' : ''}  · ${s.repo || s.pasta.replace(HOME, '~')} [${s.branch || '?'}]  · ${hhmm(s.fim)} ${dia(new Date(s.fim))}`)
      if (s.proximo) console.log(`  próximo  ${s.proximo}`)
      else if (s.pedido) console.log(`  pedido   ${s.pedido.slice(0, 100)}`)
      console.log(`  retomar  ${s.retomar}`)
    }
  } else {
    const d = a[0] || dia(new Date())
    const ls = sessoesDoDia(d)
    if (!a[0]) gravarEstado('linha-do-tempo', { ok: true, resumo: `${ls.length} sessão(ões) hoje`, itens: ls })
    for (const s of ls) console.log(`${hora(s.inicio, d)}–${hora(s.fim, d)}  ${rotulo(s).slice(0, 60)}  · ${s.repo || '—'}  · ${s.totalCommits} commit(s)${s.proximo ? `  → ${s.proximo.slice(0, 80)}` : ''}`)
    if (!ls.length) console.log(`Nenhuma sessão em ${d}.`)
  }
}
