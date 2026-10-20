import { expect, test } from 'claude-code/testing'

import { estadoCI } from './register'

test('estado do CI de um PR', async () => {
  expect(estadoCI(null)).toBe('sem')
  expect(estadoCI([])).toBe('sem')
  expect(estadoCI([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('ok')
  expect(estadoCI([{ status: 'IN_PROGRESS', conclusion: '' }, { conclusion: 'SUCCESS' }])).toBe('rodando')
  expect(estadoCI([{ status: 'IN_PROGRESS', conclusion: '' }, { conclusion: 'FAILURE' }])).toBe('falhou')
  expect(estadoCI([{ conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }])).toBe('ok')
})
