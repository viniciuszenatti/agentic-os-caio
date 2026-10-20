import { expect, mock, test } from 'claude-code/testing'

const RETRATO = {
  em: 0,
  sessoes: [
    {
      nome: 'sessao-33',
      sessionId: 'a',
      pasta: '~/Projects/meu-app',
      status: 'busy',
      desdeMin: 2,
      titulo: 'Tela de cadastro',
      relatorio: {
        arquivo: '2026-10-17-tela-cadastro.md',
        titulo: 'Tela de cadastro — levar ao ar',
        briefing: '2 de 4 feitos.',
        mtimeMin: 5,
        itens: [
          { n: 1, item: 'Ler o fluxo atual', estado: 'feito', motivo: null },
          { n: 2, item: 'Escrever o formulário', estado: 'feito', motivo: null },
          { n: 3, item: 'Abrir PRs', estado: 'bloqueado', motivo: 'falta revisão de outra pessoa' },
          { n: 4, item: 'Conferir as telas', estado: 'falta', motivo: null },
        ],
      },
    },
    { nome: 'sessao-51', sessionId: 'b', pasta: '~/Projects/meu-app', status: 'idle', desdeMin: 19 },
  ],
  relatorios: [
    {
      arquivo: '2026-10-17-semana-time.md',
      titulo: 'Semana do time',
      briefing: null,
      mtimeMin: 600,
      itens: [{ n: 1, item: 'Fechar relatório', estado: 'fazendo', motivo: null }],
    },
  ],
  notas: { total: 319, semana: 10, recentes: [{ nota: 'produto/plano', dias: 3 }] },
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`painel mostra sessões, subagente e notas (${surface})`, async ($, on) => {
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(RETRATO), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    mock.env(on, { HOME: '/home/teste' })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed', content: [{ type: 'text', text: 'pronto' }] } }) as never)

    await $.command.run({ command: 'escritorio', args: '' } as never)
    await $.tool.call({ tool: 'Agent', description: 'Auditar contraste', prompt: 'x', subagent_type: 'a11y-auditor' })

    const ui = await $.ui.mount({
      plugin: 'painel-escritorio',
      surface,
      component: 'Pane',
      requestId: 'escritorio',
      props: { title: 'Escritório', isFocused: false, bodyColumns: 100, placement: 'dock' } as never,
    })

    // Agora: subagente desta sessão e a sessão trabalhando, com a barra
    expect(await ui.findAll({ type: 'Text', text: /a11y-auditor: Auditar contraste/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /Trabalhando agora: 1/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /2\/4 \(50%\) · 1 bloqueado/ })).toHaveLength(1)

    await ui.press({ key: 'aba-sessoes' })
    expect(await ui.findAll({ type: 'Text', text: /Sessões abertas: 2 \(1 trabalhando\)/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /Tela de cadastro/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /▓▓▓▓▓▓░░░░░░ 2\/4 \(50%\) · 1 bloqueado/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /⛔ 3\. Abrir PRs — falta revisão de outra pessoa/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /🔄 1\. Fechar relatório/ })).toHaveLength(1)

    await ui.press({ key: 'aba-notas' })
    expect(await ui.findAll({ type: 'Text', text: /319 notas · 10 mexidas/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /3d · produto\/plano/ })).toHaveLength(1)
  })
}
