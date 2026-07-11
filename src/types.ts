export type AppState = 'idle' | 'listening' | 'processing' | 'speaking'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

export interface AppError {
  message: string
}
