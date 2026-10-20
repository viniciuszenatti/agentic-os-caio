#!/usr/bin/env node
// "Onde parei?" por projeto: para cada repo principal da pasta de projetos (padrão ~/Projects, ou a
// variável AGENTIC_OS_PROJETOS; sem wt-*/bancadas, mas conta as worktrees), junta branch, último commit,
// sujeira, última sessão do Claude, último recorte de tela (opcional) e UMA frase de próximo passo
// deduzida por regra. Só leitura.
// Uso: node onde-parei.mjs            → grava estado/onde-parei.json e imprime todos
//      node onde-parei.mjs meu-repo    → só imprime aquele repo (não grava estado)
import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { join, basename } from 'node:path'
import { HOME, PROJETOS, sh, lerEstado, gravarEstado, listar, limpar } from './comum.mjs'
import { ultimasSessoes, rotulo } from './linha-do-tempo.mjs'

process.env.GIT_OPTIONAL_LOCKS = '0'
const ROTINA = 'onde-parei'
const FILTRO = process.argv[2]
const agora = Date.now()
const real = p => { try { return realpathSync(p) } catch { return p } }

// --- repos principais
const repos = listar(PROJETOS).filter(d => !d.startsWith('wt-') && d !== 'bancadas' && !d.startsWith('_') && !d.startsWith('.'))
  .map(d => join(PROJETOS, d)).filter(p => { try { return statSync(join(p, '.git')).isDirectory() } catch { return false } })
  .filter(p => !FILTRO || basename(p) === FILTRO)
if (FILTRO && !repos.length) { console.error(`repo "${FILTRO}" não encontrado em ${PROJETOS}`); process.exit(2) }

// --- sessões do Claude: nomes por sessionId + transcripts por pasta codificada
const nomes = {}
for (const f of listar(join(HOME, '.claude/sessions')).filter(f => f.endsWith('.json'))) {
  try { const s = JSON.parse(readFileSync(join(HOME, '.claude/sessions', f), 'utf8')); if (s.sessionId) nomes[s.sessionId] = s.name } catch {}
}
const PROJ = join(HOME, '.claude/projects')
const codificar = p => p.replace(/[^A-Za-z0-9-]/g, '-')
const pastasProj = new Set(listar(PROJ))
function ultimoTranscript(cwd) {
  let melhor = null
  for (const c of new Set([cwd, real(cwd)])) {
    const d = codificar(c)
    if (!pastasProj.has(d)) continue
    for (const f of readdirSync(join(PROJ, d)).filter(f => f.endsWith('.jsonl'))) {
      const m = statSync(join(PROJ, d, f)).mtimeMs
      if (!melhor || m > melhor.m) melhor = { arq: join(PROJ, d, f), m, cwd }
    }
  }
  return melhor
}
function titulo(arq) { // custom-title vence ai-title; lê o fim do arquivo (até 4 MB)
  const tam = statSync(arq).size, n = Math.min(tam, 4 << 20), buf = Buffer.alloc(n)
  const fd = openSync(arq, 'r'); readSync(fd, buf, 0, n, tam - n); closeSync(fd)
  const txt = buf.toString('utf8')
  const ult = re => { let r = null; for (const m of txt.matchAll(re)) r = m[1]; return r }
  const t = ult(/"customTitle":"((?:[^"\\]|\\.)*)"/g) ?? ult(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)
  try { return t ? JSON.parse(`"${t}"`) : null } catch { return t }
}

// --- recortes de tela (opcional): pares PNG+JSON numa pasta; o JSON diz o repo no campo "projeto".
// Pasta: variável AGENTIC_OS_RECORTES (padrão ~/Downloads/recortes-claude). Sem a pasta, nada acontece.
const RECORTES = process.env.AGENTIC_OS_RECORTES || join(HOME, 'Downloads/recortes-claude')
const recortes = []
function varrer(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) { varrer(p); continue }
    if (!f.endsWith('.json')) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8')); if (!j || Array.isArray(j)) continue
      const repo = j.projeto && existsSync(join(PROJETOS, j.projeto)) ? j.projeto : null
      if (!repo) continue
      const m = /^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(f)
      const quando = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime() : statSync(p).mtimeMs
      recortes.push({ repo, id: j.id ?? basename(f, '.json'), nota: j.nota ?? '', quando })
    } catch {}
  }
}
if (existsSync(RECORTES)) varrer(RECORTES)

