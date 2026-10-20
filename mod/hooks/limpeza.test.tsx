import { expect, mock, test } from 'claude-code/testing'

import { alertasDoRelatorio } from './register'

const RETRATO = { em: 0, sessoes: [], relatorios: [], notas: null }
const RELATORIO = [
  '## 1. CPU',
  '- ✅ limite de potência 15 W',
  '- ⚠️ load 15.14 18.41 19.89 com 8 threads (fila de CPU)',
  '- ⚠️ **155 paradas** · 51 com node_modules',
  '**2 alerta(s).** Relatório: `/home/x/.claude/limpeza/relatorios/2026-10-19_1700.md`.',
].join('\n')

test('alertasDoRelatorio pega só as linhas ⚠️, sem negrito', () => {
  expect(alertasDoRelatorio(RELATORIO)).toEqual(['load 15.14 18.41 19.89 com 8 threads (fila de CPU)', '155 paradas · 51 com node_modules'])
})

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`botões de Manutenção: 🧹 roda o script e 🤖 roda claude -p headless (${surface})`, async ($, on) => {
    const comandos: string[][] = []
    on('process.run', (_$, e) => {
      comandos.push([...e.argv])
      const ehScript = e.argv[0] === 'bash' && String(e.argv[1]).endsWith('diagnostico.sh')
      const stdout = ehScript ? RELATORIO : JSON.stringify(RETRATO)
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }) as never)
    mock.clock(on)
    mock.env(on, { HOME: '/home/teste' })

    await $.command.run({ command: 'escritorio', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'painel-escritorio',
      surface,
      component: 'Pane',
      requestId: 'escritorio',
      props: { title: 'Escritório', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })

    await ui.press({ key: 'aba-ferramentas' })
    expect(await ui.findAll({ type: 'Text', text: /Manutenção/ })).toHaveLength(1)
    await ui.press({ key: 'limpeza-diagnostico' })
    expect(comandos).toContainEqual(['bash', '/home/teste/.claude/skills/limpeza/diagnostico.sh', '--rapido'])
    expect(await ui.findAll({ type: 'Text', text: /155 paradas/ })).toHaveLength(1)

    await ui.press({ key: 'limpeza-headless' })
    const headless = comandos.find(c => c[0] === 'bash' && c[1] === '-c')
    expect(headless?.[2]).toContain('claude -p')
    expect(headless?.[2]).toContain('--model haiku')
    expect(headless?.[4]).toBe('/limpeza')
  })
}

test('/escritorio limpeza devolve os alertas em texto', async ($, on) => {
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stdout: String(e.argv[1]).endsWith('diagnostico.sh') ? RELATORIO : JSON.stringify(RETRATO), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', () => ({ value: undefined }) as never)
  mock.clock(on)
  mock.env(on, { HOME: '/home/teste' })
  const r = await $.command.run({ command: 'escritorio', args: 'limpeza' } as never)
  expect(JSON.stringify(r)).toContain('2 alerta(s)')
  expect(JSON.stringify(r)).toContain('fila de CPU')
})

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`artefatos recentes: lista e abre com xdg-open; 🧠 abre o segundo cérebro (${surface})`, async ($, on) => {
    const comandos: string[][] = []
    const retrato = {
      ...RETRATO,
      artefatos: { total: 2, itens: [{ caminho: '/tmp/x/relatorio.md', nome: 'relatorio.md', origem: 'scratchpad', horas: 2 }] },
    }
    on('process.run', (_$, e) => {
      comandos.push([...e.argv])
      return { value: { exitCode: 0, stdout: JSON.stringify(retrato), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }) as never)
    mock.clock(on)
    mock.env(on, { HOME: '/home/teste' })

    await $.command.run({ command: 'escritorio', args: '' } as never)
    const ui = await $.ui.mount({
      plugin: 'painel-escritorio',
      surface,
      component: 'Pane',
      requestId: 'escritorio',
      props: { title: 'Escritório', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })

    await ui.press({ key: 'aba-notas' })
    expect(await ui.findAll({ type: 'Text', text: /Artefatos recentes \(2 em 3 dias\)/ })).toHaveLength(1)
    await ui.press({ key: 'artefato-0' })
    expect(comandos).toContainEqual(['setsid', '-f', 'xdg-open', '/tmp/x/relatorio.md'])
    await ui.press({ key: 'abrir-cerebro' })
    expect(comandos).toContainEqual(['setsid', '-f', 'xdg-open', '/home/teste/.claude/agentic-os/cerebro/cerebro.html'])
  })
}
