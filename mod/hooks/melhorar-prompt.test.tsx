import { expect, mock, test } from 'claude-code/testing'

const RETRATO = { em: 0, sessoes: [], relatorios: [], notas: null }

test('Ferramentas › Melhorar prompt chama o /better do Prompt Upgrade', async ($, on) => {
  const better: string[] = []
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify(RETRATO), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  mock.env(on, { HOME: '/home/teste' })
  on('command.run', { command: 'better' }, (_$, e) => {
    better.push(e.args)
    return { text: 'ok' }
  })

  await $.command.run({ command: 'escritorio', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'painel-escritorio',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'escritorio',
    props: { title: 'Escritório', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })
  await ui.press({ key: 'aba-ferramentas' })
  expect(await ui.findAll({ type: 'Text', text: /Melhorar prompt/ })).toHaveLength(1)

  await ui.input({ key: 'melhorar-rascunho', text: 'faz uma landing page pro produto' })
  await ui.press({ key: 'better-on' })
  await ui.press({ key: 'better-historico' })
  expect(better).toEqual(['faz uma landing page pro produto', 'on', 'history'])
})
