import { useState, useCallback } from 'react'
import type { ChatMessage } from '../types'

const STORAGE_KEY = 'voice-assistant-history'
const MAX_MESSAGES = 20

function load(): ChatMessage[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

export function useChatHistory() {
  const [messages, setMessages] = useState<ChatMessage[]>(load)

  const addMessage = useCallback((role: ChatMessage['role'], text: string) => {
    setMessages(prev => {
      const next = [...prev, { role, text, timestamp: Date.now() }].slice(-MAX_MESSAGES)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setMessages([])
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  return { messages, addMessage, clear }
}
