const KEY = 'voice-assistant-session-id'

function createFallbackId() {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function getSessionId() {
  let id = localStorage.getItem(KEY)
  if (!id) {
    const c = globalThis.crypto as Crypto | undefined
    id = c && typeof c.randomUUID === 'function' ? c.randomUUID() : createFallbackId()
    localStorage.setItem(KEY, id)
  }
  return id
}
