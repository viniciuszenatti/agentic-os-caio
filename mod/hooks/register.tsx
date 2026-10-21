import type { EngineInterface, Register } from 'claude-code'

import type { EstadoCI, ItemChecklist, Limpeza, PR, Relatorio, Retrato, Sessao, Subagente } from '../types'

const PAINEL = 'escritorio'
const TITULO = 'Escritório'
const PRS_A_CADA_MS = 3 * 60_000
const CENTRAL_URL = 'http://127.0.0.1:4747/'
const A_CADA_FILA_MS = 15_000

// Windows: o módulo não tem Node (sem process.platform); o próprio sistema põe OS=Windows_NT no ambiente.
export async function ehWindows($: EngineInterface) {
  return (await $.env.get('OS')) === 'Windows_NT'
}
const NO_WINDOWS = 'indisponível no Windows'

// Caminhos montados a partir do HOME de quem roda — nada de caminho pessoal no código.
// O módulo não tem Node (sem os.homedir), então o HOME vem do $.env (no Windows, USERPROFILE); sem ele, do próprio shell.
// Os caminhos usam "/": o node e o Windows aceitam.
export async function caminhos($: EngineInterface) {
  const win = await ehWindows($)
  let home = (win ? ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))) : await $.env.get('HOME')) ?? ''
  if (win) home = home.replace(/\\/g, '/')
  if (!home && !win) {
    const r = await $.process.run(['sh', '-c', 'cd ~ && pwd'], { timeoutMs: 5_000 }).catch(() => null)
    home = r?.exitCode === 0 ? r.stdout.trim() : ''
  }
  const claude = `${home}/.claude`
  const os = `${claude}/agentic-os`
  return {
    coletor: `${os}/coletar.mjs`,
    filaRespostas: `${os}/fila-respostas`,
    cerebro: `${os}/cerebro/cerebro.html`,
    deck: `${claude}/deck`,
    limpezaDir: `${claude}/limpeza`,
    limpezaScript: `${claude}/skills/limpeza/diagnostico.sh`,
    artefatos: `${claude}/artefatos`,
  }
}

// Atalho para o comando /better (mod Prompt Upgrade, distribuído à parte); avisa se não estiver instalado.
async function rodarBetter($: EngineInterface, args: string) {
  const r = await $.command.run({ command: 'better', args }).catch(() => null)
  if (!r) $.ui.toast('Prompt Upgrade não respondeu: o comando /better vem de um mod à parte, que não está instalado')
}

const CHAVE_LIMPEZA = { plugin: 'painel-escritorio', key: 'limpeza' } as const

// Linhas de alerta do relatório do diagnóstico (as que começam com "- ⚠️").
export function alertasDoRelatorio(md: string) {
  return md
    .split('\n')
    .filter(l => l.startsWith('- ⚠️'))
    .map(l => l.replace(/^- ⚠️\s*/, '').replace(/\*\*/g, ''))
}

