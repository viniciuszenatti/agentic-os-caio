import { expect, mock, test } from 'claude-code/testing'

const RETRATO = { em: 0, sessoes: [], relatorios: [], notas: null }

const PRS = [
  { number: 12, title: 'Arruma o login', headRefName: 'fix/login', url: 'https://example.com/pr/12', statusCheckRollup: [{ conclusion: 'FAILURE' }] },
  { number: 13, title: 'Tela de cadastro', headRefName: 'feat/cadastro', url: 'https://example.com/pr/13', statusCheckRollup: [{ conclusion: 'SUCCESS' }] },
]

const resposta = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`esta sessão: PRs abertos com o CI, lidos na pasta da sessão (${surface})`, async ($, on) => {
    const pastas: (string | undefined)[] = []
    on('process.run', (_$, e) => {
      if (e.argv[0] === 'gh') {
        pastas.push(e.init?.cwd)
        return resposta(JSON.stringify(PRS))
      }
      return resposta(JSON.stringify(RETRATO))
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.toast', () => ({ value: undefined }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', () => ({ cwd: '/home/teste/Projects/meu-app' }) as never)
    mock.env(on, { HOME: '/home/teste' })
    const relogio = mock.clock(on)

    await $.session.start({ source: 'startup', session_id: 'eu', cwd: '/home/teste/Projects/meu-app', surface: null } as never)
    await relogio.advance(1)

    const ui = await $.ui.mount({
      plugin: 'painel-escritorio',
      surface,
      component: 'Pane',
      requestId: 'escritorio',
      props: { title: 'Escritório', isFocused: false, bodyColumns: 120, placement: 'dock' } as never,
    })

    expect(pastas[0]).toBe('/home/teste/Projects/meu-app')
    expect(await ui.findAll({ type: 'Text', text: /❌ PR #12 · Arruma o login/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /✅ PR #13 · Tela de cadastro/ })).toHaveLength(1)
  })
}

test('/escritorio prs devolve os PRs em texto', async ($, on) => {
  on('process.run', (_$, e) => resposta(e.argv[0] === 'gh' ? JSON.stringify(PRS) : JSON.stringify(RETRATO)))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/home/teste/Projects/meu-app' }) as never)
  mock.env(on, { HOME: '/home/teste' })
  mock.clock(on)

  await $.session.start({ source: 'startup', session_id: 'eu', cwd: '/home/teste/Projects/meu-app', surface: null } as never)
  const r = await $.command.run({ command: 'escritorio', args: 'prs' } as never)
  expect(JSON.stringify(r)).toContain('#12 Arruma o login (fix/login)')
})
