import { expect, mock, test } from 'claude-code/testing'

const RETRATO = { em: 0, sessoes: [], relatorios: [], notas: null }

test('entrega resposta da Central: pega o arquivo, manda para a sessão e move para enviadas', async ($, on) => {
  const comandos: string[][] = []
  const enviados: { to: unknown; text: string }[] = []
  on('process.run', (_$, e) => {
    comandos.push([...e.argv])
    const ehFila = e.argv[0] === 'bash' && String(e.argv[2]).includes('for f in *.json')
    const stdout = ehFila
      ? '1792450000000-s1.json.eu.enviando\t{"sessionId":"s1","nome":"sessao-07","texto":"pode seguir","em":1}\n'
      : JSON.stringify(RETRATO)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.send', (_$, e) => {
    enviados.push({ to: e.to, text: e.text })
    return { isDelivered: true } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/x' }) as never)
  const relogio = mock.clock(on)
  mock.env(on, { HOME: '/home/teste' })

  await $.session.start({ source: 'startup', session_id: 'eu', cwd: '/x', surface: null } as never)
  await relogio.advance(15_000)

  expect(enviados).toHaveLength(1)
  expect(JSON.stringify(enviados[0]?.to)).toContain('s1')
  expect(enviados[0]?.text).toBe('[Resposta pela Central]\npode seguir')
  const fila = comandos.find(c => String(c[2]).includes('for f in *.json'))
  expect(fila?.[5]).toBe('eu')
  const mover = comandos.find(c => String(c[2]).includes('${2%.*.enviando}'))
  expect(mover?.slice(4)).toEqual(['/home/teste/.claude/agentic-os/fila-respostas', '1792450000000-s1.json.eu.enviando', 'enviadas'])
})
