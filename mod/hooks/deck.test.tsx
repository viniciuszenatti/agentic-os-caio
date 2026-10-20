import { expect, mock, test } from 'claude-code/testing'

const RETRATO = {
  em: 0,
  sessoes: [],
  relatorios: [],
  rotinas: [
    { nome: 'limpeza-semanal', proximo: 1793016000000, ultimo: null, resultado: 'nunca rodou' },
    { nome: 'backup-diario', proximo: 1792450879331, ultimo: 1792435355748, resultado: 'falhou (exit-code, saída 1)' },
  ],
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`rotinas e deck: mostra timers, gira modelo/esforço e dispara headless só leitura (${surface})`, async ($, on) => {
    const comandos: string[][] = []
    const prompts: string[] = []
    on('process.run', (_$, e) => {
      comandos.push([...e.argv])
      const ehDeck = e.argv[0] === 'bash' && e.argv[1] === '-c'
      return { value: { exitCode: 0, stdout: ehDeck ? '/x/deck/standup.md\n' : JSON.stringify(RETRATO), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('prompt.submit', (_$, e) => {
      prompts.push(e.text)
      return { text: e.text } as never
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
      props: { title: 'Escritório', isFocused: false, bodyColumns: 120, placement: 'dock' } as never,
    })

    await ui.press({ key: 'aba-ferramentas' })
    expect(await ui.findAll({ type: 'Text', text: /limpeza-semanal · próxima/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /❌ backup-diario/ })).toHaveLength(1)

    await ui.press({ key: 'deck-modelo' })
    await ui.press({ key: 'deck-esforco' })
    await ui.press({ key: 'deck-standup' })
    const deck = comandos.find(c => c[1] === '-c')
    expect(deck?.[2]).toContain('--allowedTools Read Grep Glob')
    expect(deck?.slice(4, 9)).toEqual(['standup', expect.stringContaining('~/.claude/agentic-os/planos/'), 'sonnet', 'medium', '/home/teste/.claude/deck'])

    await ui.press({ key: 'deck-briefing' })
    expect(prompts.some(p => p.startsWith('faz o briefing da manhã'))).toBe(true)
  })
}

for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`ambientes, contexto e 📌 guardar artefato (${surface})`, async ($, on) => {
    const comandos: string[][] = []
    const retrato = {
      ...RETRATO,
      saude: {
        em: 1792450879331,
        itens: [
          { ambiente: 'dev', nome: 'app', url: 'u', ok: true, codigo: 200, ms: 800 },
          { ambiente: 'staging', nome: 'api', url: 'u', ok: false, codigo: 502, ms: 900 },
        ],
      },
      contexto: { em: 0, resumo: '~31.397 tokens fixos por sessão', tokensPorSessao: 31397 },
      artefatos: { total: 1, itens: [{ caminho: '/tmp/x/scratchpad/a.html', nome: 'a.html', origem: 'scratchpad', horas: 1 }] },
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
      props: { title: 'Escritório', isFocused: false, bodyColumns: 120, placement: 'dock' } as never,
    })

    await ui.press({ key: 'aba-ferramentas' })
    expect(await ui.findAll({ type: 'Text', text: /✅ dev 1\/1.*❌ staging 0\/1 \(fora: api\)/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /31\.397 tokens/ })).toHaveLength(1)
    await ui.press({ key: 'aba-notas' })
    await ui.press({ key: 'guardar-0' })
    const cp = comandos.find(c => c[1] === '-c' && String(c[2]).includes('cp -n'))
    expect(cp?.slice(4)).toEqual(['/home/teste/.claude/artefatos', '/tmp/x/scratchpad/a.html', 'a.html'])
  })
}
