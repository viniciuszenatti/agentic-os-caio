#!/usr/bin/env node
// Rotina "capacidade" — avisa pela CAPACIDADE do PC, não pelo número de sessões.
// Roda a cada 2 min (rotina-capacidade.timer). Sem LLM, sem rede, só leitura de /proc e /sys.
//
// Saída: ~/.claude/rotinas/estado/capacidade.json
//   { em, nivel, sinais:[{nome,valor,unidade,nivel}], culpados:[{tipo,nome,mb,cpu}], sugestao }
// Estado interno (histórico de temperatura, CPU por PID, última notificação): estado/capacidade.interno.json
// runs.log: 1 linha SÓ quando o nível muda.
//
// LIMIARES (calibrados num notebook Linux i5 de 15 W com 16 GB, carregado com 9 sessões do Claude, Chrome e
// VS Code. Ajuste à sua máquina. Leitura de referência: PSI mem some avg60 0,8% · CPU some avg60 3% ·
// MemAvailable 4,0 GB (25%) · swap 14,3/16 GB · load 3–7 em 8 threads · pacote 78–99 °C · PL1 15 W)
//
//  sinal                     atencao        critico       por quê
//  pressao_memoria (PSI)     some60 ≥ 5 %   some60 ≥ 20 % % do tempo em que alguma tarefa ESPEROU por memória.
//                            ou full10≥10%  ou full10≥30% É o sinal mais honesto de "travando por RAM" (hoje < 1 %).
//  memoria_disponivel        < 2 GB         < 1 GB        MemAvailable; abaixo de 1 GB o kernel vive despejando cache.
//  swap_em_uso               ≥ 75 %         ≥ 95 %        zram + swapfile somados. Cheio = zram comprimindo (CPU) e
//                                                         swapfile em disco (lento).
//  pressao_cpu (PSI)         some60 ≥ 25 %  some60 ≥ 60 % % do tempo com tarefa pronta esperando CPU.
//  carga_por_thread          load1/nproc≥1  ≥ 2           fila de CPU maior que as 8 threads.
//  temperatura_pacote        mediana ≥ 92°C mediana ≥ 97°C mediana das 3 últimas leituras (~6 min): a temperatura pula
//                                                         78→99 °C em segundos; o limite do chip é 100 °C (PROCHOT).
//  limite_potencia (RAPL)    —              < 10 W        PL1 caiu abaixo de 10 W = thermald travou a CPU (remédio R1).
//                                                         Só em Intel com intel-rapl-mmio; sem o arquivo, fica ok.
//
// nivel geral = o pior sinal. Notificação (notify-send): ao SUBIR de nível, ou se ficar crítico por 10 min;
// nunca a mesma notificação (mesmo nível) em menos de 30 min.
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { HOME, ESTADO, LIMPEZA, sh, notificar, listar } from './comum.mjs'

const ORDEM = { ok: 0, atencao: 1, critico: 2 }
const PIOR = (a, b) => (ORDEM[a] >= ORDEM[b] ? a : b)
const ler = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const F_SAIDA = join(ESTADO, 'capacidade.json')
const F_INT = join(ESTADO, 'capacidade.interno.json')
const agora = Date.now()
const int = (() => { try { return JSON.parse(ler(F_INT)) } catch { return {} } })()
int.temps ??= []; int.cpu ??= {}; int.titulos ??= {}

// ---------- sinais ----------
function psi(arq) {
  const o = {}
  for (const l of ler(arq).split('\n')) {
    const [tipo, ...kv] = l.trim().split(/\s+/)
    if (!tipo) continue
    o[tipo] = Object.fromEntries(kv.map((x) => x.split('=')).map(([k, v]) => [k, Number(v)]))
  }
  return o
}
const meminfo = Object.fromEntries(ler('/proc/meminfo').split('\n').filter(Boolean).map((l) => {
  const [k, v] = l.split(':'); return [k, parseInt(v) * 1024]
}))
const nproc = Number(sh('nproc', []).out) || 8
const load1 = Number(ler('/proc/loadavg').split(' ')[0])

