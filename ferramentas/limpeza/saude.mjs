#!/usr/bin/env node
// Saúde dos ambientes: um GET de leitura em cada alvo, em paralelo, timeout 8 s.
// Alvos em ~/.claude/limpeza/alvos.json (formato em alvos.exemplo.json):
//   [{ "ambiente": "DEV", "nome": "Portal", "url": "https://dev.exemplo.com/" }, ...]
// Sem o arquivo, não mede nada e grava saude.json com itens vazios.
// Grava ~/.claude/limpeza/saude.json ({ em, itens: [{ ambiente, nome, url, ok, codigo, ms, estado }] }),
// lido pela Central. Use só URLs de leitura (página inicial, /healthz); evite PROD se não quiser carga lá.
// Aviso de queda: estado anterior em saude-estado.json. Alvo só é dado como "fora" depois de
// 2 medições seguidas falhando (a 2ª é refeita 30 s depois, na mesma execução): evita alarme por rede.
// ok → fora: notifica "DEV Portal fora (502)". fora → ok: "DEV Portal voltou após N min".
// O mesmo aviso não se repete em menos de 30 min.
// Teste sem derrubar nada: --teste [--simular-queda DEV:Portal]
//   --teste usa saude-estado.teste.json, NÃO grava saude.json e encurta a re-medição para 1 s.
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { notificar } from '../rotinas/comum.mjs'

const dir = join(homedir(), '.claude/limpeza')
mkdirSync(dir, { recursive: true })
const ARQ_ALVOS = process.env.SAUDE_ALVOS || join(dir, 'alvos.json')
let ALVOS = []
try {
  if (existsSync(ARQ_ALVOS)) {
    ALVOS = JSON.parse(readFileSync(ARQ_ALVOS, 'utf8'))
      .filter(a => a && typeof a.url === 'string' && /^https?:\/\//.test(a.url))
      .map(a => [String(a.ambiente || 'geral'), String(a.nome || a.url), a.url])
  } else console.error(`(sem ${ARQ_ALVOS}: nada a medir; copie alvos.exemplo.json)`)
} catch (e) { console.error(`alvos.json inválido: ${e.message}`); process.exit(2) }

const args = process.argv.slice(2)
const TESTE = args.includes('--teste')
const iSim = args.indexOf('--simular-queda')
const SIMULAR = iSim >= 0 ? (args[iSim + 1] || '').toLowerCase() : null
if (SIMULAR !== null && !TESTE) { console.error('--simular-queda só vale junto com --teste'); process.exit(2) }

const ARQ_ESTADO = join(dir, TESTE ? 'saude-estado.teste.json' : 'saude-estado.json')
const REPETIR_MS = 30 * 60 * 1000
const ESPERA_REMEDIR = TESTE ? 1000 : 30000

async function medir([ambiente, nome, url]) {
  const t0 = Date.now()
  if (SIMULAR && `${ambiente}:${nome}`.toLowerCase() === SIMULAR) return { ambiente, nome, url, ok: false, codigo: 502, ms: 1, simulado: true }
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })
    // 2xx e 3xx (redirect para login) = no ar; 5xx/erro de rede = fora.
    return { ambiente, nome, url, ok: r.status < 500, codigo: r.status, ms: Date.now() - t0 }
  } catch {
    return { ambiente, nome, url, ok: false, codigo: null, ms: null }
  }
}

let itens = await Promise.all(ALVOS.map(medir))
// 2ª medição só para quem falhou na 1ª
const falhou1 = itens.filter(i => !i.ok)
if (falhou1.length) {
  await new Promise(r => setTimeout(r, ESPERA_REMEDIR))
  const re = await Promise.all(falhou1.map(i => medir([i.ambiente, i.nome, i.url])))
  itens = itens.map(i => re.find(r => r.ambiente === i.ambiente && r.nome === i.nome) ?? i)
}

// --- transições ok ↔ fora
let est = { servicos: {} }
try { if (existsSync(ARQ_ESTADO)) est = JSON.parse(readFileSync(ARQ_ESTADO, 'utf8')) } catch {}
est.servicos ??= {}
const agora = Date.now()
const avisos = []
function avisar(s, tipo, titulo, corpo, urgente) {
  s.avisosEm ??= {}
  if (agora - (s.avisosEm[tipo] ?? 0) < REPETIR_MS) { avisos.push({ titulo, suprimido: true }); return }
  notificar('Saúde dos ambientes', titulo, corpo, urgente)
  s.avisosEm[tipo] = agora
  avisos.push({ titulo, suprimido: false })
}
for (const i of itens) {
  const chave = `${i.ambiente}:${i.nome}`
  const s = est.servicos[chave] ??= { estado: 'ok', desde: agora }
  if (i.ok) {
    if (s.estado === 'fora') {
      const min = Math.round((agora - s.desde) / 60000)
      avisar(s, 'volta', `${i.ambiente} ${i.nome} voltou após ${min} min`, i.url, false)
      s.estado = 'ok'; s.desde = agora
    }
    s.codigo = i.codigo
  } else {
    const motivo = i.codigo ?? 'sem resposta'
    // falhou nas 2 medições desta execução = confirmado
    if (s.estado === 'ok') {
      s.estado = 'fora'; s.desde = agora
      avisar(s, 'fora', `${i.ambiente} ${i.nome} fora (${motivo})`, `${i.url}\nConfirmado em 2 medições seguidas.`, true)
    }
    s.codigo = i.codigo
  }
  i.estado = s.estado
}
est.em = agora
writeFileSync(ARQ_ESTADO, JSON.stringify(est, null, 1))

if (!TESTE) writeFileSync(join(dir, 'saude.json'), JSON.stringify({ em: agora, itens }, null, 1))
const fora = itens.filter(i => !i.ok)
const trans = avisos.length ? ' avisos=' + avisos.map(a => (a.suprimido ? '(repetido, não notificado) ' : '') + a.titulo).join(' | ') : ''
appendFileSync(join(dir, 'runs.log'), `${new Date().toISOString()} saude${TESTE ? '[teste]' : ''} fora=${fora.length}/${itens.length}${fora.length ? ' ' + fora.map(f => f.ambiente + ':' + f.nome).join(',') : ''}${trans}\n`)
for (const i of itens) console.log(`${i.ok ? '[ok]   ' : '[fora] '} ${i.ambiente} ${i.nome} · ${i.codigo ?? 'sem resposta'} · ${i.ms ?? '-'} ms${i.simulado ? ' (simulado)' : ''}`)
for (const a of avisos) console.log(`AVISO ${a.suprimido ? '(suprimido <30 min) ' : ''}${a.titulo}`)
