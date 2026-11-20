import { test, expect } from 'claude-code/testing'

test('лимиты рисуются в строке режима', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.measure({
    rateLimits: [
      { kind: 'seven_day', percentUsed: 92 },
      { kind: 'five_hour', percentUsed: 31.4, resetsAt: new Date(Date.now() + 1_860_000).toISOString() },
    ],
    context: { window: 200000, percent: 11 },
    changed: ['rateLimits', 'context'],
  })
  const ui = await $.ui.mount({ plugin: 'cyborg', surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  for (const re of [/5ч/, /31%/, /нед/, /92%/, /ctx 11%/, /focus/, /↻ 3\dм/]) expect(await ui.find({ type: 'Text', text: re })).toBeDefined()
  await ui.unmount()
})

test('без данных строка остаётся как у движка', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ plugin: 'cyborg', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
