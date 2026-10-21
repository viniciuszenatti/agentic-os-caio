#!/usr/bin/env node
// Coletor do painel "Escritório" (mod painel-escritorio do Claude Code) e do /api/retrato da Central.
// Lê só arquivos locais e imprime um JSON: sessões vivas, relatórios, artefatos, rotinas e notas.
// Não escreve nada em lugar nenhum.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { pidVivo, pastaScratch, recursos } from './central/plataforma.mjs'

const HOME = homedir()
const SESSOES = join(HOME, '.claude/sessions')
const AQUI = dirname(fileURLToPath(import.meta.url))
// Pasta de notas em markdown (opcional): NOTAS_DIR ou ~/Notas. Sem pasta, "notas" sai null.
const NOTAS = process.env.NOTAS_DIR || join(HOME, 'Notas')
const PROJETOS = join(HOME, '.claude/projects')
const RELATORIOS = join(HOME, '.claude/doc-de-sessao')
const LIMITE_TRANSCRIPT = 24 * 1024 * 1024
const DIA = 86_400_000
const agora = Date.now()

// Linux: /proc/<pid>; Windows/macOS: process.kill(pid, 0)
function vivo(pid) {
  return pidVivo(pid)
}

function sessoes() {
  if (!existsSync(SESSOES)) return []
  const lista = []
  for (const f of readdirSync(SESSOES)) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(SESSOES, f), 'utf8'))
      if (!s.pid || !vivo(s.pid)) continue
      lista.push({
        nome: s.name ?? String(s.pid),
        sessionId: s.sessionId,
        pasta: (s.cwd ?? '').replace(HOME, '~'),
        status: s.status ?? '?',
        desdeMin: Math.round((agora - (s.statusUpdatedAt ?? s.updatedAt ?? agora)) / 60_000),
        ...daConversa(arquivoDaSessao(s.cwd ?? '', s.sessionId), s.status ?? '?'),
      })
    } catch {}
  }
  return lista.sort((a, b) => (a.status === 'busy' ? -1 : 1) - (b.status === 'busy' ? -1 : 1) || a.desdeMin - b.desdeMin)
}

