import { expect, mock, test } from 'claude-code/testing'

// No Windows o painel não chama bash, setsid nem xdg-open: abre com explorer.exe e lê o HOME de USERPROFILE.
const RETRATO = {
  em: 0,
  sessoes: [],
  relatorios: [],
  notas: null,
  artefatos: { total: 1, itens: [{ caminho: 'C:/Users/teste/AppData/Local/Temp/claude/x/relatorio.md', nome: 'relatorio.md', origem: 'scratchpad', horas: 1 }] },
}
const ENV_WIN = { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\teste' }

test('Windows: artefato e cérebro abrem com explorer.exe; 🧹 não chama bash', async ($, on) => {
  const comandos: string[][] = []
  const toasts: string[] = []
  on('process.run', (_$, e) => {
    comandos.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(RETRATO), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? JSON.stringify(e)))
    return { value: undefined } as never
  })
  mock.clock(on)
  mock.env(on, ENV_WIN)

  await $.command.run({ command: 'escritorio', args: '' } as never)
  const ui = await $.ui.mount({
    plugin: 'painel-escritorio',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'escritorio',
    props: { title: 'Escritório', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
  })

  // o coletor roda pelo node com o caminho montado de USERPROFILE (com "/", que o Windows aceita)
  expect(comandos).toContainEqual(['node', 'C:/Users/teste/.claude/agentic-os/coletar.mjs'])
  await ui.press({ key: 'aba-notas' })
  await ui.press({ key: 'artefato-0' })
  expect(comandos).toContainEqual(['explorer.exe', 'C:\\Users\\teste\\AppData\\Local\\Temp\\claude\\x\\relatorio.md'])
  await ui.press({ key: 'abrir-cerebro' })
  expect(comandos).toContainEqual(['explorer.exe', 'C:\\Users\\teste\\.claude\\agentic-os\\cerebro\\cerebro.html'])

  await ui.press({ key: 'aba-ferramentas' })
  await ui.press({ key: 'limpeza-diagnostico' })
  expect(await ui.findAll({ type: 'Text', text: /indisponível no Windows/ })).toHaveLength(1)
  expect(comandos.some(c => c[0] === 'bash' || c[0] === 'sh' || c[0] === 'setsid')).toBe(false)
})
