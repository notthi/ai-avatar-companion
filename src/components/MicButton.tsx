import type { AppState } from '../types'

interface Props {
  state: AppState
  onTap: () => void
}

export function MicButton({ state, onTap }: Props) {
  const isActive = state === 'listening' || state === 'speaking'
  const isDisabled = state === 'processing'

  return (
    <button
      onClick={onTap}
      disabled={isDisabled}
      className={`relative w-24 h-24 rounded-full flex items-center justify-center text-4xl
        transition-all duration-200 active:scale-95
        ${isActive
          ? 'bg-red-500 shadow-lg shadow-red-500/50'
          : isDisabled
          ? 'bg-gray-600 opacity-50 cursor-not-allowed'
          : 'bg-[var(--accent)] hover:bg-[var(--highlight)] shadow-lg shadow-[var(--accent)]/50'}
      `}
    >
      {isActive && (
        <span className="absolute inset-0 rounded-full bg-red-500 opacity-40"
          style={{ animation: 'pulse-ring 1.2s ease-out infinite' }} />
      )}
      <span className="relative z-10">
        {isActive ? '⏹' : state === 'processing' ? '⏳' : '🎤'}
      </span>
    </button>
  )
}
