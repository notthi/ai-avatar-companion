import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../types'

export function ChatHistory({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  if (messages.length === 0) return null

  return (
    <div className="w-full max-w-md mx-auto mt-6 max-h-60 overflow-y-auto px-4 space-y-3">
      {messages.slice(-10).map((m, i) => (
        <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[80%] px-4 py-2 rounded-2xl text-sm leading-relaxed
            ${m.role === 'user'
              ? 'bg-[var(--accent)] text-white rounded-br-sm'
              : 'bg-[var(--bg-secondary)] text-[var(--text-primary)] rounded-bl-sm'}`}>
            {m.text}
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
