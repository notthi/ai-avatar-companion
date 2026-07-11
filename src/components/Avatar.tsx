import type { AppState } from '../types'

export function Avatar({ state }: { state: AppState }) {
  const ringClass = state === 'listening'
    ? 'animate-ping bg-red-500/30'
    : state === 'speaking'
    ? 'animate-ping bg-blue-500/20'
    : 'bg-transparent'

  return (
    <div className="relative flex items-center justify-center w-32 h-32">
      <div className={`absolute inset-0 rounded-full ${ringClass}`} />
      <div className={`relative w-28 h-28 rounded-full flex items-center justify-center text-5xl
        ${state === 'listening' ? 'bg-red-500/20 border-2 border-red-400' :
          state === 'speaking' ? 'bg-blue-500/20 border-2 border-blue-400' :
          'bg-[var(--bg-secondary)] border-2 border-[var(--accent)]'}
        transition-all duration-300`}>
        🤖
      </div>
    </div>
  )
}
