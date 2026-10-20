#!/usr/bin/env node
// Fechamento do dia: lê os docs de sessão modificados hoje (opcional: ~/.claude/doc-de-sessao/*.md com uma
// tabela-checklist que tem coluna "Estado") + sessões do Claude, e gera ~/.claude/rotinas/fechamentos/AAAA-MM-DD.md
// (e .json) com placar por frente e a linha do tempo do dia. Só leitura fora do próprio diretório. Sem IA.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { HOME, ROT, gravarEstado, notificar, listar } from './comum.mjs'
import { sessoesDoDia, linhaDoTempoMd } from './linha-do-tempo.mjs'

const ROTINA = 'fechamento-do-dia'
const hoje = new Date()
const dia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const HOJE = process.argv[2] || dia(hoje)  // aceita data para reprocessar: node fechamento-do-dia.mjs 2026-10-18

function classificar(estado) {
  const e = estado.trim()
  if (/^⏭|trocad|descartad|cancelad/i.test(e)) return 'descartado'
  if (/^(🚫|⛔|🔒|🛑|❌)|bloque|barrad|falhou/i.test(e)) return 'bloqueado'
  if (/^✅|^feito|^ok\b|^concluíd/i.test(e)) return 'feito'
  if (!e) return 'aberto'
  return 'aberto'
}

// --- docs de sessão modificados no dia
const DOCS = join(HOME, '.claude/doc-de-sessao')
const frentes = []
for (const f of listar(DOCS).filter(f => f.endsWith('.md'))) {
  const p = join(DOCS, f)
  const st = statSync(p)
  if (dia(st.mtime) !== HOJE) continue
  const txt = readFileSync(p, 'utf8')
  const titulo = (txt.match(/^##?\s+(.+)$/m)?.[1] || basename(f, '.md')).trim()
  // Tabelas-checklist: cabeçalho com uma coluna "Estado"; 1ª coluna = id (1, 2, F1…), 2ª = item.
  const itens = []
  let col = -1
  for (const linha of txt.split('\n')) {
    if (!linha.startsWith('|')) { col = -1; continue }
    const cel = linha.split('|').slice(1, -1).map(c => c.trim())
    if (cel.every(c => /^:?-+:?$/.test(c))) continue
    const iEstado = cel.findIndex(c => /^estado$/i.test(c))
    if (iEstado > 0 && /^(#|id|n)$/i.test(cel[0])) { col = iEstado; continue }
    if (col < 0 || !/^[A-Za-z]{0,2}\d+[a-z]?$/.test(cel[0])) continue
    const estado = cel[col] || ''
    itens.push({ n: cel[0], item: cel[1], estado, classe: classificar(estado) })
  }
  const c = k => itens.filter(i => i.classe === k).length
  frentes.push({ arquivo: p, titulo, modificado: st.mtime.toISOString(), feitos: c('feito'), abertos: c('aberto'), bloqueados: c('bloqueado'), descartados: c('descartado'), itens })
}

// --- sessões do Claude (registro em ~/.claude/sessions/*.json)
const SESS = join(HOME, '.claude/sessions')
const sessoes = []
for (const f of listar(SESS).filter(f => f.endsWith('.json'))) {
  try {
    const s = JSON.parse(readFileSync(join(SESS, f), 'utf8'))
    const atualizada = new Date(s.updatedAt || s.startedAt || 0)
    if (dia(atualizada) !== HOJE) continue
    let viva = false
    try { process.kill(s.pid, 0); viva = true } catch {}
    sessoes.push({ nome: s.name, cwd: s.cwd, status: s.status, viva, atualizada: atualizada.toISOString() })
  } catch {}
}
sessoes.sort((a, b) => b.atualizada.localeCompare(a.atualizada))

const linha = sessoesDoDia(HOJE)

const tot = k => frentes.reduce((s, f) => s + f[k], 0)
const F = tot('feitos'), A = tot('abertos'), B = tot('bloqueados')

// --- markdown
const hhmm = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
let md = `# Fechamento do dia — ${HOJE}\n\n**${F} feitos · ${A} abertos · ${B} bloqueados** em ${frentes.length} frente(s) · ${sessoes.length} sessão(ões) do Claude mexidas hoje.\n\n`
md += `## Placar por frente\n\n| Frente | Feitos | Abertos | Bloqueados | Doc |\n|---|---|---|---|---|\n`
for (const f of frentes) md += `| ${f.titulo} | ${f.feitos} | ${f.abertos} | ${f.bloqueados} | \`${basename(f.arquivo)}\` |\n`
if (!frentes.length) md += `| (nenhum doc de sessão modificado hoje) | | | | |\n`

md += `\n## Linha do tempo\n\n` + linhaDoTempoMd(linha, { d: HOJE })

md += `\n## Bloqueados e por quê\n\n`
const bloq = frentes.flatMap(f => f.itens.filter(i => i.classe === 'bloqueado').map(i => ({ ...i, frente: f.titulo })))
md += bloq.length ? bloq.map(i => `- **${i.frente}** · #${i.n} ${i.item} — ${i.estado}`).join('\n') + '\n' : 'Nada bloqueado.\n'

md += `\n## Abertos (o que fica para amanhã)\n\n`
for (const f of frentes) {
  const ab = f.itens.filter(i => i.classe === 'aberto')
  if (!ab.length) continue
  md += `**${f.titulo}**\n` + ab.slice(0, 15).map(i => `- #${i.n} ${i.item} — ${i.estado}`).join('\n') + (ab.length > 15 ? `\n- … e mais ${ab.length - 15}` : '') + '\n\n'
}

md += `## Sessões do Claude mexidas hoje\n\n| Sessão | Pasta | Estado | Última atividade |\n|---|---|---|---|\n`
for (const s of sessoes) md += `| ${s.nome} | \`${s.cwd.replace(HOME, '~')}\` | ${s.viva ? s.status : 'encerrada'} | ${hhmm(s.atualizada)} |\n`
md += `\n_Gerado por ~/.claude/rotinas/fechamento-do-dia.mjs (sem IA) em ${new Date().toLocaleString('pt-BR')}._\n`

mkdirSync(join(ROT, 'fechamentos'), { recursive: true })
const arq = join(ROT, 'fechamentos', `${HOJE}.md`)
writeFileSync(arq, md)

// dados estruturados do dia (lidos pelo bom-dia.mjs)
writeFileSync(join(ROT, 'fechamentos', `${HOJE}.json`), JSON.stringify({ dia: HOJE, em: new Date().toISOString(), F, A, B, frentes, sessoes, linha }, null, 1))

const resumo = `${F} feitos, ${A} abertos, ${B} bloqueados em ${frentes.length} frente(s)`
gravarEstado(ROTINA, {
  ok: true, resumo, arquivo: arq,
  itens: frentes.map(({ itens, ...f }) => ({ ...f, bloqueadosDetalhe: itens.filter(i => i.classe === 'bloqueado') })),
  sessoes,
})
if (frentes.length || linha.length) notificar('Fechamento', `Fechamento: ${F} feitos, ${A} abertos, ${B} bloqueados`, `${frentes.length} frente(s), ${linha.length} sessão(ões) hoje. Arquivo: ${arq}`, B > 0)
console.log(`${resumo}\nArquivo: ${arq}`)
