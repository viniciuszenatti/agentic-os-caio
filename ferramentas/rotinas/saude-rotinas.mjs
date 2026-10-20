#!/usr/bin/env node
// Saúde das rotinas (vigia dos vigias): para cada timer de USUÁRIO em ~/.config/systemd/user/*.timer,
// lê último disparo, próximo disparo e o resultado do serviço. Marca:
//   falha    — Result ≠ success ou ExecMainStatus ≠ 0 na última execução;
//   atrasado — OnCalendar: o horário previsto mais recente com 30+ min de idade passou e não rodou;
//              OnUnitActiveSec/OnBootSec: o último disparo é mais velho que intervalo × 1,5;
//   parado   — timer habilitado mas inativo (fora do modo build).
// Timers pausados pelo modo build (estado/modo-build.json, ativo=true) são ignorados.
// Avisa uma vez por ocorrência. Só leitura (systemctl show / systemd-analyze calendar).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME, sh, lerEstado, gravarEstado, notificarUmaVez, listar } from './comum.mjs'

const ROTINA = 'saude-rotinas'
const DIR = join(HOME, '.config/systemd/user')
// --simular-agora=2026-10-20T10:00 (só teste): finge outro relógio; não grava estado nem notifica.
const SIM = process.argv.find(a => a.startsWith('--simular-agora='))?.split('=')[1]
const agora = SIM ? Date.parse(SIM) : Date.now()
const monoAgora = Number(process.hrtime.bigint() / 1000000n) + (agora - Date.now()) // CLOCK_MONOTONIC em ms
const MIN = 60000

function span(txt) { // "15min", "1h 30min", "4h", "2min" → ms
  let ms = 0
  const U = { us: 1e-3, ms: 1, s: 1e3, sec: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, minute: 6e4, minutes: 6e4, h: 36e5, hr: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5, w: 6048e5, week: 6048e5, weeks: 6048e5 }
  for (const [, n, u] of txt.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]*)/gi)) ms += Number(n) * (U[u.toLowerCase() || 's'] ?? 1e3)
  return ms
}
function propsUnix(unit, props) {
  const r = sh('systemctl', ['--user', 'show', '--timestamp=unix', unit, '-p', props.join(',')])
  const o = {}
  for (const l of r.out.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1) }
  return o
}
const ts = v => { const m = /^@(\d+)/.exec(v || ''); return m ? Number(m[1]) * 1000 : null }
// Último horário previsto ≤ limite para uma expressão OnCalendar.
function previstoAntes(expr, limite) {
  const r = sh('systemd-analyze', ['calendar', `--base-time=@${Math.floor((limite - 8 * 864e5) / 1000)}`, '--iterations=3000', expr])
  let ult = null
  for (const [, d] of r.out.matchAll(/\(in UTC\): \w+ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC/g)) {
    const t = Date.parse(d.replace(' ', 'T') + 'Z')
    if (t > limite) break
    ult = t
  }
  return ult
}

// Volta da suspensão: timer não roda com o PC dormindo, então o relógio de atraso recomeça ao acordar.
const acordou = ts(sh('systemctl', ['show', '--timestamp=unix', 'sleep.target', '-p', 'ActiveExitTimestamp']).out.split('=')[1]) ?? 0
const build = lerEstado('modo-build')
const pausados = new Set(build?.ativo ? build.timers || [] : [])
const fmt = t => t ? new Date(t).toISOString() : null
const itens = [], problemas = []