function arquivoDaSessao(cwd, sessionId) {
  return join(PROJETOS, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
}

function lerFim(arq) {
  const tam = statSync(arq).size
  if (tam <= LIMITE_TRANSCRIPT) return readFileSync(arq, 'utf8')
  return readFileSync(arq).subarray(tam - LIMITE_TRANSCRIPT).toString('utf8')
}

function umaLinha(texto, max = 140) {
  const linha = String(texto ?? '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('```')) ?? ''
  return linha.length > max ? `${linha.slice(0, max - 1)}…` : linha
}

// Últimas mensagens de verdade (usuário e assistente), do fim para o começo.
function ultimasMensagens(texto, quantas = 60) {
  const linhas = texto.split('\n')
  const msgs = []
  for (let i = linhas.length - 1; i >= 0 && msgs.length < quantas; i--) {
    const l = linhas[i]
    if (!l.startsWith('{') || !(l.includes('"type":"assistant"') || l.includes('"type":"user"'))) continue
    try {
      const d = JSON.parse(l)
      if ((d.type === 'assistant' || d.type === 'user') && !d.isSidechain && d.message) msgs.push(d)
    } catch {}
  }
  return msgs
}

function blocos(d) {
  const c = d.message?.content
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : []
}

function oQueAFerramentaPede(b) {
  const i = b.input ?? {}
  if (b.name === 'AskUserQuestion') return umaLinha(i.questions?.[0]?.question ?? 'pergunta')
  return umaLinha(`${b.name}: ${i.description ?? i.command ?? i.file_path ?? i.url ?? ''}`)
}

// Lê o fim do transcript: a última fala do assistente e se a sessão está
// esperando você (pergunta, permissão de ferramenta ou texto que termina em "?").
function situacao(msgs, status) {
  let ultimaFala = null
  for (const d of msgs) {
    if (d.type !== 'assistant') continue
    const t = blocos(d).filter(b => b.type === 'text' && b.text?.trim()).pop()
    if (t) { ultimaFala = umaLinha(t.text); break }
  }
  const respondidas = new Set()
  for (const d of msgs) {
    if (d.type === 'user') for (const b of blocos(d)) if (b.type === 'tool_result') respondidas.add(b.tool_use_id)
  }
  const ultima = msgs[0]
  let espera = null
  if (ultima?.type === 'assistant' && status !== 'busy') {
    const bs = blocos(ultima)
    const pendente = bs.find(b => b.type === 'tool_use' && !respondidas.has(b.id))
    const ultimoTexto = bs.filter(b => b.type === 'text' && b.text?.trim()).pop()?.text?.trim()
    if (pendente?.name === 'AskUserQuestion') espera = { tipo: 'pergunta', texto: oQueAFerramentaPede(pendente) }
    else if (pendente) espera = { tipo: 'permissao', texto: oQueAFerramentaPede(pendente) }
    else if (ultimoTexto?.endsWith('?')) {
      const frase = ultimoTexto.split('\n').filter(Boolean).pop()
      espera = { tipo: 'pergunta', texto: umaLinha(frase) }
    }
  }
  return { ultimaFala, espera }
}

// Lê o transcript da sessão: último título dado pela IA, último relatório
// doc-de-sessao que ela escreveu (Write/Edit em ~/.claude/doc-de-sessao/*.md),
// última fala e se está esperando você.
function daConversa(arq, status) {
  const vazio = { titulo: null, relatorio: null, ultimaFala: null, espera: null }
  if (!existsSync(arq)) return vazio
  let texto
  try { texto = lerFim(arq) } catch { return vazio }
  let titulo = null
  for (const m of texto.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)) titulo = m[1]
  let relatorio = null
  for (const m of texto.matchAll(/"file_path":"[^"]*\/\.claude\/doc-de-sessao\/([^"\/]+\.md)"/g)) relatorio = m[1]
  try { if (titulo) titulo = JSON.parse(`"${titulo}"`) } catch {}
  return { titulo, relatorio: relatorio ? lerRelatorio(relatorio) : null, ...situacao(ultimasMensagens(texto), status) }
}

const ESTADOS = [
  ['✅', 'feito'], ['🔄', 'fazendo'], ['⛔', 'bloqueado'], ['❌', 'falhou'], ['⬜', 'falta'],
]

// Lê um relatório no molde da skill doc-de-sessao: título, briefing e tabela-checklist.
function lerRelatorio(nome) {
  const arq = join(RELATORIOS, nome)
  if (!existsSync(arq)) return null
  try {
    const texto = readFileSync(arq, 'utf8')
    const titulo = texto.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? nome
    const briefing = texto.match(/\*\*Briefing\.\*\*\s*([^\n]+)/)?.[1]?.split(/(?<=\.)\s/)[0] ?? null
    const itens = []
    for (const linha of texto.split('\n')) {
      const m = linha.match(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/)
      if (!m) continue
      const achado = ESTADOS.find(([icone, palavra]) => m[3].startsWith(icone) || m[3].toLowerCase().includes(palavra))
      if (!achado) continue
      const motivo = m[3].includes(':') ? m[3].slice(m[3].indexOf(':') + 1).trim() : null
      itens.push({ n: Number(m[1]), item: m[2], estado: achado[1], motivo })
    }
    return {
      arquivo: nome,
      titulo,
      briefing,
      itens,
      mtimeMin: Math.round((agora - statSync(arq).mtimeMs) / 60_000),
    }
  } catch { return null }
}

// Relatórios mexidos nos últimos 3 dias (inclusive os de sessões já fechadas).
function relatorios() {
  if (!existsSync(RELATORIOS)) return []
  const lista = []
  for (const f of readdirSync(RELATORIOS)) {
    if (!f.endsWith('.md')) continue
    try { if (agora - statSync(join(RELATORIOS, f)).mtimeMs > 3 * DIA) continue } catch { continue }
    const r = lerRelatorio(f)
    if (r && r.itens.length) lista.push(r)
  }
  return lista.sort((a, b) => a.mtimeMin - b.mtimeMin)
}

function notas() {
  if (!existsSync(NOTAS)) return null
  const notas = []
  const andar = (dir, prof) => {
    if (prof > 4) return
    let itens
    try { itens = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of itens) {
      if (it.name.startsWith('.')) continue
      const p = join(dir, it.name)
      if (it.isDirectory()) andar(p, prof + 1)
      else if (it.name.endsWith('.md')) {
        try { notas.push({ nota: relative(NOTAS, p).split(sep).join('/').replace(/\.md$/, ''), mtime: statSync(p).mtimeMs }) } catch {}
      }
    }
  }
  andar(NOTAS, 0)
  notas.sort((a, b) => b.mtime - a.mtime)
  return {
    total: notas.length,
    semana: notas.filter(n => agora - n.mtime < 7 * DIA).length,
    recentes: notas.slice(0, 5).map(n => ({ nota: n.nota, dias: Math.floor((agora - n.mtime) / DIA) })),
  }
}

// Saúde dos ambientes e resumo do contexto: lidos dos JSON que os timers gravam (saude.mjs, auditoria-contexto.mjs).
function lerJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
function saude() { return lerJson(join(HOME, '.claude/limpeza/saude.json')) }
function contexto() {
  const c = lerJson(join(HOME, '.claude/limpeza/contexto.json'))
  return c ? { em: c.em, resumo: c.resumo, tokensPorSessao: c.tokensPorSessao } : null
}

// Rotinas agendadas: timers do systemd de usuário definidos em
// ~/.config/systemd/user, com próximo disparo e resultado da última execução. Só leitura.
function rotinas() {
  if (!recursos().rotinasSystemd) return null // sem systemd (Windows/macOS): o cartão mostra "sem rotinas"
  const dir = join(HOME, '.config/systemd/user')
  let timers
  try {
    timers = JSON.parse(execFileSync('systemctl', ['--user', 'list-timers', '--all', '-o', 'json', '--no-pager'], { encoding: 'utf8', timeout: 5000 }))
  } catch { return null }
  return timers
    .filter(t => existsSync(join(dir, t.unit)))
    .map(t => {
      let resultado = '?'
      try {
        const out = execFileSync('systemctl', ['--user', 'show', t.activates, '-p', 'Result', '-p', 'ExecMainStatus', '--no-pager'], { encoding: 'utf8', timeout: 3000 })
        const r = out.match(/Result=(\S+)/)?.[1]
        const st = out.match(/ExecMainStatus=(\d+)/)?.[1]
        resultado = !t.last ? 'nunca rodou' : r === 'success' && st === '0' ? 'ok' : `falhou (${r}, saída ${st})`
      } catch {}
      return {
        nome: t.unit.replace(/\.timer$/, ''),
        proximo: t.next ? Math.floor(t.next / 1000) : null,
        ultimo: t.last ? Math.floor(t.last / 1000) : null,
        resultado,
      }
    })
}

// Artefatos que os agentes fizeram nos últimos 3 dias:
// scratchpads das sessões, relatórios da /limpeza e o segundo cérebro. Só lista, não abre.
const SCRATCH = pastaScratch()
const EXT_ARTEFATO = /\.(html|md|pdf|png|pptx|docx|xlsx|svg|gif|mp4)$/i
function artefatos() {
  const achados = []
  const andar = (dir, prof, origem) => {
    if (prof > 5) return
    let itens
    try { itens = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of itens) {
      if (it.name.startsWith('.') || it.name === 'node_modules') continue
      const p = join(dir, it.name)
      if (it.isDirectory()) andar(p, prof + 1, origem)
      else if (EXT_ARTEFATO.test(it.name)) {
        try {
          const m = statSync(p).mtimeMs
          if (agora - m < 3 * DIA) achados.push({ caminho: p, nome: it.name, origem, mtime: m })
        } catch {}
      }
    }
  }
  try {
    for (const proj of readdirSync(SCRATCH)) {
      let sess
      try { sess = readdirSync(join(SCRATCH, proj)) } catch { continue }
      for (const s of sess) andar(join(SCRATCH, proj, s, 'scratchpad'), 0, 'scratchpad')
    }
  } catch {}
  andar(join(HOME, '.claude/limpeza'), 0, 'limpeza')
  andar(join(AQUI, 'cerebro'), 0, 'cérebro')
  andar(join(HOME, '.claude/deck'), 0, 'deck')
  andar(join(HOME, '.claude/artefatos'), 0, 'guardado')
  achados.sort((a, b) => b.mtime - a.mtime)
  // Da limpeza, só o relatório mais novo — senão ele toma a lista inteira.
  let viuLimpeza = false
  const uteis = achados.filter(a => {
    if (!a.caminho.split(sep).join('/').includes('/limpeza/relatorios/')) return true
    if (viuLimpeza) return false
    return (viuLimpeza = true)
  })
  return {
    total: uteis.length,
    itens: uteis.slice(0, 8).map(a => ({ caminho: a.caminho, nome: a.nome, origem: a.origem, horas: Math.floor((agora - a.mtime) / 3_600_000) })),
  }
}

const hora = ms => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function placar(rel) {
  if (!rel.itens.length) return []
  const feitos = rel.itens.filter(i => i.estado === 'feito').length
  const travados = rel.itens.filter(i => i.estado === 'bloqueado' || i.estado === 'falhou')
  const linhas = [`  ${feitos}/${rel.itens.length} feitos`]
  for (const i of travados) linhas.push(`  ${i.estado === 'bloqueado' ? '⛔' : '❌'} ${i.item}${i.motivo ? `: ${i.motivo}` : ''}`)
  return linhas
}

// Resumo do dia de todas as sessões com atividade hoje, pronto para colar num chat.
function standup() {
  const meiaNoite = new Date(agora).setHours(0, 0, 0, 0)
  const doDia = []
  const relatoriosLigados = new Set()
  let pastasProj = []
  try { pastasProj = readdirSync(PROJETOS, { withFileTypes: true }) } catch {}
  for (const pasta of pastasProj) {
    if (!pasta.isDirectory()) continue
    const dir = join(PROJETOS, pasta.name)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const arq = join(dir, f)
      let st
      try { st = statSync(arq) } catch { continue }
      if (st.mtimeMs < meiaNoite || st.size < 4096) continue
      let texto
      try { texto = lerFim(arq) } catch { continue }
      // o cwd vem escapado em JSON (no Windows, "C:\\\\Users\\\\voce")
      const cwdBruto = texto.match(/"cwd":"((?:[^"\\]|\\.)+)"/)?.[1] ?? ''
      let cwd = cwdBruto
      try { cwd = JSON.parse(`"${cwdBruto}"`) } catch {}
      const msgs = ultimasMensagens(texto, 100_000)
      const pedidos = msgs.filter(d => d.type === 'user' && blocos(d).some(b => b.type === 'text' && !b.text.startsWith('<')))
      const { titulo, relatorio } = daConversa(arq, 'idle')
      if (!titulo && !relatorio && pedidos.length < 2) continue
      const inicio = Date.parse(msgs[msgs.length - 1]?.timestamp ?? '') || st.birthtimeMs
      const ramos = [...texto.matchAll(/"gitBranch":"([^"]+)"/g)].map(m => m[1]).filter(b => b !== 'HEAD')
      if (relatorio) relatoriosLigados.add(relatorio.arquivo)
      doDia.push({
        titulo: titulo ?? umaLinha(blocos(pedidos[pedidos.length - 1] ?? {}).find(b => b.type === 'text')?.text, 60),
        pasta: cwd.replace(HOME, '~'),
        inicio,
        fim: st.mtimeMs,
        branch: ramos.pop() ?? null,
        relatorio,
      })
    }
  }
  doDia.sort((a, b) => a.inicio - b.inicio)
  const data = new Date(agora).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  const linhas = [`*Resumo de hoje — ${data}*`, `${doDia.length} sessões`, '']
  for (const s of doDia) {
    const comeco = s.inicio < meiaNoite ? 'desde ontem' : hora(s.inicio)
    linhas.push(`• *${s.titulo}* (${s.pasta} · ${comeco} até ${hora(s.fim)})`)
    if (s.branch) linhas.push(`  branch ${s.branch}`)
    if (s.relatorio) linhas.push(...placar(s.relatorio))
  }
  const soltos = relatorios().filter(r => !relatoriosLigados.has(r.arquivo) && r.mtimeMin < (agora - meiaNoite) / 60_000)
  if (soltos.length) {
    linhas.push('', '*Relatórios mexidos hoje*')
    for (const r of soltos) linhas.push(`• *${r.titulo}*`, ...placar(r))
  }
  return linhas.join('\n')
}

if (process.argv.includes('--standup')) process.stdout.write(standup())
else process.stdout.write(JSON.stringify({ em: agora, sessoes: sessoes(), relatorios: relatorios(), artefatos: artefatos(), rotinas: rotinas(), saude: saude(), contexto: contexto(), notas: notas() }))
