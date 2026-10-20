#!/usr/bin/env node
// Statusline do Claude Code: cota da janela de 5h e da semana (com hora do reset e aviso LOW), contexto e cache.
// Também grava amostras da cota (no máx. 1 a cada 2 min, entre todas as sessões) em estado/cota.jsonl e a
// previsão em estado/cota.json, que a Central mostra. Sem rede, sem IA. Nunca falha: imprime algo sempre.
import { readFileSync, appendFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const ESTADO = join(homedir(), '.claude/rotinas/estado')
const AMOSTRAS = join(ESTADO, 'cota.jsonl')
const hhmm = s => new Date(s * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const diaHora = s => new Date(s * 1000).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

// Ritmo pela regressão das amostras da janela atual (mesmo resets_at) nos últimos 45 min → quando chega a 100%.
export function prever(amostras, janela, agoraS) {
  const pts = amostras.filter(a => a[janela] && a[janela].r === amostras.at(-1)?.[janela]?.r && agoraS - a.t <= 45 * 60)
  if (pts.length < 3) return null
  const n = pts.length, mx = pts.reduce((s, a) => s + a.t, 0) / n, my = pts.reduce((s, a) => s + a[janela].p, 0) / n
  const den = pts.reduce((s, a) => s + (a.t - mx) ** 2, 0)
  if (den < 600 ** 2) return null // menos de ~10 min de amostra
  const incl = pts.reduce((s, a) => s + (a.t - mx) * (a[janela].p - my), 0) / den // % por segundo
  const ult = pts.at(-1)[janela]
  if (incl <= 0) return { porHora: 0, estouraEm: null, antesDoReset: false }
  const estouraEm = Math.round(pts.at(-1).t + (100 - ult.p) / incl)
  return { porHora: Math.round(incl * 3600 * 10) / 10, estouraEm, antesDoReset: estouraEm < ult.r }
}

function registrar(rl) {
  try {
    mkdirSync(ESTADO, { recursive: true })
    const agoraS = Math.floor(Date.now() / 1000)
    if (existsSync(AMOSTRAS) && Date.now() - statSync(AMOSTRAS).mtimeMs < 120000) return
    const a = { t: agoraS }
    if (rl.five_hour) a.h5 = { p: rl.five_hour.used_percentage, r: rl.five_hour.resets_at }
    if (rl.seven_day) a.d7 = { p: rl.seven_day.used_percentage, r: rl.seven_day.resets_at }
    appendFileSync(AMOSTRAS, JSON.stringify(a) + '\n')
    const todas = readFileSync(AMOSTRAS, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).filter(x => agoraS - x.t < 8 * 86400)
    if (todas.length > 6000) writeFileSync(AMOSTRAS, todas.slice(-4000).map(x => JSON.stringify(x)).join('\n') + '\n')
    writeFileSync(join(ESTADO, 'cota.json'), JSON.stringify({
      em: new Date().toISOString(), ok: true,
      resumo: `5h ${a.h5?.p ?? '?'}% · semana ${a.d7?.p ?? '?'}%`,
      itens: [],
      h5: a.h5 ? { ...a.h5, previsao: prever(todas, 'h5', agoraS) } : null,
      d7: a.d7 ? { ...a.d7, previsao: prever(todas, 'd7', agoraS) } : null,
      // uso por hora do dia na semana (mapa de calor): soma dos aumentos da janela de 5h
      porHora: (() => { const h = Array(24).fill(0); for (let i = 1; i < todas.length; i++) { const x = todas[i], y = todas[i - 1]; if (x.h5 && y.h5 && x.h5.r === y.h5.r && x.h5.p > y.h5.p) h[new Date(x.t * 1000).getHours()] += x.h5.p - y.h5.p } return h.map(v => Math.round(v)) })(),
    }, null, 1))
  } catch {}
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  let e = {}
  try { e = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch {}
  const partes = []
  try {
    const rl = e.rate_limits
    if (rl) {
      registrar(rl)
      const j = (nome, w, quando) => {
        if (!w) return null
        const resta = 100 - w.used_percentage
        return `${resta < 15 ? '⚠ LOW ' : ''}${nome} ${Math.round(w.used_percentage)}% (reset ${quando(w.resets_at)})`
      }
      partes.push(j('5h', rl.five_hour, hhmm), j('sem', rl.seven_day, diaHora))
    }
    const cw = e.context_window
    const pct = cw?.used_percentage ?? cw?.percent
    if (pct != null) partes.push(`ctx ${Math.round(pct)}%`)
    const pc = e.prompt_cache
    if (pc?.caching_observed) partes.push(pc.warm ? `cache quente${pc.expires_at ? ' até ' + hhmm(pc.expires_at) : ''}` : 'cache frio')
    if (e.workspace?.current_dir || e.cwd) partes.push(basename(e.workspace?.current_dir || e.cwd))
  } catch {}
  process.stdout.write(partes.filter(Boolean).join(' · ') || 'Claude')
}
