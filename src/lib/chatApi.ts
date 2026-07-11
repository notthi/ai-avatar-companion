// mode: undefined(日本語) | 'en-correct'(英会話・添削あり) | 'en-only'(英語のみ)
export type ChatMode = 'en-correct' | 'en-only' | undefined
// 英会話のレベル(語彙・難易度)
export type ChatLevel = 'beginner' | 'advanced' | undefined

export async function sendChat(text: string, sessionId: string, mode?: ChatMode, level?: ChatLevel) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId, mode, level }),
  })

  const data = await res.json().catch(() => ({}))

  if (!res.ok) {
    throw new Error(data?.detail || data?.error || 'API request failed')
  }

  return String(data?.text || '')
}

// ストリーミング版。差分テキストを onDelta で逐次受け取り、全文を返す。
// サーバーがJSONで返した場合(Gatewayがstream未対応)も透過的に扱う。
export async function sendChatStream(
  text: string,
  sessionId: string,
  onDelta: (delta: string) => void,
  mode?: ChatMode,
  level?: ChatLevel,
): Promise<string> {
  const res = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId, mode, level }),
  })

  const contentType = res.headers.get('content-type') || ''

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.detail || data?.error || 'API request failed')
  }

  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => ({}))
    const full = String(data?.text || '')
    if (full) onDelta(full)
    return full
  }

  if (!res.body) throw new Error('stream body unavailable')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let pending = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const j = JSON.parse(payload)
        const delta: string =
          j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? ''
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        // 部分行・コメント行は無視
      }
    }
  }

  return full
}