for (const f of listar(DIR).filter(f => f.endsWith('.timer')).sort()) {
  const cfg = readFileSync(join(DIR, f), 'utf8')
  const cal = [...cfg.matchAll(/^OnCalendar=(.+)$/gm)].map(m => m[1].trim())
  const mono = [...cfg.matchAll(/^OnUnitActiveSec=(.+)$/gm)].map(m => span(m[1]))
  const t = propsUnix(f, ['LastTriggerUSec', 'NextElapseUSecRealtime', 'NextElapseUSecMonotonic', 'ActiveState', 'UnitFileState', 'Unit', 'ActiveEnterTimestamp'])
  const s = propsUnix(t.Unit, ['Result', 'ExecMainStatus', 'ActiveState', 'ExecMainExitTimestamp'])
  const ultimo = ts(t.LastTriggerUSec), entrou = ts(t.ActiveEnterTimestamp)
  let proximo = ts(t.NextElapseUSecRealtime)
  if (!proximo && t.NextElapseUSecMonotonic && t.NextElapseUSecMonotonic !== 'infinity') proximo = agora + span(t.NextElapseUSecMonotonic) - monoAgora
  const it = { timer: f, ultimo: fmt(ultimo), proximo: fmt(proximo), resultado: null, ok: true, atrasadoMin: 0, servico: t.Unit, intervalo: cal.length ? cal.join(' | ') : mono.length ? `${Math.round(Math.min(...mono) / MIN)} min` : '—' }
  itens.push(it)

  if (pausados.has(f)) { it.resultado = 'pausado (modo build)'; continue }
  if (t.UnitFileState !== 'enabled' && t.ActiveState !== 'active') { it.resultado = 'desligado'; continue }
  if (t.ActiveState !== 'active') { it.resultado = 'parado'; it.ok = false; problemas.push({ it, chave: `parado:${f}:${new Date().toDateString()}`, txt: `${f} habilitado mas parado` }); continue }

  // resultado da última execução do serviço
  const falhou = (s.Result && s.Result !== 'success') || (s.ExecMainStatus && s.ExecMainStatus !== '0')
  it.resultado = s.ActiveState === 'activating' || s.ActiveState === 'active' ? 'rodando' : falhou ? `falhou (${s.Result}, status ${s.ExecMainStatus})` : (ultimo ? 'success' : 'ainda não rodou')
  if (falhou) { it.ok = false; problemas.push({ it, chave: `falha:${f}:${s.ExecMainExitTimestamp}`, txt: `${t.Unit} falhou (${s.Result}, status ${s.ExecMainStatus})` }) }

  // atraso
  const ref = Math.max(ultimo ?? 0, entrou ?? 0, acordou)
  if (cal.length) {
    const prev = Math.max(...cal.map(c => previstoAntes(c, agora - 30 * MIN) ?? 0))
    if (prev && ref < prev) { it.atrasadoMin = Math.round((agora - prev) / MIN); it.ok = false; problemas.push({ it, chave: `atraso:${f}:${prev}`, txt: `${f} não rodou no horário de ${new Date(prev).toLocaleString('pt-BR')} (${it.atrasadoMin} min)` }) }
  } else if (mono.length) {
    const iv = Math.min(...mono)
    if (ref && agora - ref > iv * 1.5) { it.atrasadoMin = Math.round((agora - ref - iv) / MIN); it.ok = false; problemas.push({ it, chave: `atraso:${f}:${ultimo}`, txt: `${f} atrasado ${it.atrasadoMin} min (intervalo ${Math.round(iv / MIN)} min)` }) }
  }
}

const ruins = itens.filter(i => !i.ok)
const resumo = `${itens.length} timers: ${itens.length - ruins.length} ok, ${ruins.length} com problema` + (pausados.size ? ` (${pausados.size} pausados pelo modo build)` : '')
if (SIM) console.log('[simulação: estado e avisos NÃO gravados]')
else gravarEstado(ROTINA, { ok: !ruins.length, resumo, itens })
if (!SIM) for (const p of problemas) notificarUmaVez(`saude-rotinas:${p.chave}`, 'Saúde das rotinas', p.it.resultado?.startsWith('falhou') && p.chave.startsWith('falha') ? 'Rotina falhou' : 'Rotina atrasada/parada', p.txt, true, 7 * 24 * 60)
console.log(resumo)
const hh = iso => iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
for (const i of itens) console.log(`${i.ok ? '[ok]   ' : '[ruim] '} ${i.timer.padEnd(34)} último ${hh(i.ultimo).padEnd(17)} próximo ${hh(i.proximo).padEnd(17)} ${i.resultado}${i.atrasadoMin ? ` · atrasado ${i.atrasadoMin} min` : ''}`)
