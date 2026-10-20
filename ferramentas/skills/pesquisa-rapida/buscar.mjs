#!/usr/bin/env node
// Pesquisa rápida sem conta e sem chave: busca na Parallel (MCP hospedado, chamado por HTTP — nada de MCP instalado,
// então zero contexto fixo) e leitura de página pelo Jina Reader. Grátis nos dois casos (sem cartão, sem cadastro).
// Uso: node buscar.mjs "objetivo em linguagem natural" ["consulta 1" "consulta 2" ...]
//      node buscar.mjs --ler <url> [<url> ...]      → página em markdown (Jina Reader; reserva: Parallel web_fetch)
// NUNCA mandar dado de cliente, segredo ou nome de pessoa na consulta: vai para serviço de terceiro.
const U = 'https://search.parallel.ai/mcp'
const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }

async function rpc(sessao, corpo, ms = 60000) {
  const r = await fetch(U, { method: 'POST', headers: sessao ? { ...H, 'Mcp-Session-Id': sessao } : H, body: JSON.stringify(corpo), signal: AbortSignal.timeout(ms) })
  const txt = await r.text()
  if (!r.ok) throw new Error(`Parallel HTTP ${r.status}: ${txt.slice(0, 200)}`)
  const j = txt.includes('data:') ? txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop() : txt
  return { sessao: r.headers.get('mcp-session-id') || sessao, j: j ? JSON.parse(j) : null }
}
async function ferramenta(nome, args) {
  const ini = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pesquisa-rapida', version: '1' } } })
  await rpc(ini.sessao, { jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {})
  const { j } = await rpc(ini.sessao, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: nome, arguments: args } })
  if (j?.error) throw new Error(`Parallel: ${j.error.message}`)
  const t = j?.result?.content?.find(c => c.type === 'text')?.text ?? ''
  try { return JSON.parse(t) } catch { return { texto: t } }
}

async function jina(url) {
  const r = await fetch(`https://r.jina.ai/${url}`, { headers: { 'X-Return-Format': 'markdown' }, signal: AbortSignal.timeout(45000) })
  if (!r.ok) throw new Error(`Jina HTTP ${r.status}`)
  return r.text()
}

const a = process.argv.slice(2)
if (!a.length) { console.error('uso: node buscar.mjs "objetivo" ["consulta" ...]  |  node buscar.mjs --ler <url>'); process.exit(2) }
try {
  if (a[0] === '--ler') {
    for (const url of a.slice(1)) {
      let md
      try { md = await jina(url) } catch (e) {
        console.error(`(Jina falhou: ${e.message}; tentando Parallel web_fetch)`)
        const r = await ferramenta('web_fetch', { urls: [url], objective: 'conteúdo completo da página', full_content: true })
        md = (r.results || []).map(x => x.full_content || (x.excerpts || []).join('\n\n')).join('\n\n') || r.texto || ''
      }
      console.log(`\n===== ${url}\n${md.slice(0, 40000)}${md.length > 40000 ? '\n[… cortado em 40 mil caracteres]' : ''}`)
    }
  } else {
    const [objetivo, ...consultas] = a
    const r = await ferramenta('web_search', { objective: objetivo, search_queries: consultas.length ? consultas : [objetivo] })
    const res = r.results || []
    if (!res.length) console.log(r.texto || '(sem resultados)')
    res.forEach((x, i) => {
      console.log(`\n[${i + 1}] ${x.title || '(sem título)'}\n    ${x.url}${x.publish_date ? `  · ${x.publish_date}` : ''}`)
      console.log((x.excerpts || []).join('\n…\n').replace(/\n{3,}/g, '\n\n').slice(0, 1500).replace(/^/gm, '    '))
    })
  }
} catch (e) { console.error(`ERRO: ${e.message}`); process.exit(1) }