// Botão 🧹: roda o script de diagnóstico (só leitura, sem LLM).
async function diagnosticar($: EngineInterface) {
  const { limpezaScript } = await caminhos($)
  const em = await $.clock.now()
  if (await ehWindows($)) {
    await $.state.set(CHAVE_LIMPEZA, { rodando: null, alertas: [], resumo: `diagnóstico ${NO_WINDOWS} (o script usa bash, /proc e systemd)`, arquivo: null, em })
    return
  }
  await $.state.set(CHAVE_LIMPEZA, { rodando: 'diagnostico', alertas: [], resumo: 'medindo…', arquivo: null, em })
  const r = await $.process.run(['bash', limpezaScript, '--rapido'], { timeoutMs: 90_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) {
    await $.state.set(CHAVE_LIMPEZA, { rodando: null, alertas: [], resumo: `diagnóstico falhou: ${r?.stderr.slice(0, 120) ?? 'timeout'}`, arquivo: null, em })
    return
  }
  const alertas = alertasDoRelatorio(r.stdout)
  const arquivo = r.stdout.match(/Relatório: `([^`]+)`/)?.[1] ?? null
  await $.state.set(CHAVE_LIMPEZA, { rodando: null, alertas, resumo: `${alertas.length} alerta(s)`, arquivo, em })
  $.ui.toast(alertas.length ? `Limpeza: ${alertas.length} alerta(s) — ${alertas[0]?.slice(0, 80)}` : 'Limpeza: máquina ok', { timeoutMs: 15_000 })
}

// Botão 🤖: roda a skill /limpeza headless (claude -p, Haiku), só com permissão para o script e Read.
// Gasta cota do plano — por isso é um botão separado do diagnóstico grátis.
async function analisarHeadless($: EngineInterface) {
  const { limpezaScript, limpezaDir } = await caminhos($)
  const em = await $.clock.now()
  const antes = (await $.state.get(CHAVE_LIMPEZA)).value
  if (await ehWindows($)) {
    $.ui.toast(`Análise headless da limpeza ${NO_WINDOWS}`)
    return
  }
  await $.state.set(CHAVE_LIMPEZA, { rodando: 'analise', alertas: antes?.alertas ?? [], resumo: 'Claude analisando (headless)…', arquivo: antes?.arquivo ?? null, em })
  const saida = `${limpezaDir}/analise-ultima.md`
  const r = await $.process
    .run(
      [
        'bash',
        '-c',
        'mkdir -p "$4" && claude -p "$1" --model haiku --allowedTools "$2" Read > "$3" && echo "$(date -Iseconds) analise-headless arquivo=$3" >> "$4/runs.log"',
        '_',
        '/limpeza',
        `Bash(bash ${limpezaScript}:*)`,
        saida,
        limpezaDir,
      ],
      { timeoutMs: 300_000 },
    )
    .catch(() => null)
  const ok = r?.exitCode === 0
  await $.state.set(CHAVE_LIMPEZA, {
    rodando: null,
    alertas: antes?.alertas ?? [],
    resumo: ok ? 'análise do Claude pronta' : `análise falhou: ${r?.stderr.slice(0, 120) ?? 'timeout'}`,
    arquivo: ok ? saida : antes?.arquivo ?? null,
    em,
  })
  $.ui.toast(ok ? `Análise pronta: ${saida}` : 'Análise headless falhou', { timeoutMs: 15_000 })
}

const CHAVE_DECK = { plugin: 'painel-escritorio', key: 'deck' } as const
export const MODELOS = ['haiku', 'sonnet', 'opus'] as const
export const ESFORCOS = ['low', 'medium', 'high'] as const

// Deck de skills. headless = claude -p só com Read/Grep/Glob (não pede permissão no meio,
// então não pode escrever); sessao = manda o pedido para esta sessão, que pode perguntar.
export const DECK = [
  {
    id: 'standup',
    rotulo: '📋 Standup',
    modo: 'headless',
    prompt:
      'Resume o estado do trabalho em texto curto: o que fechou, o que está em andamento há mais tempo, o que está parado ou bloqueado e o próximo passo de cada frente. Só leitura: leia os planos em ~/.claude/agentic-os/planos/ e os diários em ~/.claude/agentic-os/lideres/, não altere nada.',
  },
  {
    id: 'briefing',
    rotulo: '🌅 Briefing da manhã',
    modo: 'sessao',
    prompt: 'faz o briefing da manhã: o que está aberto nas sessões, nos planos e nos diários dos líderes, e o que precisa de mim hoje',
  },
] as const

type Deck = { modelo: (typeof MODELOS)[number]; esforco: (typeof ESFORCOS)[number]; rodando: string | null; ultimo: string | null }

async function lerDeck($: EngineInterface): Promise<Deck> {
  return (await $.state.get(CHAVE_DECK)).value ?? { modelo: 'haiku', esforco: 'low', rodando: null, ultimo: null }
}

async function girarDeck($: EngineInterface, campo: 'modelo' | 'esforco') {
  const d = await lerDeck($)
  if (campo === 'modelo') d.modelo = MODELOS[(MODELOS.indexOf(d.modelo) + 1) % MODELOS.length]!
  else d.esforco = ESFORCOS[(ESFORCOS.indexOf(d.esforco) + 1) % ESFORCOS.length]!
  await $.state.set(CHAVE_DECK, d)
}

async function dispararDeck($: EngineInterface, item: (typeof DECK)[number]) {
  if (item.modo === 'sessao') {
    await $.prompt.submit({ text: item.prompt, asUser: true })
    return
  }
  const { deck: deckDir } = await caminhos($)
  if (await ehWindows($)) {
    $.ui.toast(`${item.rotulo} headless ${NO_WINDOWS}: rode o comando numa sessão do Claude`)
    return
  }
  const d = await lerDeck($)
  await $.state.set(CHAVE_DECK, { ...d, rodando: item.rotulo })
  const r = await $.process
    .run(
      [
        'bash',
        '-c',
        'mkdir -p "$5" && f="$5/$1-$(date +%Y-%m-%d_%H%M).md" && claude -p "$2" --model "$3" --effort "$4" --allowedTools Read Grep Glob > "$f" && echo "$(date -Iseconds) $1 modelo=$3 esforco=$4 arquivo=$f" >> "$5/runs.log" && echo "$f"',
        '_',
        item.id,
        item.prompt,
        d.modelo,
        d.esforco,
        deckDir,
      ],
      { timeoutMs: 600_000 },
    )
    .catch(() => null)
  const arquivo = r?.exitCode === 0 ? r.stdout.trim() : null
  await $.state.set(CHAVE_DECK, { ...d, rodando: null, ultimo: arquivo ?? `${item.rotulo} falhou: ${r?.stderr.slice(0, 100) ?? 'timeout'}` })
  $.ui.toast(arquivo ? `${item.rotulo} pronto: ${arquivo}` : `${item.rotulo} falhou`, { timeoutMs: 15_000 })
}

const quando = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

type RespostaNaFila = { sessionId: string; nome?: string; texto: string; arquivo: string }

// Entrega as respostas escritas na Central. Cada arquivo é pego por UMA sessão:
// mv -n renomeia para .<minha-sessão>.enviando — se outra sessão pegou antes, o mv falha e ela pula.
// No Windows não há bash: o mesmo passo em node -e, com os caminhos como argumentos (nunca dentro do código).
const PEGAR_FILA_NODE =
  "const fs=require('fs'),p=require('path');const[d,m]=process.argv.slice(1);let fs_=[];try{fs_=fs.readdirSync(d)}catch{process.exit(0)}" +
  "for(const x of ['enviadas','erros'])fs.mkdirSync(p.join(d,x),{recursive:true});" +
  "for(const f of fs_){if(!f.endsWith('.json'))continue;const n=f+'.'+m+'.enviando';try{fs.renameSync(p.join(d,f),p.join(d,n))}catch{continue}" +
  "process.stdout.write(n+'\\t'+fs.readFileSync(p.join(d,n),'utf8').replace(/\\n/g,'')+'\\n')}"
const MOVER_FILA_NODE =
  "const fs=require('fs'),p=require('path');const[d,a,dest]=process.argv.slice(1);fs.renameSync(p.join(d,a),p.join(d,dest,a.replace(/\\.[^.]*\\.enviando$/,'')))"

async function entregarRespostas($: EngineInterface, minha: string) {
  const { filaRespostas } = await caminhos($)
  const win = await ehWindows($)
  const r = await $.process
    .run(
      win ? ['node', '-e', PEGAR_FILA_NODE, filaRespostas, minha || 'sem-sessao'] : [
        'bash',
        '-c',
        'cd "$1" 2>/dev/null || exit 0; mkdir -p enviadas erros; for f in *.json; do [ -e "$f" ] || continue; d="$f.$2.enviando"; mv -n -- "$f" "$d" 2>/dev/null && [ -e "$d" ] && printf "%s\\t%s\\n" "$d" "$(tr -d "\\n" < "$d")"; done',
        '_',
        filaRespostas,
        minha || 'sem-sessao',
      ],
      { timeoutMs: 10_000 },
    )
    .catch(() => null)
  if (!r?.stdout.trim()) return
  for (const linha of r.stdout.trim().split('\n')) {
    const [arquivo, json] = linha.split('\t')
    let item: RespostaNaFila | null = null
    try {
      item = { ...(JSON.parse(json ?? '') as Omit<RespostaNaFila, 'arquivo'>), arquivo: arquivo ?? '' }
    } catch {}
    let destino = 'erros'
    if (item?.sessionId && item.texto?.trim()) {
      const env = await $.session
        .send({ to: { sessionId: item.sessionId }, text: `[Resposta pela Central]\n${item.texto.trim()}` })
        .catch(() => null)
      if (env?.isDelivered) destino = 'enviadas'
      $.ui.toast(env?.isDelivered ? `Central: resposta entregue a ${item.nome ?? item.sessionId}` : `Central: não entreguei a ${item.nome ?? item.sessionId}`)
    }
    await $.process
      .run(win ? ['node', '-e', MOVER_FILA_NODE, filaRespostas, arquivo ?? '', destino] : ['bash', '-c', 'cd "$1" && mv -- "$2" "$3/${2%.*.enviando}"', '_', filaRespostas, arquivo ?? '', destino])
      .catch(() => null)
  }
}

// 📌 Copia o artefato para fora do /tmp (scratchpad some no reboot). cp -n não sobrescreve.
async function guardarArtefato($: EngineInterface, caminho: string, nome: string) {
  const { artefatos } = await caminhos($)
  const win = await ehWindows($)
  // Windows: copyFile com COPYFILE_EXCL faz o papel do cp -n (não sobrescreve); data AAAA-MM-DD sem ":" (o NTFS recusa ":")
  const GUARDAR_NODE =
    "const fs=require('fs'),p=require('path');const[d,o,n]=process.argv.slice(1);fs.mkdirSync(d,{recursive:true});" +
    "const t=new Date(),z=x=>String(x).padStart(2,'0');try{fs.copyFileSync(o,p.join(d,t.getFullYear()+'-'+z(t.getMonth()+1)+'-'+z(t.getDate())+'_'+n),fs.constants.COPYFILE_EXCL)}catch(e){if(e.code!=='EEXIST')throw e}console.log('ok')"
  const r = await $.process
    .run(win ? ['node', '-e', GUARDAR_NODE, artefatos, caminho, nome] : ['bash', '-c', 'mkdir -p "$1" && cp -n -- "$2" "$1/$(date +%Y-%m-%d)_$3" && echo ok', '_', artefatos, caminho, nome])
    .catch(() => null)
  $.ui.toast(r?.exitCode === 0 ? `📌 ${nome} guardado em ~/.claude/artefatos` : `Não guardei ${nome}`)
}

// Abre um arquivo no app padrão do sistema. setsid -f solta o app da sessão do Claude.
// No Windows: explorer.exe (abre arquivo, pasta ou URL no programa padrão). Ele sai com código 1 mesmo quando abre.
async function abrirArquivo($: EngineInterface, caminho: string) {
  if (await ehWindows($)) {
    const alvo = /^https?:/.test(caminho) ? caminho : caminho.replace(/\//g, '\\')
    const r = await $.process.run(['explorer.exe', alvo]).catch(() => null)
    $.ui.toast(r ? `Abrindo ${alvo.split(/[\\/]/).pop()}` : `Não consegui abrir ${alvo}`)
    return
  }
  const r = await $.process.run(['setsid', '-f', 'xdg-open', caminho]).catch(() => null)
  $.ui.toast(r?.exitCode === 0 ? `Abrindo ${caminho.split('/').pop()}` : `Não consegui abrir ${caminho}`)
}

function limpezaEmTexto(l: Limpeza | null) {
  if (!l) return 'Manutenção: nenhum diagnóstico ainda. /escritorio limpeza roda um.'
  return [`Manutenção: ${l.resumo}`, ...l.alertas.map(a => `  ⚠ ${a}`), l.arquivo ? `  relatório: ${l.arquivo}` : ''].filter(Boolean).join('\n')
}

type Coleta = { novo: Retrato | null; falha: string | null }

async function coletar($: EngineInterface): Promise<Coleta> {
  try {
    const { coletor } = await caminhos($)
    const { exitCode, stdout, stderr } = await $.process.run(['node', coletor], { timeoutMs: 15_000 })
    if (exitCode !== 0) return { novo: null, falha: `coletor saiu com ${exitCode}: ${stderr.slice(0, 120)}` }
    return { novo: JSON.parse(stdout) as Retrato, falha: null }
  } catch (problema) {
    return { novo: null, falha: `coletor falhou: ${String(problema).slice(0, 120)}` }
  }
}

function estadoDaSessao(s: Sessao) {
  if (s.status === 'busy') return 'trabalhando'
  if (s.status === 'waiting' || s.espera) return 'esperando você'
  return 'parada'
}

function precisaDeVoce(s: Sessao) {
  return s.status === 'waiting' || !!s.espera
}

function oQueEspera(s: Sessao) {
  if (s.espera?.tipo === 'permissao') return `pede permissão: ${s.espera.texto}`
  if (s.espera) return `perguntou: ${s.espera.texto}`
  return 'esperando você'
}

function progresso(rel: Relatorio | null | undefined) {
  if (!rel?.itens.length) return ''
  return ` · ${rel.itens.filter(i => i.estado === 'feito').length}/${rel.itens.length} feitos`
}

async function responder($: EngineInterface, s: Pick<Sessao, 'sessionId' | 'nome'>, texto: string) {
  const limpo = texto.trim()
  if (!limpo) return 'mensagem vazia, nada enviado'
  const r = await $.session.send({ to: { sessionId: s.sessionId }, text: limpo })
  return r.isDelivered ? `enviado para ${s.nome}` : `não entregue a ${s.nome}: ${r.reason}`
}

function tempo(min: number) {
  if (min < 1) return 'agora'
  if (min < 60) return `${min} min`
  if (min < 48 * 60) return `${Math.floor(min / 60)} h`
  return `${Math.floor(min / 1440)} dias`
}

const ICONE: Record<ItemChecklist['estado'], string> = {
  feito: '✅',
  fazendo: '🔄',
  bloqueado: '⛔',
  falhou: '❌',
  falta: '⬜',
}

// Barra de 12 blocos do relatório de sessão.
function barra(rel: Relatorio) {
  const total = rel.itens.length
  const feitos = rel.itens.filter(i => i.estado === 'feito').length
  const cheios = total ? Math.floor((feitos / total) * 12) : 0
  const bloq = rel.itens.filter(i => i.estado === 'bloqueado').length
  const falhou = rel.itens.filter(i => i.estado === 'falhou').length
  const pct = total ? Math.floor((feitos / total) * 100) : 0
  return `${'▓'.repeat(cheios)}${'░'.repeat(12 - cheios)} ${feitos}/${total} (${pct}%)${bloq ? ` · ${bloq} bloqueado` : ''}${falhou ? ` · ${falhou} falhou` : ''}`
}

// Itens que aparecem no painel: tudo que não está feito; feitos só se couber.
function itensVisiveis(rel: Relatorio, max: number) {
  const abertos = rel.itens.filter(i => i.estado !== 'feito')
  const feitos = rel.itens.filter(i => i.estado === 'feito')
  return [...abertos, ...feitos].slice(0, max).sort((a, b) => a.n - b.n)
}

function relatoriosSoltos(r: Retrato) {
  const ligados = new Set(r.sessoes.map(s => s.relatorio?.arquivo).filter(Boolean))
  return (r.relatorios ?? []).filter(rel => !ligados.has(rel.arquivo))
}

function relatorioEmTexto(rel: Relatorio, recuo: string) {
  const linhas = [`${recuo}${rel.titulo}`, `${recuo}${barra(rel)}`]
  if (rel.briefing) linhas.push(`${recuo}${rel.briefing}`)
  for (const i of rel.itens) linhas.push(`${recuo}${ICONE[i.estado]} ${i.n}. ${i.item}${i.motivo ? ` — ${i.motivo}` : ''}`)
  return linhas
}

function resumoEmTexto(r: Retrato) {
  const linhas: string[] = []
  const ocupadas = r.sessoes.filter(s => s.status === 'busy').length
  linhas.push(`SESSÕES: ${r.sessoes.length} abertas, ${ocupadas} trabalhando`)
  for (const s of r.sessoes.slice(0, 8)) {
    linhas.push(`  ${s.status === 'busy' ? '●' : precisaDeVoce(s) ? '⚠' : '○'} ${s.nome} · ${s.pasta} · ${estadoDaSessao(s)} há ${tempo(s.desdeMin)}`)
    if (s.titulo) linhas.push(`    ${s.titulo}`)
    if (s.espera) linhas.push(`    ⚠ ${oQueEspera(s)}`)
    if (s.ultimaFala) linhas.push(`    » ${s.ultimaFala}`)
    if (s.relatorio) linhas.push(...relatorioEmTexto(s.relatorio, '    '))
  }
  const soltos = relatoriosSoltos(r)
  if (soltos.length) {
    linhas.push('RELATÓRIOS DE SESSÃO (últimos 3 dias, sessão já fechada)')
    for (const rel of soltos) linhas.push(...relatorioEmTexto(rel, '  '), '')
  }
  if (r.notas) {
    linhas.push(`NOTAS: ${r.notas.total} notas · ${r.notas.semana} mexidas nesta semana`)
    for (const n of r.notas.recentes) linhas.push(`  ${n.dias}d · ${n.nota}`)
  }
  return linhas.join('\n')
}

// Saúde por ambiente, na ordem em que aparecem: "✅ dev 3/3   ❌ staging 1/2 (fora: api)".
function saudeEmTexto(itens: NonNullable<Retrato['saude']>['itens']) {
  const ambientes = [...new Set(itens.map(i => i.ambiente))]
  return ambientes
    .map(amb => {
      const xs = itens.filter(i => i.ambiente === amb)
      const fora = xs.filter(i => !i.ok)
      return `${fora.length ? '❌' : '✅'} ${amb} ${xs.length - fora.length}/${xs.length}${fora.length ? ` (fora: ${fora.map(f => f.nome).join(', ')})` : ''}`
    })
    .join('   ')
}

type Elementos = ReturnType<EngineInterface['ui']['resolve']>

const ABAS = [
  { id: 'agora', rotulo: 'Agora' },
  { id: 'sessoes', rotulo: 'Sessões' },
  { id: 'notas', rotulo: 'Notas' },
  { id: 'ferramentas', rotulo: 'Ferramentas' },
] as const
type Aba = (typeof ABAS)[number]['id']
const CHAVE_ABA = { plugin: 'painel-escritorio', key: 'aba' } as const

// Título de seção: o mesmo peso e cor em todo o painel.
function titulo(texto: string, { Text }: Elementos, cor: 'claude' | 'warning' = 'claude') {
  return (
    <Text bold color={cor}>
      {texto}
    </Text>
  )
}

const hora = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

function checklist(rel: Relatorio, { Box, Text }: Elementos, max = 6) {
  const visiveis = itensVisiveis(rel, max)
  const escondidos = rel.itens.length - visiveis.length
  return (
    <Box flexDirection="column">
      <Text color="claude">
        {'   '}
        {barra(rel)}
      </Text>
      {visiveis.map(i => (
        <Text
          key={String(i.n)}
          wrap="truncate-end"
          dimColor={i.estado === 'feito'}
          color={i.estado === 'bloqueado' || i.estado === 'falhou' ? 'warning' : undefined}
        >
          {'   '}
          {ICONE[i.estado]} {i.n}. {i.item}
          {i.motivo ? ` — ${i.motivo}` : ''}
        </Text>
      ))}
      {escondidos > 0 && (
        <Text dimColor>
          {'   '}+ {escondidos} itens · /escritorio mostra tudo
        </Text>
      )}
    </Box>
  )
}

// Compara o status de cada sessão com a leitura anterior e avisa quando uma
// sai de "trabalhando". Devolve o mapa novo para a próxima comparação.
function avisarMudancas($: EngineInterface, r: Retrato, antes: Map<string, string> | null, minha: string) {
  if (antes) {
    for (const s of r.sessoes) {
      if (s.sessionId === minha || antes.get(s.sessionId) !== 'busy' || s.status === 'busy') continue
      const assunto = s.titulo ? ` · ${s.titulo}` : ''
      $.ui.toast(
        precisaDeVoce(s) ? `${s.nome} precisa de você: ${oQueEspera(s)}` : `${s.nome} terminou${assunto}${progresso(s.relatorio)}`,
        { timeoutMs: 15_000 },
      )
    }
  }
  return new Map(r.sessoes.map(s => [s.sessionId, s.status]))
}

type Checagem = { status?: string; conclusion?: string; state?: string }

// Junta as checagens de um PR num estado só: falhou vence rodando, que vence ok.
export function estadoCI(checagens: readonly Checagem[] | null | undefined): EstadoCI {
  if (!checagens?.length) return 'sem'
  const finais = checagens.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (finais.some(f => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(f))) return 'falhou'
  if (finais.some(f => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'EXPECTED', 'REQUESTED'].includes(f))) return 'rodando'
  return 'ok'
}

const MARCA_CI: Record<EstadoCI, string> = { ok: '✅', falhou: '❌', rodando: '⏳', sem: '·' }

// PRs abertos de quem está logado no gh, no repo da sessão, com o estado do CI. Só leitura (gh pr list).
async function lerPRs($: EngineInterface, repo: string) {
  if (!repo) return
  const chave = { plugin: 'painel-escritorio', key: 'prs' } as const
  const em = await $.clock.now()
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['gh', 'pr', 'list', '--author', '@me', '--state', 'open', '--limit', '5', '--json', 'number,title,headRefName,url,statusCheckRollup'],
      { cwd: repo, timeoutMs: 20_000 },
    )
    if (exitCode !== 0) {
      await $.state.set(chave, { repo, itens: [], falha: stderr.trim().split('\n')[0]?.slice(0, 120) ?? `gh saiu com ${exitCode}`, em })
      return
    }
    const crus = JSON.parse(stdout) as { number: number; title: string; headRefName: string; url: string; statusCheckRollup: Checagem[] | null }[]
    const itens: PR[] = crus.map(p => ({ numero: p.number, titulo: p.title, branch: p.headRefName, url: p.url, ci: estadoCI(p.statusCheckRollup) }))
    await $.state.set(chave, { repo, itens, falha: null, em })
  } catch (problema) {
    await $.state.set(chave, { repo, itens: [], falha: String(problema).slice(0, 120), em })
  }
}

function prsEmTexto(prs: { repo: string; itens: PR[]; falha: string | null } | null) {
  if (!prs) return 'PRs: ainda lendo…'
  if (prs.falha) return `PRs em ${prs.repo}: ${prs.falha}`
  if (!prs.itens.length) return `PRs em ${prs.repo}: nenhum aberto seu`
  return [`PRs abertos em ${prs.repo}:`, ...prs.itens.map(p => `  ${MARCA_CI[p.ci]} #${p.numero} ${p.titulo} (${p.branch}) ${p.url}`)].join('\n')
}

