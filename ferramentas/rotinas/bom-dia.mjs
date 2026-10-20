#!/usr/bin/env node
// Bom dia: lê o último fechamento (~/.claude/rotinas/fechamentos/AAAA-MM-DD.json) e avisa o que ficou
// aberto/bloqueado. Roda ao entrar na sessão gráfica e seg–sex 8:30; só avisa 1x por dia (--forcar ignora).
// Só leitura fora de estado/bom-dia.json.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROT, lerEstado, gravarEstado, notificarUmaVez, listar, limpar } from './comum.mjs'

const ROTINA = 'bom-dia'
const dia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const HOJE = dia(new Date())
const FORCAR = process.argv.includes('--forcar')

const ant = lerEstado(ROTINA)
if (!FORCAR && ant?.em && dia(new Date(ant.em)) === HOJE) { console.log(`já avisou hoje (${ant.em}); nada a fazer`); process.exit(0) }

const DIR = join(ROT, 'fechamentos')
const ult = listar(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop()
if (!ult) { gravarEstado(ROTINA, { ok: true, resumo: 'nenhum fechamento encontrado', itens: [], abertos: [], bloqueados: [], fechamento: null }); console.log('nenhum fechamento'); process.exit(0) }

const fe = JSON.parse(readFileSync(join(DIR, ult), 'utf8'))
const curto = s => { s = limpar(String(s || '').replace(/\*\*|`/g, '').trim()); return s.length > 45 ? s.slice(0, 44) + '…' : s }
const pega = classe => fe.frentes.flatMap(f => f.itens.filter(i => i.classe === classe).map(i => ({ frente: limpar(f.titulo), n: i.n, item: limpar(i.item), estado: limpar(i.estado) })))
const abertos = pega('aberto'), bloqueados = pega('bloqueado')

const ontem = new Date(); ontem.setDate(ontem.getDate() - 1)
const quando = fe.dia === HOJE ? 'Hoje' : fe.dia === dia(ontem) ? 'Ontem' : `Em ${fe.dia.slice(8, 10)}/${fe.dia.slice(5, 7)}`
const top = [...bloqueados, ...abertos].slice(0, 3)
const titulo = `${quando} ficaram ${abertos.length} abertos e ${bloqueados.length} bloqueados`
const corpo = top.map(i => `${bloqueados.includes(i) ? '[bloqueado] ' : '- '}${curto(i.item)}`).join('\n') + `\nArquivo: ${join(DIR, ult.replace('.json', '.md'))}`

const resumo = `${titulo} (fechamento ${fe.dia})`
gravarEstado(ROTINA, { ok: true, resumo, itens: top, abertos, bloqueados, fechamento: fe.dia })
if (abertos.length || bloqueados.length) notificarUmaVez(`bom-dia:${HOJE}`, 'Bom dia', titulo, corpo, bloqueados.length > 0)
console.log(resumo + '\n' + corpo)
