#!/usr/bin/env node
// Lembrete de commit: em todo repo git da pasta de projetos (~/Projects ou AGENTIC_OS_PROJETOS; repos-mãe, wt-* e bancadas/*), procura alteração
// RASTREADA não commitada cujo arquivo modificado mais antigo tem 24 h ou mais. Só leitura (git status).
// Pula pastas com sessão do Claude aberta. Grava estado/lembrete-commit.json e avisa o total + o mais antigo.
import { readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, PROJETOS, sh, gravarEstado, notificarUmaVez, cwdsComSessaoViva, listar } from './comum.mjs'

process.env.GIT_OPTIONAL_LOCKS = '0' // git status sem regravar o index
const ROTINA = 'lembrete-commit'
const LIMITE_H = 24
const real = p => { try { return realpathSync(p) } catch { return p } }

const pastas = [
  ...listar(PROJETOS).filter(d => d !== 'bancadas').map(d => join(PROJETOS, d)),
  ...listar(join(PROJETOS, 'bancadas')).map(d => join(PROJETOS, 'bancadas', d)),
].filter(p => { try { return statSync(p).isDirectory() && existsSync(join(p, '.git')) } catch { return false } })

const vivas = cwdsComSessaoViva().map(real)
const emUso = p => { const r = real(p); return vivas.some(c => c === r || c.startsWith(r + '/')) }

const agora = Date.now()
const itens = [], pulados = [], erros = []
for (const p of pastas) {
  if (emUso(p)) { pulados.push(p); continue }
  const st = sh('git', ['-C', p, 'status', '--porcelain', '--untracked-files=no'], { timeout: 60000 })
  if (!st.ok) { erros.push(`${p}: ${st.err}`); continue }
  const linhas = st.out.split('\n').filter(Boolean)
  if (!linhas.length) continue
  let maisAntigo = Infinity
  for (const l of linhas) {
    const arq = l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')
    try { maisAntigo = Math.min(maisAntigo, statSync(join(p, arq)).mtimeMs) } catch {} // apagado: sem mtime
  }
  if (maisAntigo === Infinity) continue
  const horasSujo = Math.floor((agora - maisAntigo) / 3600000)
  if (horasSujo < LIMITE_H) continue
  const branch = sh('git', ['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD']).out
  itens.push({ caminho: p, branch, arquivos: linhas.length, horasSujo })
}
itens.sort((a, b) => b.horasSujo - a.horasSujo)

const curto = p => p.replace(HOME, '~')
const dias = h => h >= 48 ? `${Math.floor(h / 24)} dias` : `${h} h`
const resumo = `${itens.length} pasta(s) com alteração rastreada parada há ${LIMITE_H}+ h (de ${pastas.length} repos; ${pulados.length} com sessão aberta puladas)` + (erros.length ? `; ${erros.length} erro(s)` : '')
gravarEstado(ROTINA, { ok: !erros.length, resumo, itens, pulados, erros })
if (itens.length) {
  const v = itens[0]
  notificarUmaVez(`lembrete-commit:${itens.length}:${v.caminho}`, 'Lembrete de commit', `${itens.length} pasta(s) com alteração sem commit há 24+ h`,
    `Mais antiga: ${curto(v.caminho)} (${v.branch}) — ${v.arquivos} arquivo(s), há ${dias(v.horasSujo)}`)
}
console.log(resumo)
for (const i of itens.slice(0, 15)) console.log(`  ${dias(i.horasSujo).padStart(8)}  ${String(i.arquivos).padStart(3)} arq  ${curto(i.caminho)} [${i.branch}]`)
if (itens.length > 15) console.log(`  … e mais ${itens.length - 15}`)
for (const e of erros) console.log('ERRO ' + e)
