// Utilidades das rotinas locais (sem LLM, sem API paga). Padrão: ~/.claude/limpeza/saude.mjs.
// Cada rotina grava ~/.claude/rotinas/estado/<rotina>.json ({em, ok, resumo, itens[]})
// e 1 linha por execução em ~/.claude/limpeza/runs.log.
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = homedir()
export const ROT = join(HOME, '.claude/rotinas')
export const ESTADO = join(ROT, 'estado')
export const LIMPEZA = join(HOME, '.claude/limpeza')
// Pasta onde moram os seus repositórios git (um por subpasta). Troque pela variável AGENTIC_OS_PROJETOS.
export const PROJETOS = process.env.AGENTIC_OS_PROJETOS || join(HOME, 'Projects')
mkdirSync(ESTADO, { recursive: true })
mkdirSync(LIMPEZA, { recursive: true })

// Executa um comando sem shell. Devolve { ok, out, err }.
export function sh(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout ?? 60000, maxBuffer: 64 << 20, cwd: opts.cwd })
    return { ok: true, out: out.trim(), err: '' }
  } catch (e) {
    return { ok: false, out: (e.stdout || '').toString().trim(), err: ((e.stderr || '').toString() || e.message).trim().split('\n').slice(-3).join(' | ') }
  }
}

// readdirSync que devolve [] se a pasta não existe.
export function listar(d) {
  try { return readdirSync(d) } catch { return [] }
}

export function lerEstado(rotina) {
  const f = join(ESTADO, rotina + '.json')
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

export function gravarEstado(rotina, { ok, resumo, itens, ...extra }) {
  const saida = { em: new Date().toISOString(), ok, resumo, itens, ...extra }
  writeFileSync(join(ESTADO, rotina + '.json'), JSON.stringify(saida, null, 1))
  appendFileSync(join(LIMPEZA, 'runs.log'), `${new Date().toISOString()} ${rotina} ok=${ok} ${resumo.replace(/\n/g, ' ')}\n`)
  return saida
}

export function notificar(app, titulo, corpo, urgente = false) {
  sh('notify-send', ['-a', app, '-i', urgente ? 'dialog-warning' : 'dialog-information', titulo, corpo])
}

// Notifica só se a mesma chave não foi avisada nos últimos `janelaMin` minutos (estado em estado/avisos.json).
// Devolve true se notificou.
export function notificarUmaVez(chave, app, titulo, corpo, urgente = false, janelaMin = 30) {
  const f = join(ESTADO, 'avisos.json')
  let m = {}
  try { if (existsSync(f)) m = JSON.parse(readFileSync(f, 'utf8')) } catch {}
  const agora = Date.now()
  if (m[chave] && agora - m[chave] < janelaMin * 60000) return false
  notificar(app, titulo, corpo, urgente)
  m[chave] = agora
  for (const k of Object.keys(m)) if (agora - m[k] > 7 * 86400000) delete m[k]
  writeFileSync(f, JSON.stringify(m, null, 1))
  return true
}

// Pastas (cwd) onde há sessão do Claude viva agora.
export function cwdsComSessaoViva() {
  const d = join(HOME, '.claude/sessions'), out = []
  for (const f of listar(d).filter(f => f.endsWith('.json'))) {
    try { const s = JSON.parse(readFileSync(join(d, f), 'utf8')); process.kill(s.pid, 0); out.push(s.cwd) } catch {}
  }
  return out
}

// Mascara nomes sensíveis (clientes, pessoas) antes de gravar estado ou mostrar na Central.
// Lista OPCIONAL em ~/.claude/rotinas/nomes-sensiveis.txt: um padrão regex por linha, sem diferenciar
// maiúsculas; linha começando com # é comentário. Formato em nomes-sensiveis.exemplo.txt.
// Sem o arquivo, nada é trocado.
let _padroes
export function limpar(txt) {
  if (!_padroes) {
    const f = join(ROT, 'nomes-sensiveis.txt')
    _padroes = []
    if (existsSync(f)) {
      for (const l of readFileSync(f, 'utf8').split('\n').map(l => l.trim())) {
        if (!l || l.startsWith('#')) continue
        try { _padroes.push(new RegExp(l, 'gi')) } catch {}
      }
    }
  }
  let s = String(txt ?? '')
  for (const re of _padroes) s = s.replace(re, '[cliente]')
  return s
}

export const dia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