const AJUDA = [
  '/escritorio — relatório de todas as sessões',
  '/escritorio standup — resumo do dia, pronto para colar',
  '/escritorio prs — PRs abertos seus neste repo, com o CI',
  '/escritorio limpeza — diagnóstico da máquina (só leitura)',
  '/escritorio responder <nome-da-sessão> <texto> — manda o texto para aquela sessão',
].join('\n')

export const register: Register = on => {
  let minhaSessao = ''
  let pastaDaSessao = ''
  // Status de cada sessão na leitura anterior, para avisar quando uma termina.
  let antes: Map<string, string> | null = null

  on('session.start', async ($, e, next) => {
    minhaSessao = (e as { session_id?: string }).session_id ?? ''
    await $.command.register({
      name: 'escritorio',
      description: 'Abre o painel Escritório: sessões, subagentes, notas e ferramentas',
    })
    const atualizar = async () => {
      const { novo, falha } = await coletar($)
      if (novo) antes = avisarMudancas($, novo, antes, minhaSessao)
      if (novo) await $.state.set({ plugin: 'painel-escritorio', key: 'retrato' } as const, novo)
      await $.state.set({ plugin: 'painel-escritorio', key: 'erro' } as const, falha)
    }
    // O coletor roda uma vez ao abrir e no /escritorio, não em loop em cada sessão — com N sessões
    // abertas seriam N coletas por minuto. A Central (porta 4747) faz a coleta contínua uma vez só.
    void atualizar()
    void $.ui.open({ id: PAINEL, title: TITULO })
    $.clock.every(A_CADA_FILA_MS, () => entregarRespostas($, minhaSessao))

    const r = await next(e)
    pastaDaSessao = r.cwd
    void lerPRs($, pastaDaSessao)
    $.clock.every(PRS_A_CADA_MS, () => lerPRs($, pastaDaSessao))

    return r
  })

  on('command.run', { command: 'escritorio' }, async ($, e) => {
    const [sub, alvo, ...resto] = e.args.trim().split(/\s+/)
    if (sub === 'ajuda') return { text: AJUDA }
    if (sub === 'prs') {
      await lerPRs($, pastaDaSessao)
      return { text: prsEmTexto((await $.state.get({ plugin: 'painel-escritorio', key: 'prs' } as const)).value ?? null) }
    }
    if (sub === 'limpeza') {
      await diagnosticar($)
      return { text: limpezaEmTexto((await $.state.get(CHAVE_LIMPEZA)).value ?? null) }
    }
    if (sub === 'standup') {
      const { coletor } = await caminhos($)
      const { exitCode, stdout, stderr } = await $.process.run(['node', coletor, '--standup'], { timeoutMs: 30_000 })
      return { text: exitCode === 0 ? stdout : `standup falhou: ${stderr.slice(0, 200)}` }
    }
    if (sub === 'responder') {
      const { novo } = await coletar($)
      const s = novo?.sessoes.find(x => x.nome === alvo)
      if (!s) return { text: `sessão "${alvo ?? ''}" não está aberta. Abertas: ${novo?.sessoes.map(x => x.nome).join(', ') ?? '?'}` }
      return { text: await responder($, s, resto.join(' ')) }
    }
    const { novo, falha } = await coletar($)
    if (novo) await $.state.set({ plugin: 'painel-escritorio', key: 'retrato' } as const, novo)
    await $.state.set({ plugin: 'painel-escritorio', key: 'erro' } as const, falha)
    const aberto = await $.ui.open({ id: PAINEL, title: TITULO })
    const aviso = aberto.isPlaced ? '' : `\n(caixa não desenhada: ${aberto.reason})`

    return { text: (novo ? resumoEmTexto(novo) : falha ?? 'sem dados') + aviso }
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const sub: Subagente = {
      id: e.tool_use_id,
      tipo: e.subagent_type ?? 'general-purpose',
      tarefa: e.description,
      rodando: true,
    }
    const antes = (await $.state.get({ plugin: 'painel-escritorio', key: 'subagentes' } as const)).value ?? []
    await $.state.set({ plugin: 'painel-escritorio', key: 'subagentes' } as const, [...antes, sub].slice(-20))
    try {
      return await next(e)
    } finally {
      const agora = (await $.state.get({ plugin: 'painel-escritorio', key: 'subagentes' } as const)).value ?? []
      await $.state.set(
        { plugin: 'painel-escritorio', key: 'subagentes' } as const,
        agora.map(s => (s.id === sub.id ? { ...s, rodando: false } : s)),
      )
    }
  })

  // Faixa acima do prompt: os PRs abertos desta sessão com o CI.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const prs = (await $.state.get({ plugin: 'painel-escritorio', key: 'prs' } as const)).value ?? null
    const itens = prs?.itens ?? []
    if (itens.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const abaixo = await next(e)
    const falhou = itens.some(p => p.ci === 'falhou')

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end" color={falhou ? 'error' : undefined}>
          PRs: {itens.map(p => `${MARCA_CI[p.ci]} #${p.numero} ${p.titulo.slice(0, 32)}`).join('  ')}
        </Text>
        {abaixo}
      </Box>
    )
  })

  // Painel em 4 abas: "Agora" é o que pede ação; o resto fica a um clique.
  on('ui.render', { component: 'Pane', requestId: PAINEL }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : null
    const r = (await $.state.get({ plugin: 'painel-escritorio', key: 'retrato' } as const)).value ?? null
    const subs = (await $.state.get({ plugin: 'painel-escritorio', key: 'subagentes' } as const)).value ?? []
    const falha = (await $.state.get({ plugin: 'painel-escritorio', key: 'erro' } as const)).value ?? null
    const prs = (await $.state.get({ plugin: 'painel-escritorio', key: 'prs' } as const)).value ?? null
    const limpeza = (await $.state.get(CHAVE_LIMPEZA)).value ?? null
    const aba: Aba = (await $.state.get(CHAVE_ABA)).value ?? 'agora'
    const deck = await lerDeck($)
    const { cerebro } = await caminhos($)

    if (!r) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{falha ?? 'Lendo sessões e notas…'}</Text>
        </Box>
      )
    }

    const ocupadas = r.sessoes.filter(s => s.status === 'busy').length
    const esperando = r.sessoes.filter(s => precisaDeVoce(s) && s.sessionId !== minhaSessao)
    const trabalhando = r.sessoes.filter(s => s.status === 'busy' && s.sessionId !== minhaSessao)
    const soltos = relatoriosSoltos(r)
    const v = r.notas
    const foraDoAr = r.saude?.itens.filter(i => !i.ok) ?? []

    // Faixa de status: lê-se em 1 segundo o que exige atenção.
    const faixa = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text color={ocupadas ? 'claude' : undefined} dimColor={!ocupadas}>
          ● {ocupadas} trabalhando
        </Text>
        <Text color={esperando.length ? 'warning' : undefined} dimColor={!esperando.length} bold={esperando.length > 0}>
          ⚠ {esperando.length} esperando você
        </Text>
        {r.saude && (
          <Text color={foraDoAr.length ? 'error' : 'success'}>
            {foraDoAr.length ? `✕ ${foraDoAr.length} fora do ar` : '✓ ambientes no ar'}
          </Text>
        )}
      </Box>
    )

    const abas = (
      <Box flexDirection="row" flexWrap="wrap">
        {ABAS.map(a => (
          <Button
            key={`aba-${a.id}`}
            variant={a.id === aba ? 'primary' : undefined}
            dimColor={a.id !== aba}
            onPress={() => void $.state.set(CHAVE_ABA, a.id)}
          >
            {a.id === 'agora' && esperando.length ? `Agora · ${esperando.length}` : a.id === 'sessoes' ? `Sessões · ${r.sessoes.length}` : a.rotulo}
          </Button>
        ))}
      </Box>
    )

    // ── Agora ────────────────────────────────────────────────────────────────
    const blocoEspera = esperando.length > 0 && (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        {titulo(`Precisa de você: ${esperando.length}`, ui, 'warning')}
        {esperando.map(s => (
          <Box key={`espera-${s.sessionId}`} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end" bold>
              {s.nome} <Text dimColor>· há {tempo(s.desdeMin)} · {s.titulo ?? s.pasta}</Text>
            </Text>
            <Text wrap="wrap" color="warning">
              {oQueEspera(s)}
            </Text>
            {s.ultimaFala && (
              <Text wrap="truncate-end" dimColor>
                » {s.ultimaFala}
              </Text>
            )}
            {Input && (
              <Input
                key={`responder-${s.sessionId}`}
                label="↳ "
                placeholder={`responder ${s.nome}…`}
                submitLabel="enviar"
                onSubmit={texto => {
                  void responder($, s, texto).then(msg => $.ui.toast(msg))
                }}
              />
            )}
          </Box>
        ))}
      </Box>
    )

    const prsAbertos = prs?.itens ?? []
    const blocoEstaSessao = (
      <Box flexDirection="column">
        {titulo('Esta sessão', ui)}
        {prsAbertos.map(p => (
          <Text key={`pr-${p.numero}`} wrap="truncate-end" color={p.ci === 'falhou' ? 'error' : undefined}>
            {MARCA_CI[p.ci]} PR #{p.numero} · {p.titulo}
          </Text>
        ))}
        {subs.slice(-3).map(s => (
          <Text key={s.id} wrap="truncate-end" dimColor={!s.rodando}>
            {s.rodando ? '▶ ' : '✓ '}
            {s.tipo}: {s.tarefa}
          </Text>
        ))}
        {!prsAbertos.length && !subs.length && <Text dimColor>sem PR aberto nem subagente nesta sessão</Text>}
      </Box>
    )

    const blocoTrabalhando = trabalhando.length > 0 && (
      <Box flexDirection="column">
        {titulo(`Trabalhando agora: ${trabalhando.length}`, ui)}
        {trabalhando.map(s => (
          <Box key={`trab-${s.sessionId}`} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color="claude">● </Text>
              {s.nome} <Text dimColor>· {s.titulo ?? s.pasta}</Text>
            </Text>
            {s.relatorio && (
              <Text color="claude" dimColor>
                {'   '}
                {barra(s.relatorio)}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )

    const agora = (
      <Box flexDirection="column" gap={1}>
        {blocoEspera}
        {blocoEstaSessao}
        {blocoTrabalhando}
        {!esperando.length && !trabalhando.length && <Text dimColor>Nada esperando você. As outras sessões estão paradas.</Text>}
      </Box>
    )

    // ── Sessões ──────────────────────────────────────────────────────────────
    const sessoes = (
      <Box flexDirection="column" gap={1}>
        {titulo(`Sessões abertas: ${r.sessoes.length} (${ocupadas} trabalhando)`, ui)}
        {r.sessoes.slice(0, 10).map(s => (
          <Box key={s.sessionId} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={s.status === 'busy' ? 'claude' : precisaDeVoce(s) ? 'warning' : undefined} dimColor={s.status !== 'busy' && !precisaDeVoce(s)}>
                {s.status === 'busy' ? '● ' : precisaDeVoce(s) ? '⚠ ' : '○ '}
              </Text>
              <Text bold>{s.nome}</Text>
              <Text dimColor>
                {s.sessionId === minhaSessao ? ' (esta)' : ''} · {estadoDaSessao(s)} há {tempo(s.desdeMin)}
              </Text>
            </Text>
            {s.titulo && (
              <Text wrap="truncate-end">
                {'   '}
                {s.titulo}
              </Text>
            )}
            {s.ultimaFala && (
              <Text wrap="truncate-end" dimColor>
                {'   » '}
                {s.ultimaFala}
              </Text>
            )}
            {s.relatorio && checklist(s.relatorio, ui, 4)}
          </Box>
        ))}
        {soltos.length > 0 && (
          <Box flexDirection="column">
            {titulo('Relatórios de sessões fechadas (3 dias)', ui)}
            {soltos.slice(0, 4).map(rel => (
              <Box key={rel.arquivo} flexDirection="column">
                <Text wrap="truncate-end">{rel.titulo}</Text>
                {checklist(rel, ui, 4)}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )

    // ── Notas e artefatos ────────────────────────────────────────────────────
    const notas = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {titulo(`Artefatos recentes${r.artefatos ? ` (${r.artefatos.total} em 3 dias)` : ''}`, ui)}
          {!r.artefatos?.itens.length && <Text dimColor>nada feito pelos agentes nos últimos 3 dias</Text>}
          {r.artefatos?.itens.slice(0, 6).map((a, i) => (
            <Box key={`artefato-linha-${i}`} flexDirection="row">
              <Button key={`artefato-${i}`} plain onPress={() => void abrirArquivo($, a.caminho)}>
                {`${a.horas < 1 ? 'agora' : `${a.horas} h`} · ${a.origem} · ${a.nome}`}
              </Button>
              {a.origem === 'scratchpad' && (
                <Button key={`guardar-${i}`} plain onPress={() => void guardarArtefato($, a.caminho, a.nome)}>
                  📌 guardar
                </Button>
              )}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          {titulo('Notas', ui)}
          {!v && <Text dimColor>nenhuma pasta de notas configurada no coletor</Text>}
          {v && (
            <Text>
              {v.total} notas · {v.semana} mexidas nesta semana
            </Text>
          )}
          {v?.recentes.map(n => (
            <Text key={n.nota} wrap="truncate-start" dimColor>
              {n.dias}d · {n.nota}
            </Text>
          ))}
        </Box>
        <Box flexDirection="row">
          <Button key="abrir-central" variant="primary" onPress={() => void abrirArquivo($, CENTRAL_URL)}>
            🛰 Abrir Central
          </Button>
          <Button key="abrir-cerebro" onPress={() => void abrirArquivo($, cerebro)}>
            🧠 Segundo cérebro
          </Button>
        </Box>
      </Box>
    )

    // ── Ferramentas ──────────────────────────────────────────────────────────
    const ferramentas = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {titulo('Ambientes', ui)}
          {!r.saude && <Text dimColor>sem medição de saúde dos ambientes</Text>}
          {r.saude && (
            <Text wrap="wrap" color={foraDoAr.length ? 'error' : undefined}>
              {saudeEmTexto(r.saude.itens)}
              {` · às ${hora(r.saude.em)}`}
            </Text>
          )}
          {r.contexto && (
            <Text wrap="wrap" dimColor>
              Contexto: {r.contexto.resumo} Detalhe em ~/.claude/limpeza/contexto.md
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {titulo('Manutenção', ui)}
          <Text dimColor wrap="truncate-end">
            {limpeza ? `${limpeza.resumo}${limpeza.rodando ? '' : ` · às ${hora(limpeza.em)}`}` : 'nenhum diagnóstico ainda'}
          </Text>
          {limpeza?.alertas.slice(0, 4).map((a, i) => (
            <Text key={`alerta-${i}`} wrap="truncate-end" color="warning">
              ⚠ {a}
            </Text>
          ))}
          {limpeza?.arquivo && (
            <Text wrap="truncate-start" dimColor>
              {limpeza.arquivo}
            </Text>
          )}
          <Box flexDirection="row">
            <Button key="limpeza-diagnostico" variant="primary" onPress={() => void diagnosticar($)}>
              🧹 Diagnóstico
            </Button>
            <Button key="limpeza-headless" onPress={() => void analisarHeadless($)}>
              🤖 Analisar com Claude
            </Button>
          </Box>
        </Box>

        <Box flexDirection="column">
          {titulo('Melhorar prompt', ui)}
          {Input && (
            <Input
              key="melhorar-rascunho"
              label="↳ "
              placeholder="prompt cru… (Enter chama o /better)"
              submitLabel="melhorar"
              onSubmit={texto => {
                if (texto.trim()) void rodarBetter($, texto.trim())
              }}
            />
          )}
          <Box flexDirection="row">
            <Button key="better-historico" onPress={() => void rodarBetter($, 'history')}>
              Histórico
            </Button>
            <Button key="better-on" onPress={() => void rodarBetter($, 'on')}>
              Automático: ligar
            </Button>
            <Button key="better-off" onPress={() => void rodarBetter($, 'off')}>
              desligar
            </Button>
          </Box>
          <Text dimColor wrap="truncate-end">
            precisa do mod Prompt Upgrade (/better), instalado à parte; cada uso gasta cota do plano
          </Text>
        </Box>

        <Box flexDirection="column">
          {titulo('Deck de skills', ui)}
          <Box flexDirection="row">
            <Button key="deck-modelo" onPress={() => void girarDeck($, 'modelo')}>
              {`modelo: ${deck.modelo}`}
            </Button>
            <Button key="deck-esforco" onPress={() => void girarDeck($, 'esforco')}>
              {`esforço: ${deck.esforco}`}
            </Button>
          </Box>
          {DECK.map(item => (
            <Button key={`deck-${item.id}`} plain onPress={() => void dispararDeck($, item)}>
              {`${item.rotulo}${item.modo === 'sessao' ? ' (nesta sessão)' : ''}`}
            </Button>
          ))}
          <Text dimColor wrap="truncate-start">
            {deck.rodando ? `rodando: ${deck.rodando}…` : deck.ultimo ? `último: ${deck.ultimo}` : 'headless gasta cota do plano; só leitura'}
          </Text>
        </Box>

        <Box flexDirection="column">
          {titulo('Rotinas', ui)}
          {!r.rotinas?.length && <Text dimColor>nenhum timer seu em ~/.config/systemd/user</Text>}
          {r.rotinas?.map(x => (
            <Text key={`rotina-${x.nome}`} wrap="truncate-end" color={x.resultado.startsWith('falhou') ? 'error' : undefined}>
              {x.resultado.startsWith('falhou') ? '❌' : '⏱'} {x.nome} · próxima {quando(x.proximo)} · última {quando(x.ultimo)} ({x.resultado})
            </Text>
          ))}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {faixa}
        {abas}
        {aba === 'agora' ? agora : aba === 'sessoes' ? sessoes : aba === 'notas' ? notas : ferramentas}
        {falha && <Text color="error">{falha}</Text>}
      </Box>
    )
  })
}