const ci = lerEstado('vigia-ci')?.itens || []
const quandoTxt = t => { const h = (agora - t) / 3600000; return h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} dias` }

const projetos = []
for (const p of repos) {
  const g = (...a) => sh('git', ['-C', p, ...a], { timeout: 60000 })
  const branch = g('rev-parse', '--abbrev-ref', 'HEAD').out || '?'
  const lg = g('log', '-1', '--format=%h%x00%s%x00%cI').out.split('\0')
  const ultimoCommit = lg[0] ? { sha: lg[0], msg: limpar(lg[1]), quando: lg[2] } : null
  const st = g('status', '--porcelain', '--untracked-files=no')
  const sujos = st.out.split('\n').filter(Boolean)
  let maisAntigo = Infinity
  for (const l of sujos) { try { maisAntigo = Math.min(maisAntigo, statSync(join(p, l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))).mtimeMs) } catch {} }
  const wts = g('worktree', 'list', '--porcelain').out.split('\n\n').filter(b => b.startsWith('worktree ') && !/^prunable/m.test(b))
  const caminhosWt = wts.map(b => b.split('\n')[0].slice(9))
  const worktrees = caminhosWt.filter(c => real(c) !== real(p)).length

  // sessão: repo e suas worktrees
  let tr = null
  for (const c of caminhosWt.length ? caminhosWt : [p]) { const t = ultimoTranscript(c); if (t && (!tr || t.m > tr.m)) tr = t }
  const ultimaSessao = tr ? { nome: limpar(nomes[basename(tr.arq, '.jsonl')] ?? basename(tr.arq, '.jsonl').slice(0, 8)), titulo: limpar(titulo(tr.arq) ?? ''), quando: new Date(tr.m).toISOString(), pasta: tr.cwd.replace(HOME, '~') } : null

  const rc = recortes.filter(r => r.repo === basename(p)).sort((a, b) => b.quando - a.quando)[0]
  const ultimoRecorte = rc ? { id: rc.id, nota: limpar(rc.nota.replace(/\s+/g, ' ').slice(0, 100)), quando: new Date(rc.quando).toISOString() } : null


  // próximo passo, por regra (a 1ª que casar)
  const slug = sh('git', ['-C', p, 'remote', 'get-url', 'origin']).out.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1]
  const prs = ci.filter(i => i.repo === slug)
  const prBranch = prs.find(i => i.branch === branch)
  const vermelho = prs.find(i => i.situacao === 'falhou')
  const hSujo = maisAntigo === Infinity ? null : (agora - maisAntigo) / 3600000
  let proximo
  if (prBranch?.situacao === 'falhou') proximo = `PR #${prBranch.numero} com CI vermelho em ${branch}: abrir os checks (${prBranch.falhos.slice(0, 2).join(', ')})`
  else if (hSujo !== null && hSujo >= 24) proximo = `commit pendente há ${quandoTxt(maisAntigo)} em ${branch} (${sujos.length} arquivo(s))`
  else if (vermelho) proximo = `PR #${vermelho.numero} com CI vermelho (${vermelho.branch})`
  else if (sujos.length) proximo = `${sujos.length} arquivo(s) sem commit em ${branch}`
  else if (prBranch) proximo = `PR #${prBranch.numero} ${prBranch.situacao} em ${branch}: conferir revisão/merge`
  else if (ultimaSessao?.titulo) proximo = `retomar sessão "${ultimaSessao.titulo}"`
  else proximo = `nada pendente em ${branch}`

  const recente = Math.max(Date.parse(ultimoCommit?.quando ?? 0) || 0, Date.parse(ultimaSessao?.quando ?? 0) || 0, Date.parse(ultimoRecorte?.quando ?? 0) || 0)
  projetos.push({ repo: limpar(basename(p)), caminho: limpar(p), branch: limpar(branch), ultimoCommit, sujo: sujos.length > 0, arquivosSujos: sujos.length, worktrees, ultimaSessao, ultimoRecorte, proximo: limpar(proximo), _recente: recente })
}
projetos.sort((a, b) => b._recente - a._recente)
for (const x of projetos) { x.atividade = new Date(x._recente).toISOString(); delete x._recente }

// 5 últimas sessões do Claude (qualquer pasta), com o "Próximo" da última resposta e o comando de retomar
const sessoes = FILTRO ? [] : ultimasSessoes(5).map(x => ({ titulo: rotulo(x), viva: x.viva, repo: x.repo, branch: x.branch, pasta: x.pasta.replace(HOME, '~'), fim: x.fim, proximo: x.proximo, pedido: x.pedido, retomar: x.retomar }))
if (!FILTRO) gravarEstado(ROTINA, { ok: true, resumo: `${projetos.length} projetos; mais recente: ${projetos[0]?.repo} — ${projetos[0]?.proximo}`, itens: [], projetos, sessoes })

const q = iso => iso ? `há ${quandoTxt(Date.parse(iso))}` : '—'
if (sessoes.length) {
  console.log('══ Últimas 5 sessões')
  for (const x of sessoes) {
    console.log(`\n● ${x.titulo}${x.viva ? '  [viva]' : ''}  · ${x.repo || x.pasta} (${q(x.fim)})`)
    console.log(`  → ${x.proximo || (x.pedido ? 'último pedido: ' + x.pedido.slice(0, 90) : '(sem próximo passo)')}`)
    console.log(`  retomar: ${x.retomar}`)
  }
  console.log('\n══ Por projeto')
}
for (const x of projetos) {
  console.log(`\n■ ${x.repo}  [${x.branch}]${x.sujo ? ` ✎ ${x.arquivosSujos} sujo(s)` : ''}  · ${x.worktrees} worktree(s)`)
  if (x.ultimoCommit) console.log(`  commit   ${x.ultimoCommit.sha} ${x.ultimoCommit.msg.slice(0, 70)} (${q(x.ultimoCommit.quando)})`)
  if (x.ultimaSessao) console.log(`  sessão   ${x.ultimaSessao.nome}: ${x.ultimaSessao.titulo || '(sem título)'} (${q(x.ultimaSessao.quando)}, ${x.ultimaSessao.pasta})`)
  if (x.ultimoRecorte) console.log(`  recorte  ${x.ultimoRecorte.id}: ${x.ultimoRecorte.nota.slice(0, 70)} (${q(x.ultimoRecorte.quando)})`)
  console.log(`  → ${x.proximo}`)
}
