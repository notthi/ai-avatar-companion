import { useCallback, useRef } from 'react'

// アプリ内設定の話速(localStorage)。未設定ならundefined=サーバー側デフォルト
export function getVoiceSpeed(): number | undefined {
  const v = Number(localStorage.getItem('voice-speed'))
  return v >= 0.5 && v <= 2 ? v : undefined
}

// 日本語を含むか(含む→VOICEVOX、含まない英文→OSの英語音声で読む)
function hasJapanese(text: string): boolean {
  return /[ぁ-んァ-ヶ一-龥ー]/.test(text)
}

// 英会話モード中か(App側が localStorage に保存)
function isEnglishMode(): boolean {
  const m = localStorage.getItem('english-mode')
  return m === 'correct' || m === 'only'
}

// VOICEVOX(/api/tts)で音声再生し、AnalyserNodeで口パク用の音量を取得する。
// /api/tts が失敗した場合はOS標準のspeechSynthesisにフォールバック。
export function useVoicevoxTTS(onEnd: () => void) {
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const stoppedRef = useRef(false)
  // 文単位ストリーミング再生用: 合成(fetch)は push 時に先行開始し、再生はキュー順。
  // buf=null の項目はOSの英語音声(speechSynthesis)で読む
  const queueRef = useRef<{ text: string; buf: Promise<AudioBuffer> | null }[]>([])
  const playingRef = useRef(false)
  const streamDoneRef = useRef(true)
  // 実際に音が鳴っているか(アバターの「喋りモーション」をこれに同期させる)
  const audibleRef = useRef(false)

  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctxRef.current = new Ctx()
      const analyser = ctxRef.current.createAnalyser()
      analyser.fftSize = 512
      analyser.connect(ctxRef.current.destination)
      analyserRef.current = analyser
      dataRef.current = new Uint8Array(analyser.fftSize)
    }
    return ctxRef.current
  }, [])

  // iOS対策: ユーザー操作中に呼んでAudioContext/speechSynthesisを解放しておく
  const unlock = useCallback(() => {
    const ctx = ensureCtx()
    if (ctx.state === 'suspended') void ctx.resume()
    try {
      const silent = new SpeechSynthesisUtterance('')
      speechSynthesis.speak(silent)
      speechSynthesis.cancel()
    } catch { /* ignore */ }
  }, [ensureCtx])

  // 現在の再生音量(0..1程度)。口パク用にrequestAnimationFrame内から呼ぶ
  const getLevel = useCallback(() => {
    const analyser = analyserRef.current
    const data = dataRef.current
    if (!analyser || !data) return 0
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    return Math.sqrt(sum / data.length)
  }, [])

  const speakFallback = useCallback(
    (text: string) => {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ja-JP'
      u.rate = getVoiceSpeed() ?? 1.1
      u.onstart = () => { audibleRef.current = true }
      u.onend = () => { audibleRef.current = false; if (!stoppedRef.current) onEnd() }
      u.onerror = () => { audibleRef.current = false; if (!stoppedRef.current) onEnd() }
      speechSynthesis.cancel()
      speechSynthesis.speak(u)
    },
    [onEnd],
  )

  const speak = useCallback(
    async (text: string) => {
      stoppedRef.current = false
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, speed: getVoiceSpeed() }),
        })
        if (!res.ok) throw new Error(`tts ${res.status}`)
        const buf = await res.arrayBuffer()
        const ctx = ensureCtx()
        if (ctx.state === 'suspended') await ctx.resume()
        const audio = await ctx.decodeAudioData(buf)
        if (stoppedRef.current) return
        const src = ctx.createBufferSource()
        src.buffer = audio
        src.connect(analyserRef.current!)
        src.onended = () => {
          sourceRef.current = null
          audibleRef.current = false
          if (!stoppedRef.current) onEnd()
        }
        sourceRef.current = src
        audibleRef.current = true
        src.start()
      } catch {
        // VOICEVOX未起動などの場合はOS標準TTSで読み上げ
        speakFallback(text)
      }
    },
    [ensureCtx, onEnd, speakFallback],
  )

  // --- 文単位ストリーミング再生 ---

  const fetchAndDecode = useCallback(
    async (text: string): Promise<AudioBuffer> => {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, speed: getVoiceSpeed() }),
      })
      if (!res.ok) throw new Error(`tts ${res.status}`)
      const buf = await res.arrayBuffer()
      const ctx = ensureCtx()
      if (ctx.state === 'suspended') await ctx.resume()
      return ctx.decodeAudioData(buf)
    },
    [ensureCtx],
  )

  const playNext = useCallback(async () => {
    if (playingRef.current || stoppedRef.current) return
    const item = queueRef.current.shift()
    if (!item) {
      if (streamDoneRef.current) onEnd()
      return
    }
    playingRef.current = true

    // 英文: OSの英語音声で読む(VOICEVOXは日本語専用のため)
    if (!item.buf) {
      const u = new SpeechSynthesisUtterance(item.text)
      u.lang = 'en-US'
      u.rate = getVoiceSpeed() ?? 1.0
      u.onstart = () => { audibleRef.current = true }
      const next = () => {
        audibleRef.current = false
        playingRef.current = false
        if (!stoppedRef.current) void playNext()
      }
      u.onend = next
      u.onerror = next
      speechSynthesis.speak(u)
      return
    }

    try {
      const audio = await item.buf
      if (stoppedRef.current) {
        playingRef.current = false
        return
      }
      const ctx = ensureCtx()
      const src = ctx.createBufferSource()
      src.buffer = audio
      src.connect(analyserRef.current!)
      src.onended = () => {
        sourceRef.current = null
        playingRef.current = false
        audibleRef.current = false
        if (!stoppedRef.current) void playNext()
      }
      sourceRef.current = src
      audibleRef.current = true
      src.start()
    } catch {
      // VOICEVOX失敗: 残りをまとめてOS標準TTSで読む
      playingRef.current = false
      if (stoppedRef.current) return
      const rest = [item.text, ...queueRef.current.map((q) => q.text)].join('')
      queueRef.current = []
      streamDoneRef.current = true
      if (rest) speakFallback(rest)
    }
  }, [ensureCtx, onEnd, speakFallback])

  // ストリーミング開始(以降 pushSentence した文を順に喋る)
  const beginStream = useCallback(() => {
    stoppedRef.current = false
    streamDoneRef.current = false
    queueRef.current = []
  }, [])

  // 文を追加。合成は即座に裏で開始し、再生はキュー順(再生中に次を先行合成)。
  // 英会話モード中の英文はOS英語音声(buf=null)、日本語文はVOICEVOXで読む
  const pushSentence = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t || stoppedRef.current) return
      const useOsEnglish = isEnglishMode() && !hasJapanese(t)
      const buf = useOsEnglish ? null : fetchAndDecode(t)
      buf?.catch(() => { /* 再生時にまとめて処理 */ })
      queueRef.current.push({ text: t, buf })
      void playNext()
    },
    [fetchAndDecode, playNext],
  )

  // これ以上文が来ないことを通知(キューが掃けたら onEnd が呼ばれる)
  const finishStream = useCallback(() => {
    streamDoneRef.current = true
    if (!playingRef.current && queueRef.current.length === 0 && !stoppedRef.current) onEnd()
  }, [onEnd])

  const stop = useCallback(() => {
    stoppedRef.current = true
    streamDoneRef.current = true
    queueRef.current = []
    playingRef.current = false
    audibleRef.current = false
    try { sourceRef.current?.stop() } catch { /* ignore */ }
    sourceRef.current = null
    speechSynthesis.cancel()
    onEnd()
  }, [onEnd])

  // 実際に音が鳴っているか(rAF内から呼ぶ想定)
  const getSpeaking = useCallback(() => audibleRef.current, [])

  return { speak, stop, unlock, getLevel, beginStream, pushSentence, finishStream, getSpeaking }
}