function tempPacote() {
  const s = sh('sensors', [], { timeout: 5000 }).out.match(/Package id 0:\s*\+?([\d.]+)/)
  if (s) return Number(s[1])
  for (const z of listar('/sys/class/thermal').filter((d) => d.startsWith('thermal_zone'))) {
    if (ler(`/sys/class/thermal/${z}/type`).trim() === 'x86_pkg_temp') return Number(ler(`/sys/class/thermal/${z}/temp`)) / 1000
  }
  return null
}
const t = tempPacote()
if (t != null) int.temps = [...int.temps, t].slice(-3)
const tMed = int.temps.length ? [...int.temps].sort((a, b) => a - b)[Math.floor(int.temps.length / 2)] : null
const pl1 = Number(ler('/sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw')) / 1e6 || null

const pm = psi('/proc/pressure/memory'), pc = psi('/proc/pressure/cpu')
const swapTot = meminfo.SwapTotal || 0, swapUso = swapTot - (meminfo.SwapFree || 0)
const GB = (b) => +(b / 2 ** 30).toFixed(1)

function nv(valor, at, cr, menorPior = false) {
  if (valor == null || Number.isNaN(valor)) return 'ok'
  if (menorPior) return valor < cr ? 'critico' : valor < at ? 'atencao' : 'ok'
  return valor >= cr ? 'critico' : valor >= at ? 'atencao' : 'ok'
}
const sinais = [
  { nome: 'pressao_memoria', valor: pm.some?.avg60 ?? null, unidade: '% (PSI some avg60; full avg10 ' + (pm.full?.avg10 ?? '?') + '%)',
    nivel: PIOR(nv(pm.some?.avg60, 5, 20), nv(pm.full?.avg10, 10, 30)) },
  { nome: 'memoria_disponivel', valor: GB(meminfo.MemAvailable), unidade: 'GB', nivel: nv(GB(meminfo.MemAvailable), 2, 1, true) },
  { nome: 'swap_em_uso', valor: swapTot ? Math.round((swapUso / swapTot) * 100) : 0, unidade: `% (${GB(swapUso)}/${GB(swapTot)} GB)`,
    nivel: swapTot ? nv((swapUso / swapTot) * 100, 75, 95) : 'ok' },
  { nome: 'pressao_cpu', valor: pc.some?.avg60 ?? null, unidade: '% (PSI some avg60)', nivel: nv(pc.some?.avg60, 25, 60) },
  { nome: 'carga_por_thread', valor: +(load1 / nproc).toFixed(2), unidade: `x (load ${load1} / ${nproc} threads)`, nivel: nv(load1 / nproc, 1, 2) },
  { nome: 'temperatura_pacote', valor: tMed, unidade: `°C (mediana de ${int.temps.join('/')})`, nivel: nv(tMed, 92, 97) },
  { nome: 'limite_potencia', valor: pl1, unidade: 'W (PL1 RAPL)', nivel: pl1 != null && pl1 < 10 ? 'critico' : 'ok' },
]
const nivel = sinais.reduce((a, s) => PIOR(a, s.nivel), 'ok')

// ---------- culpados ----------
const TCK = 100 // CLK_TCK no Linux x86
const procs = new Map()
for (const d of readdirSync('/proc')) {
  if (!/^\d+$/.test(d)) continue
  const st = ler(`/proc/${d}/stat`); if (!st) continue
  const fim = st.lastIndexOf(')'), campos = st.slice(fim + 2).split(' ')
  const rssKb = Number((ler(`/proc/${d}/status`).match(/VmRSS:\s+(\d+)/) || [])[1] || 0)
  procs.set(Number(d), {
    pid: Number(d), ppid: Number(campos[1]), comm: st.slice(st.indexOf('(') + 1, fim),
    ticks: Number(campos[11]) + Number(campos[12]), rss: rssKb / 1024,
    args: ler(`/proc/${d}/cmdline`).replace(/\0/g, ' ').trim(),
  })
}
const filhos = new Map()
for (const p of procs.values()) { if (!filhos.has(p.ppid)) filhos.set(p.ppid, []); filhos.get(p.ppid).push(p.pid) }
const desc = (pid) => { const r = [pid]; for (const c of filhos.get(pid) || []) r.push(...desc(c)); return r }

