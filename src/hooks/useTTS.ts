import { useCallback, useRef, useState } from 'react'

export function useTTS(onEnd: () => void) {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const stoppedRef = useRef(false)

  // iOSはユーザー操作外からのspeechSynthesis.speak()をブロックする。
  // ユーザー操作のタイミングでこの関数を呼ぶことで事前に解放しておく。
  const unlock = useCallback(() => {
    const silent = new SpeechSynthesisUtterance('')
    speechSynthesis.speak(silent)
    speechSynthesis.cancel()
  }, [])

  const speak = useCallback((text: string) => {
    stoppedRef.current = false
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ja-JP'
    u.rate = 1.08
    u.onstart = () => setIsSpeaking(true)
    u.onend = () => { setIsSpeaking(false); onEnd() }
    u.onerror = () => {
      setIsSpeaking(false)
      if (!stoppedRef.current) onEnd()
    }
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  }, [onEnd])

  const stop = useCallback(() => {
    stoppedRef.current = true
    speechSynthesis.cancel()
    setIsSpeaking(false)
    onEnd()
  }, [onEnd])

  return { isSpeaking, speak, stop, unlock }
}
