import { atom, read, update } from 'claude-code'
import type { Register, SessionRateLimit, SessionContextUsage } from 'claude-code'

import type { LimitsReading } from '../types'

// Окна лимитов подписки и заполнение контекста справа в строке режима под промптом, рядом с режимом разрешений.
const reading = atom({ plugin: 'cyborg', key: 'limitsReading' } as const, null)
const now = atom({ plugin: 'cyborg', key: 'limitsNow' } as const, 0)

const LABEL: Record<string, string> = { five_hour: '5ч', seven_day: 'нед', spend_limit: 'спенд' }
const ORDER = ['five_hour', 'seven_day', 'spend_limit']

const toReading = (rateLimits: SessionRateLimit[], context: SessionContextUsage): LimitsReading => ({
  windows: [...rateLimits]
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .map((w) => ({ kind: w.kind, percent: w.percentUsed, resetsAt: w.resetsAt })),
  context: context.percent,
})

const bar = (p: number) => {
  const n = Math.max(0, Math.min(5, Math.round(p / 20)))
  return '▰'.repeat(n) + '▱'.repeat(5 - n)
}

const tone = (p: number) => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success')

const left = (resetsAt: string | undefined, at: number) => {
  if (!resetsAt) return ''
  const s = Math.floor((Date.parse(resetsAt) - at) / 1000)
  if (Number.isNaN(s)) return ''
  if (s <= 0) return 'сейчас'
  if (s < 3600) return `${Math.floor(s / 60)}м`
  if (s < 86400) return `${Math.floor(s / 3600)}ч${Math.floor((s % 3600) / 60)}м`
  return `${Math.floor(s / 86400)}д${Math.floor((s % 86400) / 3600)}ч`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, reading, () => toReading(usage.rateLimits, usage.context))
    await update($, now, () => Date.now())
    $.clock.every(60_000, () => void update($, now, () => Date.now()))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, reading, () => toReading(e.rateLimits, e.context))
    await update($, now, () => Date.now())
    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const r = await read($, reading)
    if (!r || (!r.windows.length && r.context === undefined)) return next(e)
    const at = (await read($, now)) || Date.now()
    const { Box, Text } = $.ui.resolve(e)
    const parts = r.windows.map((w) => {
      const p = Math.floor(w.percent)
      const t = left(w.resetsAt, at)
      return (
        <Text key={w.kind}>
          <Text dimColor>{(LABEL[w.kind] ?? w.kind) + ' '}</Text>
          <Text color={tone(p)}>{bar(p)} {p}%</Text>
          {t ? <Text dimColor>{' ↻ ' + t}</Text> : null}
        </Text>
      )
    })
    if (r.context !== undefined) parts.push(<Text key="ctx" dimColor>ctx {Math.floor(r.context)}%</Text>)
    const modes = e.props.modes.length ? <Text dimColor>{e.props.modes.join(' & ') + '  │  '}</Text> : null
    return (
      <Box>
        {modes}
        {parts.flatMap((p, i) => (i ? [<Text key={'s' + i} dimColor>{'  │  '}</Text>, p] : [p]))}
      </Box>
    )
  })
}
