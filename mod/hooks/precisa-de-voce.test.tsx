import { expect, mock, test } from 'claude-code/testing'

const sessao = (status: string, extra: object = {}) => ({
  nome: 'sessao-60',
  sessionId: 'outra',
  pasta: '~/Projects/meu-app',
  status,
  desdeMin: 3,
  titulo: 'Revisar a tela inicial',
  ultimaFala: 'Rodei os testes, 12 passaram.',
  ...extra,
})

const retrato = (s: object) => ({ em: 0, sessoes: [s], relatorios: [], notas: null })

const resposta = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`precisa de você mostra a pergunta e envia a resposta (${surface})`, async ($, on) => {
  mock.env(on, { HOME: '/home/teste' })
    const enviados: { to: unknown; text: string }[] = []
    const espera = sessao('waiting', { espera: { tipo: 'pergunta', texto: 'Qual ambiente, local ou staging?' } })
    on('process.run', () => resposta(JSON.stringify(retrato(espera))))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }) as never)
    on('session.send', (_$, e) => {
      enviados.push({ to: e.to, text: e.text })
      return { isDelivered: true } as never
    })

    await $.command.run({ command: 'escritorio', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'painel-escritorio',
      surface,
      component: 'Pane',
      requestId: 'escritorio',
      props: { title: 'Escritório', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })

    expect(await ui.findAll({ type: 'Text', text: /Precisa de você: 1/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /perguntou: Qual ambiente, local ou staging\?/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /» Rodei os testes, 12 passaram\./ })).toHaveLength(1)

    await ui.input({ key: 'responder-outra', text: 'local' })
    expect(enviados).toHaveLength(1)
    expect(enviados[0]?.text).toBe('local')
  })
}

// O coletor não roda a cada 60 s em cada sessão (com N sessões seriam N coletas por minuto).
// Coleta só ao abrir a sessão e no /escritorio; a coleta contínua é da Central.
test('não coleta de novo a cada minuto', async ($, on) => {
  mock.env(on, { HOME: '/home/teste' })
  const toasts: string[] = []
  let leitura = 0
  let coletas = 0
  on('process.run', (_$, e) => {
    leitura += 1
    const j = JSON.stringify(e)
    if (j.includes('coletar.mjs') && !j.includes('--standup')) coletas += 1
    const s = leitura === 1 ? sessao('busy') : sessao('idle', { relatorio: { arquivo: 'a.md', titulo: 'X', briefing: null, mtimeMin: 1, itens: [{ n: 1, item: 'a', estado: 'feito', motivo: null }, { n: 2, item: 'b', estado: 'falta', motivo: null }] } })
    return resposta(JSON.stringify(retrato(s)))
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/x' }) as never)
  const relogio = mock.clock(on)

  await $.session.start({ source: 'startup', session_id: 'eu', cwd: '/x', surface: null } as never)
  await relogio.advance(5 * 60_000)

  expect(coletas).toBe(1)
  expect(toasts).toEqual([])
})

test('/escritorio standup devolve o resumo do coletor', async ($, on) => {
  mock.env(on, { HOME: '/home/teste' })
  on('process.run', (_$, e) =>
    resposta(JSON.stringify(e).includes('--standup') ? '*Resumo de hoje — 18/10*' : JSON.stringify(retrato(sessao('idle')))),
  )
  const r = await $.command.run({ command: 'escritorio', args: 'standup' } as never)
  expect(JSON.stringify(r)).toContain('Resumo de hoje')
})

test('/escritorio responder manda o texto para a sessão pelo nome', async ($, on) => {
  mock.env(on, { HOME: '/home/teste' })
  const enviados: string[] = []
  on('process.run', () => resposta(JSON.stringify(retrato(sessao('idle')))))
  on('session.send', (_$, e) => {
    enviados.push(e.text)
    return { isDelivered: true } as never
  })
  const r = await $.command.run({ command: 'escritorio', args: 'responder sessao-60 pode seguir com o local' } as never)
  expect(enviados).toEqual(['pode seguir com o local'])
  expect(JSON.stringify(r)).toContain('enviado para sessao-60')
})
