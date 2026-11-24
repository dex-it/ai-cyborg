import type { Register } from 'claude-code'

// Сервер Cyborg этой сессии и её токен лежат в её --mcp-config; без него мод молчит.
type Server = { url: string; headers: Record<string, string> }

const PAUSE_MS = 5_000

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const file = await $.env.get('CYBORG_MCP')
    const server = file ? await $.fs.read(file).then((t) => (JSON.parse(String(t)) as { mcpServers?: Record<string, Server> }).mcpServers?.cyborg, () => undefined) : undefined
    if (!server) return next(e)
    const base = server.url.replace(/\/mcp$/, '/side')
    const headers = { ...server.headers, 'Content-Type': 'application/json' }
    let busy = false
    let pauseUntil = 0
    $.clock.every(250, async () => {
      if (busy) return
      const now = await $.clock.now()
      if (now < pauseUntil) return
      busy = true
      try {
        const asked = await $.http.fetch(base + '/next', { method: 'POST', headers, body: '{}' })
        if (asked.status === 204) return
        if (asked.status !== 200) {
          pauseUntil = now + PAUSE_MS
          return
        }
        const ask = JSON.parse(asked.text) as { id: string; prompt: string }
        const t0 = await $.clock.now()
        // Без effort: на модели без уровня на сообщение другой уровень записал бы весь разговор в кэш заново.
        const result = await $.model.fork({ prompt: ask.prompt })
        const ms = (await $.clock.now()) - t0
        await $.http.fetch(base + '/answer', { method: 'POST', headers, body: JSON.stringify({ ...result, id: ask.id, ms }) })
      } catch {
        pauseUntil = (await $.clock.now()) + PAUSE_MS
      } finally {
        busy = false
      }
    })
    return next(e)
  })
}