// %CPU desde a última rodada (por PID); na 1ª rodada fica 0.
const dtSeg = int.em ? (agora - int.em) / 1000 : 0
const cpuPct = (pid) => {
  const p = procs.get(pid), ant = int.cpu[pid]
  return p && ant != null && dtSeg > 0 && p.ticks >= ant ? ((p.ticks - ant) / TCK / dtSeg) * 100 : 0
}
const novoCpu = {}; for (const p of procs.values()) if (p.ticks > 0) novoCpu[p.pid] = p.ticks

const MCPS = [
  ['chrome-devtools', /chrome-devtools-mcp|chrome-devtools-mcp\/chrome-profile/], ['mcp-image', /mcp-image/],
  ['runware', /runware/], ['gemini-notebook', /notebooklm-mcp|gemini-notebook/], ['rea', /\brea\b.*mcp|rea-mcp/],
  ['claude-mem', /claude-mem/], ['21st', /21st/], ['playwright', /playwright-mcp/],
]
const ehSessao = (p) => /(^|\/)claude$/.test(p.args.split(' ')[0]) && !/chrome-native-host| -p /.test(p.args)

const culpados = [], noSessao = new Set(), porMcp = {}
for (const p of procs.values()) {
  if (!ehSessao(p)) continue
  const arvore = desc(p.pid); arvore.forEach((x) => noSessao.add(x))
  const meta = (() => { try { return JSON.parse(ler(join(HOME, '.claude/sessions', p.pid + '.json'))) } catch { return {} } })()
  const sid = meta.sessionId || (p.args.match(/--resume[= ]([0-9a-f-]{36})/) || [])[1]
  let titulo = sid && int.titulos[sid]
  if (sid && !titulo) {
    const proj = join(HOME, '.claude/projects')
    for (const d of listar(proj)) {
      const f = join(proj, d, sid + '.jsonl')
      if (existsSync(f)) { titulo = (sh('grep', ['-h', '-o', '"aiTitle":"[^"]*"', f]).out.split('\n').pop() || '').slice(11, -1); break }
    }
    if (titulo) int.titulos[sid] = titulo
  }
  const nome = titulo || meta.name || basename(meta.cwd || '') || `pid ${p.pid}`
  const paradoMin = meta.status === 'idle' && meta.statusUpdatedAt ? Math.round((agora - meta.statusUpdatedAt) / 60000) : 0
  let mb = 0, cpu = 0
  for (const x of arvore) {
    const q = procs.get(x); if (!q) continue
    mb += q.rss; cpu += cpuPct(x)
    if (x !== p.pid) { const m = MCPS.find(([, re]) => re.test(q.args)); if (m) { porMcp[m[0]] ??= { mb: 0, cpu: 0, n: 0 }; porMcp[m[0]].mb += q.rss; porMcp[m[0]].cpu += cpuPct(x); porMcp[m[0]].n++ } }
  }
  culpados.push({ tipo: 'sessao', nome, mb: Math.round(mb), cpu: Math.round(cpu), pid: p.pid, parado_min: paradoMin, status: meta.status || '?' })
}
for (const [nome, v] of Object.entries(porMcp)) culpados.push({ tipo: 'mcp', nome: `${nome} (${v.n} proc, todas as sessões)`, mb: Math.round(v.mb), cpu: Math.round(v.cpu) })
// demais processos fora das sessões, agrupados pelo nome do programa (chrome, code, …)
const porComm = {}
for (const p of procs.values()) {
  if (noSessao.has(p.pid) || p.rss < 1) continue
  const nome = /\/opt\/google\/chrome|chrome$/.test(p.args.split(' ')[0]) ? 'chrome' : /\.vscode|\/code\b|\/usr\/share\/code/.test(p.args) ? 'vscode' : p.comm
  porComm[nome] ??= { mb: 0, cpu: 0 }; porComm[nome].mb += p.rss; porComm[nome].cpu += cpuPct(p.pid)
}
for (const [nome, v] of Object.entries(porComm)) culpados.push({ tipo: 'processo', nome, mb: Math.round(v.mb), cpu: Math.round(v.cpu) })
culpados.sort((a, b) => b.mb - a.mb)
const top = culpados.slice(0, 5)

