export type ItemChecklist = { n: number; item: string; estado: 'feito' | 'fazendo' | 'bloqueado' | 'falhou' | 'falta'; motivo: string | null }
export type Relatorio = { arquivo: string; titulo: string; briefing: string | null; itens: ItemChecklist[]; mtimeMin: number }
export type Sessao = {
  nome: string
  sessionId: string
  pasta: string
  status: string
  desdeMin: number
  titulo?: string | null
  relatorio?: Relatorio | null
  ultimaFala?: string | null
  espera?: Espera | null
}
export type Espera = { tipo: 'pergunta' | 'permissao'; texto: string }
export type Notas = { total: number; semana: number; recentes: { nota: string; dias: number }[] }
export type Retrato = {
  em: number
  sessoes: Sessao[]
  relatorios?: Relatorio[]
  artefatos?: Artefatos | null
  rotinas?: Rotina[] | null
  saude?: { em: number; itens: { ambiente: string; nome: string; url: string; ok: boolean; codigo: number | null; ms: number | null }[] } | null
  contexto?: { em: number; resumo: string; tokensPorSessao: number } | null
  notas?: Notas | null
}
export type Rotina = { nome: string; proximo: number | null; ultimo: number | null; resultado: string }
export type Artefatos = { total: number; itens: { caminho: string; nome: string; origem: string; horas: number }[] }
export type Subagente = { id: string; tipo: string; tarefa: string; rodando: boolean }
export type EstadoCI = 'ok' | 'falhou' | 'rodando' | 'sem'
export type PR = { numero: number; titulo: string; branch: string; url: string; ci: EstadoCI }
export type PRs = { repo: string; itens: PR[]; falha: string | null; em: number }
export type Limpeza = { rodando: 'diagnostico' | 'analise' | null; alertas: string[]; resumo: string; arquivo: string | null; em: number }

declare module 'claude-code' {
  interface PluginState {
    'painel-escritorio': {
      retrato: Retrato | null
      subagentes: Subagente[]
      erro: string | null
      aba: 'agora' | 'sessoes' | 'notas' | 'ferramentas' | null
      prs: PRs | null
      limpeza: Limpeza | null
      deck: { modelo: 'haiku' | 'sonnet' | 'opus'; esforco: 'low' | 'medium' | 'high'; rodando: string | null; ultimo: string | null } | null
    }
  }
}
