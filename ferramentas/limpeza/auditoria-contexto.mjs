#!/usr/bin/env node
// Auditoria de contexto (B5 da masterclass RoboNuggets): quanto cada parte do setup custa em tokens
// em TODA sessão (descrições de skills/agentes, CLAUDE.md, MEMORY.md) e o que não foi usado em 30 dias.
// Só leitura. Grava ~/.claude/limpeza/contexto.json e contexto.md. Estimativa: 1 token ≈ 3,5 caracteres.
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const C = join(HOME, '.claude')
const tok = s => Math.round((s?.length ?? 0) / 3.5)
const ler = p => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const dirs = p => { try { return readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name) } catch { return [] } }

function frente(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const nome = m[1].match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]
  const desc = m[1].match(/^description:\s*([\s\S]*?)(?=\n[a-z_]+:|$)/m)?.[1]?.trim()
  return { nome, desc }
}

// 1. Uso nos últimos 30 dias (transcripts): Skill tool, slash command e subagente.
const uso = new Map()
const conta = k => uso.set(k, (uso.get(k) ?? 0) + 1)
// Só transcripts mexidos nos últimos 30 dias, em lotes de 200 arquivos.
const recentes = []
const andar = d => { for (const e of (() => { try { return readdirSync(d, { withFileTypes: true }) } catch { return [] } })()) {
  const p = join(d, e.name)
  if (e.isDirectory()) andar(p)
  else if (e.name.endsWith('.jsonl') && Date.now() - statSync(p).mtimeMs < 30 * 86_400_000) recentes.push(p)
} }
andar(join(C, 'projects'))
if (recentes.length) {
  for (let i = 0; i < recentes.length; i += 200) {
    try {
      const out = execFileSync('rg', ['-o', '--no-filename', '"name":"Skill","input":\\{"skill":"[^"]+"|<command-name>/[^<]+</command-name>|"subagent_type":"[^"]+"', ...recentes.slice(i, i + 200)],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
      for (const l of out.split('\n')) {
        const k = l.match(/"skill":"([^"]+)"/)?.[1] ?? l.match(/<command-name>\/([^<]+)</)?.[1] ?? l.match(/"subagent_type":"([^"]+)"/)?.[1]
        if (k) conta(k.trim())
      }
    } catch (e) { if (e.stdout) for (const l of String(e.stdout).split('\n')) { const k = l.match(/"skill":"([^"]+)"/)?.[1]; if (k) conta(k) } }
  }
}
const usos = nome => uso.get(nome) ?? [...uso].filter(([k]) => k.endsWith(':' + nome) || k === nome.split(':').pop()).reduce((a, [, v]) => a + v, 0)

// 2. Skills do usuário.
const itens = []
for (const s of dirs(join(C, 'skills'))) {
  const md = ler(join(C, 'skills', s, 'SKILL.md'))
  if (!md) continue
  const { nome = s, desc = '' } = frente(md)
  itens.push({ nome, tipo: 'skill', origem: 'usuário', tokens: tok(nome + desc), corpo: md.split('\n').length })
}

// 3. Plugins ligados: skills e agentes (só a descrição entra em toda sessão).
const cfg = JSON.parse(ler(join(C, 'settings.json')) || '{}')
const ligados = Object.entries(cfg.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k)
const porPlugin = []
for (const id of ligados) {
  const [plug, mkt] = id.split('@')
  const base = join(C, 'plugins/cache', mkt ?? '', plug)
  const versoes = dirs(base).sort()
  const raiz = versoes.length ? join(base, versoes[versoes.length - 1]) : null
  let tokens = 0, n = 0, usado = 0
  if (raiz) {
    for (const s of dirs(join(raiz, 'skills'))) {
      const { nome = s, desc = '' } = frente(ler(join(raiz, 'skills', s, 'SKILL.md')))
      const t = tok(nome + desc); tokens += t; n++; usado += usos(`${plug}:${nome}`) + usos(nome)
      itens.push({ nome: `${plug}:${nome}`, tipo: 'skill', origem: id, tokens: t })
    }
    for (const a of (() => { try { return readdirSync(join(raiz, 'agents')) } catch { return [] } })()) {
      if (!a.endsWith('.md')) continue
      const { nome = a.replace(/\.md$/, ''), desc = '' } = frente(ler(join(raiz, 'agents', a)))
      const t = tok(nome + desc); tokens += t; n++; usado += usos(`${plug}:${nome}`) + usos(nome)
      itens.push({ nome: `${plug}:${nome}`, tipo: 'agente', origem: id, tokens: t })
    }
  }
  porPlugin.push({ id, itens: n, tokens, usado })
}

// 4. Instruções fixas.
// MEMORY.md: um por projeto (~/.claude/projects/<pasta-do-projeto>/memory/MEMORY.md); cada sessão carrega o do seu projeto.
const fixos = [
  ['CLAUDE.md global', join(C, 'CLAUDE.md')],
  ...dirs(join(C, 'projects')).filter(p => existsSync(join(C, 'projects', p, 'memory/MEMORY.md')))
    .map(p => [`MEMORY.md (${p.replace(HOME.replace(/[^A-Za-z0-9-]/g, '-'), '~')})`, join(C, 'projects', p, 'memory/MEMORY.md')]),
].map(([parte, p]) => ({ parte, itens: 1, tokens: tok(ler(p)) }))

const skillsUsuario = itens.filter(i => i.origem === 'usuário')
const partes = [
  ...fixos,
  { parte: 'Descrições das skills suas', itens: skillsUsuario.length, tokens: skillsUsuario.reduce((a, i) => a + i.tokens, 0) },
  { parte: 'Descrições de skills/agentes de plugins', itens: porPlugin.reduce((a, p) => a + p.itens, 0), tokens: porPlugin.reduce((a, p) => a + p.tokens, 0) },
]
const tokensPorSessao = partes.reduce((a, p) => a + p.tokens, 0)

const candidatas = [
  ...porPlugin.filter(p => p.itens > 0 && p.usado === 0).map(p => ({ nome: p.id, tipo: 'plugin', tokens: p.tokens, motivo: `${p.itens} skills/agentes, 0 usos em 30 dias` })),
  ...skillsUsuario.filter(i => usos(i.nome) === 0).map(i => ({ nome: i.nome, tipo: 'skill', tokens: i.tokens, motivo: `0 usos em 30 dias · corpo ${i.corpo} linhas` })),
].sort((a, b) => b.tokens - a.tokens)

const economia = candidatas.reduce((a, c) => a + c.tokens, 0)
const resumo = `~${tokensPorSessao.toLocaleString('pt-BR')} tokens fixos por sessão; ${candidatas.length} itens sem uso em 30 dias somam ~${economia.toLocaleString('pt-BR')} (${Math.round((economia / tokensPorSessao) * 100)}%).`
const usos30d = Object.fromEntries([...uso].sort((a, b) => b[1] - a[1]))
const saida = { em: Date.now(), resumo, tokensPorSessao, partes, candidatas, plugins: porPlugin, transcripts30d: recentes.length, usos30d }
mkdirSync(join(C, 'limpeza'), { recursive: true })
writeFileSync(join(C, 'limpeza/contexto.json'), JSON.stringify(saida, null, 1))

const md = [
  `# Auditoria de contexto — ${new Date().toLocaleString('pt-BR')}`, '', `**${resumo}**`, '',
  `Base: ${recentes.length} transcripts dos últimos 30 dias. Estimativa: 1 token ≈ 3,5 caracteres. Corpo de skill só entra quando ela dispara; aqui conta o que entra SEMPRE.`, '',
  '| Parte | Itens | Tokens |', '|---|---|---|', ...partes.map(p => `| ${p.parte} | ${p.itens} | ${p.tokens.toLocaleString('pt-BR')} |`), '',
  '## Plugins (tokens fixos × usos em 30 dias)', '', '| Plugin | Itens | Tokens | Usos |', '|---|---|---|---|',
  ...porPlugin.sort((a, b) => b.tokens - a.tokens).map(p => `| ${p.id} | ${p.itens} | ${p.tokens.toLocaleString('pt-BR')} | ${p.usado} |`), '',
  '## Candidatas a desligar (maior custo primeiro)', '', ...candidatas.slice(0, 40).map(c => `- ${c.tipo} **${c.nome}** · ~${c.tokens} tokens · ${c.motivo}`),
  '', 'Desligar plugin: `claude plugin disable <id>` (religa com enable). Skill: mover a pasta para `~/.claude/skills-desligadas/`.',
].join('\n')
writeFileSync(join(C, 'limpeza/contexto.md'), md)
console.log(md.split('\n').slice(0, 14).join('\n'))