// ---------- sugestão (UMA frase) ----------
const h = (min) => (min >= 90 ? `${Math.round(min / 60)} h` : `${min} min`)
const sessoesParadas = culpados.filter((c) => c.tipo === 'sessao' && c.status === 'idle').sort((a, b) => b.parado_min * b.mb - a.parado_min * a.mb)
const s = Object.fromEntries(sinais.map((x) => [x.nome, x]))
let sugestao
if (s.limite_potencia.nivel === 'critico') sugestao = `CPU travada em ${pl1} W pelo thermald: rodar "echo 15000000 | sudo tee /sys/class/powercap/intel-rapl-mmio:0/constraint_0_power_limit_uw" (remédio R1).`
else if (nivel === 'ok') sugestao = 'Nada a fazer: a máquina tem folga.'
else if (['pressao_memoria', 'memoria_disponivel', 'swap_em_uso'].some((k) => s[k].nivel !== 'ok') && sessoesParadas[0])
  sugestao = `Fechar a sessão "${sessoesParadas[0].nome}" (parada há ${h(sessoesParadas[0].parado_min)}) libera ~${sessoesParadas[0].mb} MB.`
else if (['temperatura_pacote', 'pressao_cpu', 'carga_por_thread'].some((k) => s[k].nivel !== 'ok')) {
  const q = [...culpados].sort((a, b) => b.cpu - a.cpu)[0]
  sugestao = q && q.cpu > 20 ? `Maior consumo de CPU agora é ${q.tipo} "${q.nome}" (${q.cpu}%): pausar ou fechar esfria a máquina.` : 'CPU quente sem culpado único: ligar o modo build (~/.claude/rotinas/modo-build.sh on) e deixar o notebook em superfície dura.'
} else sugestao = `Maior consumidor de RAM: ${top[0]?.tipo} "${top[0]?.nome}" (~${top[0]?.mb} MB).`

// ---------- gravar + notificar ----------
const saida = { em: new Date(agora).toISOString(), nivel, sinais, culpados: top, sugestao }
writeFileSync(F_SAIDA, JSON.stringify(saida, null, 1))

const anterior = int.nivel || 'ok'
if (nivel !== anterior) {
  appendFileSync(join(LIMPEZA, 'runs.log'), `${saida.em} capacidade nivel ${anterior}→${nivel} ${sinais.filter((x) => x.nivel !== 'ok').map((x) => `${x.nome}=${x.valor}`).join(' ')} | ${sugestao}\n`)
  int.desde = agora
}
const ruins = sinais.filter((x) => x.nivel !== 'ok').map((x) => `${x.nome.replace(/_/g, ' ')} ${x.valor}`).join(', ')
const subiu = ORDEM[nivel] > ORDEM[anterior]
const critico10 = nivel === 'critico' && agora - (int.desde || agora) >= 10 * 60000
const ultima = int.notif || {}
const repetida = ultima.nivel === nivel && agora - (ultima.em || 0) < 30 * 60000
if ((subiu || critico10) && !repetida) {
  notificar('Capacidade do PC', nivel === 'critico' ? 'PC no limite (crítico)' : 'PC pedindo atenção', `${ruins}\n${sugestao}`, nivel === 'critico')
  int.notif = { nivel, em: agora }
}
int.nivel = nivel; int.em = agora; int.cpu = novoCpu
writeFileSync(F_INT, JSON.stringify(int))
if (process.argv.includes('--mostrar')) console.log(JSON.stringify(saida, null, 1))
