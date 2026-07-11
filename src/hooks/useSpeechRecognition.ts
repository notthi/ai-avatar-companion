import { useCallback, useRef, useState } from 'react'

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}

export function useSpeechRecognition(
  onResult: (text: string) => void,
  // 無音タイムアウト等、結果なしで認識が終わったときに呼ばれる(手動stop時は呼ばれない)
  onIdle?: () => void,
  // 認識言語(英会話モードでは 'en-US')
  lang = 'ja-JP',
) {
  const [isListening, setIsListening] = useState(false)
  const [interim, setInterim] = useState('')
  const recRef = useRef<any>(null)
  const stoppedRef = useRef(false)
  const generationRef = useRef(0)
  const onIdleRef = useRef(onIdle)
  onIdleRef.current = onIdle
  const langRef = useRef(lang)
  langRef.current = lang

  const detachHandlers = useCallback((rec: any) => {
    if (!rec) return
    rec.onresult = null
    rec.onerror = null
    rec.onend = null
    rec.onstart = null
    rec.onspeechend = null
    rec.onaudioend = null
    rec.onnomatch = null
  }, [])

  const cleanup = useCallback((rec?: any) => {
    const target = rec ?? recRef.current
    detachHandlers(target)
    if (!rec || rec === recRef.current) {
      recRef.current = null
    }
    setIsListening(false)
    setInterim('')
    // ハンドラーを外した後に明示的に停止してマイクを解放する
    if (target) {
      try {
        target.abort?.()
      } catch {
        try {
          target.stop?.()
        } catch { /* ignore */ }
      }
    }
  }, [detachHandlers])

  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      alert('このブラウザは音声認識に対応していません')
      return
    }

    if (recRef.current) {
      try {
        detachHandlers(recRef.current)
        recRef.current.abort?.()
      } catch {
        // ignore stale recognizer cleanup errors
      }
      recRef.current = null
    }

    stoppedRef.current = false
    generationRef.current += 1
    const currentGeneration = generationRef.current

    const rec = new SR()
    rec.lang = langRef.current
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1
    recRef.current = rec

    rec.onresult = (e: SpeechRecognitionEvent) => {
      if (stoppedRef.current || currentGeneration !== generationRef.current || rec !== recRef.current) return

      let interimText = ''
      let finalText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else interimText += t
      }

      if (stoppedRef.current || currentGeneration !== generationRef.current || rec !== recRef.current) return
      setInterim(interimText)

      if (finalText) {
        stoppedRef.current = true
        generationRef.current += 1
        cleanup(rec)
        onResult(finalText)
      }
    }

    rec.onerror = () => {
      if (currentGeneration !== generationRef.current && rec !== recRef.current) return
      const noResult = !stoppedRef.current
      cleanup(rec)
      if (noResult) onIdleRef.current?.()
    }

    rec.onend = () => {
      // 最終結果が出た場合はハンドラーが外れているためここには来ない=結果なし終了
      const noResult = !stoppedRef.current
      cleanup(rec)
      if (noResult) onIdleRef.current?.()
    }

    rec.start()
    setIsListening(true)
  }, [cleanup, detachHandlers, onResult])

  const stop = useCallback(() => {
    stoppedRef.current = true
    generationRef.current += 1
    setInterim('')
    setIsListening(false)

    const rec = recRef.current
    recRef.current = null

    if (rec) {
      detachHandlers(rec)
      try {
        rec.abort?.()
      } catch {
        try {
          rec.stop?.()
        } catch {
          // ignore stop errors
        }
      }
    }
  }, [detachHandlers])

  return { isListening, interim, start, stop }
}
