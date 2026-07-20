import { useCallback, useMemo, useRef, useState } from 'react'
import type { AppState } from './types'
import { VrmAvatar } from './components/VrmAvatar'
import type { EmotionName, PokePattern, PokeZone } from './components/VrmAvatar'
import { MicButton } from './components/MicButton'
import { ChatHistory } from './components/ChatHistory'
import { WaveAnimation } from './components/WaveAnimation'
import { useSpeechRecognition } from './hooks/useSpeechRecognition'
import { useVoicevoxTTS } from './hooks/useVoicevoxTTS'
import { useWakeLock } from './hooks/useWakeLock'
import { useChatHistory } from './hooks/useChatHistory'
import { sendChat, sendChatStream } from './lib/chatApi'
import type { ChatLevel, ChatMode } from './lib/chatApi'
import { getSessionId } from './lib/session'

const READY_TEXT = 'タップして話しかけてください'

// 開いたときの時間帯挨拶(音声はまだ再生できないのでテキストのみ)
function greetingText(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 11) return 'おはよう☀ 今日もよろしくね'
  if (h >= 11 && h < 17) return 'こんにちは!なにか話す?'
  if (h >= 17 && h < 23) return 'こんばんは。今日はどんな一日だった?'
  return 'こんな時間まで起きてるの?夜更かしさんだね🌙'
}

// これを言ったら連続会話を終了する
const GOODBYE_WORDS = ['じゃあね', 'またね', 'バイバイ', 'ばいばい', 'おしまい', '終了', 'おやすみ']
// 連続会話で自動的にマイクを再開したあと、無音のまま聞き直しを続ける最大時間(ms)
const CONTINUOUS_LISTEN_MS = 30000
const GOODBYE_WORDS_EN = ['bye', 'goodbye', 'see you', 'good night']

// 英会話モード: off=日本語 / correct=添削あり / only=英語のみ
type EnglishMode = 'off' | 'correct' | 'only'
// 英会話レベル: beginner=初級(中学単語) / advanced=上級(ビジネス)
type EnglishLevel = 'beginner' | 'advanced'
const EN_LEVEL_LABEL: Record<EnglishLevel, string> = { beginner: '初級', advanced: '上級' }

function engButtonLabel(mode: EnglishMode, level: EnglishLevel): string {
  if (mode === 'off') return '🇬🇧 英会話'
  return `🇬🇧 ${mode === 'correct' ? '添削あり' : '英語のみ'}・${EN_LEVEL_LABEL[level]}`
}

// 返答テキストから感情をざっくり推定(キーワード/絵文字ベース)
function detectEmotion(text: string): EmotionName | null {
  const count = (patterns: RegExp) => (text.match(patterns) || []).length
  const happy = count(/嬉し|楽し|うれし|たのし|やった|いいね|好き|最高|わーい|えへへ|ありがと|😊|😄|🎉|♪|笑/g)
  const sad = count(/ごめん|残念|悲し|かなし|つら|辛|寂し|さみし|泣|😢|😭|申し訳/g)
  const angry = count(/怒|ぷんぷん|むかつ|ひどい|💢/g)
  const surprised = count(/びっくり|驚|えっ|まさか|すごい|!\?|⁉|😲/g)
  const max = Math.max(happy, sad, angry, surprised)
  if (max === 0) return null
  if (max === happy) return 'happy'
  if (max === sad) return 'sad'
  if (max === angry) return 'angry'
  return 'surprised'
}

// タップ反応の音声(待機中のみ再生。パターンごとに複数からランダム)
const POKE_LINES: Record<PokePattern, string[]> = {
  blush: ['えへへ、なでなで?', 'ちょっと照れるなあ'],
  relaxed: ['んー、きもちいい', 'えへへ、ありがと'],
  surprised: ['わっ、びっくりした!', 'きゃっ!?なになに?'],
  tickle: ['くすぐったいよー', 'あはは、やめてよー'],
  angry: ['もう、いたずらしないの', 'ぷんぷん'],
}

// 文の区切りでテキストを分割(完成した文の配列と、未完の残りを返す)。
// 半角の .!? は直後が空白等のときだけ文末扱い(小数点や省略形で切らない)
function splitSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let cur = ''
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]
    cur += ch
    const hardEnd = '。！？\n'.includes(ch)
    const softEnd = '.!?'.includes(ch) && i + 1 < buf.length && /[\s」』)"']/.test(buf[i + 1])
    if (hardEnd || softEnd) {
      if (cur.trim()) sentences.push(cur)
      cur = ''
    }
  }
  return { sentences, rest: cur }
}

export default function App() {
  const [state, setState] = useState<AppState>('idle')
  const [statusText, setStatusText] = useState(greetingText)
  const [errorText, setErrorText] = useState('')
  const [spinSignal, setSpinSignal] = useState(0)
  const [dancing, setDancing] = useState(false)
  const [textMode, setTextMode] = useState(false)
  const [draft, setDraft] = useState('')
  const [emotion, setEmotion] = useState<EmotionName | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showEngMenu, setShowEngMenu] = useState(false)
  const [engMode, setEngMode] = useState<EnglishMode>(() => {
    const m = localStorage.getItem('english-mode')
    return m === 'correct' || m === 'only' ? m : 'off'
  })
  const engModeRef = useRef(engMode)
  engModeRef.current = engMode
  const selectEngMode = useCallback((m: EnglishMode) => {
    setEngMode(m)
    localStorage.setItem('english-mode', m) // TTSフックも参照する
    setShowEngMenu(false)
  }, [])
  const [engLevel, setEngLevel] = useState<EnglishLevel>(() =>
    localStorage.getItem('english-level') === 'advanced' ? 'advanced' : 'beginner',
  )
  const engLevelRef = useRef(engLevel)
  engLevelRef.current = engLevel
  const selectEngLevel = useCallback((l: EnglishLevel) => {
    setEngLevel(l)
    localStorage.setItem('english-level', l)
  }, [])
  const [voiceSpeed, setVoiceSpeed] = useState(() => {
    const v = Number(localStorage.getItem('voice-speed'))
    return v >= 0.5 && v <= 2 ? v : 1.1
  })
  const stateNowRef = useRef(state)
  stateNowRef.current = state
  // 連続会話: 返答の再生が終わったら自動でマイクを再開するか
  const autoListenRef = useRef(false)
  const startRecRef = useRef<() => void>(() => {})
  // 連続会話での聞き直し猶予: ブラウザは無音が続くと数秒で認識を打ち切るため、
  // 猶予内なら黙って認識を再起動して聞き続ける(終了ボタンを押すまで最大30秒待つ)
  const continuousActiveRef = useRef(false)
  const continuousDeadlineRef = useRef(0)
  const { messages, addMessage } = useChatHistory()
  const sessionId = useMemo(() => getSessionId(), [])

  useWakeLock()

  const {
    speak,
    stop: stopTTS,
    unlock: unlockTTS,
    getLevel,
    getSpeaking,
    beginStream,
    pushSentence,
    finishStream,
  } = useVoicevoxTTS(
    useCallback(() => {
      setEmotion(null)
      // 連続会話: 音声で話しかけた会話なら、返答後に自動でマイクを再開する
      if (autoListenRef.current) {
        autoListenRef.current = false
        continuousActiveRef.current = true
        continuousDeadlineRef.current = Date.now() + CONTINUOUS_LISTEN_MS
        startRecRef.current()
        setState('listening')
        setStatusText('聞いています...')
        return
      }
      setState('idle')
      setStatusText(READY_TEXT)
    }, []),
  )

  const submitText = useCallback(
    async (text: string, viaVoice = false) => {
      setErrorText('')
      setState('processing')
      setStatusText('アイに聞いています...')
      addMessage('user', text)
      const english = engModeRef.current !== 'off'
      const chatMode: ChatMode = engModeRef.current === 'correct' ? 'en-correct' : engModeRef.current === 'only' ? 'en-only' : undefined
      const chatLevel: ChatLevel = english ? engLevelRef.current : undefined
      // 音声起点の会話なら返答後に自動でマイク再開(さよなら系ワードで終了)
      const saidGoodbye =
        GOODBYE_WORDS.some((w) => text.includes(w)) ||
        (english && GOODBYE_WORDS_EN.some((w) => text.toLowerCase().includes(w)))
      autoListenRef.current = viaVoice && !saidGoodbye

      // 返答を待つ間は 'processing' のまま(アバターが考える仕草をする)。
      // 音声で埋めるのではなく、最初の一文が届いた時点で 'speaking' に切り替えて喋り始める。
      beginStream()

      // ストリーミング: 文が完成するたびにTTSへ流し、全文を待たずに喋り始める
      try {
        let acc = ''
        let buffer = ''
        let spoke = false
        const flush = (sentence: string) => {
          if (!sentence.trim()) return
          if (!spoke) {
            spoke = true
            setState('speaking')
          }
          pushSentence(sentence)
        }
        const full = await sendChatStream(text, sessionId, (delta) => {
          acc += delta
          buffer += delta
          const { sentences, rest } = splitSentences(buffer)
          buffer = rest
          sentences.forEach(flush)
          setStatusText(acc)
          setEmotion(detectEmotion(acc))
        }, chatMode, chatLevel)
        flush(buffer)
        finishStream()

        const reply = full || '返答が空でした。設定を確認してください。'
        addMessage('assistant', reply)
        setStatusText(reply)
        return
      } catch {
        // ストリーミング経路が使えない場合は従来の一括方式へフォールバック
      }

      try {
        const response = await sendChat(text, sessionId, chatMode, chatLevel)
        const reply = response || '返答が空でした。設定を確認してください。'
        addMessage('assistant', reply)
        setStatusText(reply)
        // 文単位でキュー再生
        const { sentences, rest } = splitSentences(reply)
        const toSpeak = [...sentences, rest].filter((s) => s.trim())
        if (toSpeak.length) setState('speaking')
        toSpeak.forEach((s) => pushSentence(s))
        finishStream()
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        autoListenRef.current = false // エラー時はマイク自動再開しない
        continuousActiveRef.current = false
        stopTTS() // 再生中なら止める(state/文言はonEndでリセットされる)
        setErrorText(message)
        addMessage('assistant', `エラー: ${message}`)
      }
    },
    [addMessage, beginStream, finishStream, pushSentence, sessionId, stopTTS],
  )

  // 認識確定後すぐ送信(確認ステップなし)。音声起点なので連続会話の対象
  const handleResult = useCallback(
    (text: string) => {
      setErrorText('')
      continuousActiveRef.current = false // 発話を受け取れたので聞き直しループは終了
      const trimmed = text.trim()
      if (!trimmed) {
        setState('idle')
        setStatusText(READY_TEXT)
        return
      }
      void submitText(trimmed, true)
    },
    [submitText],
  )

  // 無音等で認識が終了した(結果なし)。
  // 連続会話の聞き直し猶予(30秒)内なら、黙って認識を再起動して聞き続ける。
  // 猶予を過ぎたら会話を自然に終える。
  const handleRecIdle = useCallback(() => {
    if (continuousActiveRef.current && Date.now() < continuousDeadlineRef.current) {
      startRecRef.current()
      return
    }
    continuousActiveRef.current = false
    autoListenRef.current = false
    if (stateNowRef.current === 'listening') {
      setState('idle')
      setStatusText(READY_TEXT)
    }
  }, [])

  const { isListening, interim, start, stop } = useSpeechRecognition(
    handleResult,
    handleRecIdle,
    engMode === 'off' ? 'ja-JP' : 'en-US',
  )
  startRecRef.current = start

  const handleMicTap = useCallback(() => {
    setErrorText('')
    if (state === 'speaking') {
      autoListenRef.current = false // 手動停止時はマイク自動再開しない
      continuousActiveRef.current = false
      stopTTS()
      return
    }

    if (isListening) {
      // 終了ボタン: 連続会話の聞き直しループもここで止める
      continuousActiveRef.current = false
      stop()
      setState('idle')
      setStatusText(READY_TEXT)
      return
    }

    // 新規に会話を始めるタップ。前の連続会話の聞き直し猶予が残っていれば破棄する
    continuousActiveRef.current = false
    // iOSの音声再生ブロック対策: ユーザー操作中に事前解放
    unlockTTS()
    start()
    setState('listening')
    setStatusText('聞いています...')
    setDancing(false) // 会話開始時はダンスを止める
    setSpinSignal((n) => n + 1) // くるっと一回転
  }, [isListening, start, state, stop, stopTTS, unlockTTS])

  // キャラをタップしたとき: 待機中ならひとこと反応する(会話中は動きだけ)
  const handlePoke = useCallback(
    (_zone: PokeZone, pattern: PokePattern) => {
      if (state !== 'idle') return
      const lines = POKE_LINES[pattern]
      const line = lines[Math.floor(Math.random() * lines.length)]
      unlockTTS()
      setState('speaking')
      setStatusText(line)
      void speak(line)
    },
    [speak, state, unlockTTS],
  )

  // 認識中に「送信」: 今認識できているテキストを確定して送信
  const handleSend = useCallback(() => {
    const text = interim.trim()
    if (!text) return
    stop()
    void submitText(text)
  }, [interim, stop, submitText])

  // 文字入力からの送信(喋れない場所向け)。返答は通常どおり音声+口パクで再生される
  const handleTextSend = useCallback(() => {
    const text = draft.trim()
    if (!text || state !== 'idle') return
    unlockTTS() // ユーザー操作中に音声再生を解放(モバイルの自動再生制限対策)
    setDraft('')
    setTextMode(false)
    void submitText(text)
  }, [draft, state, submitText, unlockTTS])

  return (
    <div
      className="app-root min-h-dvh flex flex-col items-center justify-between pb-6 px-4"
      style={{ background: 'var(--bg-primary)' }}
    >
      <div className="flex flex-col items-center gap-1 w-full">
        <VrmAvatar
          state={state}
          getLevel={getLevel}
          getSpeaking={getSpeaking}
          emotion={emotion}
          spinSignal={spinSignal}
          dancing={dancing}
          onPoke={handlePoke}
        />
        <h1 className="text-xl font-bold tracking-wide">アイ</h1>
      </div>

      <div className="flex flex-col items-center gap-3 flex-1 justify-center w-full min-h-0">
        {state === 'listening' && <WaveAnimation />}
        <p className="text-base text-center text-[var(--text-secondary)] max-w-sm leading-relaxed px-2 overflow-y-auto max-h-32">
          {interim || statusText}
        </p>

        {state === 'listening' && (
          <button
            onClick={handleSend}
            disabled={!interim.trim()}
            className={`rounded-full px-6 py-2.5 text-sm font-semibold transition-all active:scale-95
              ${interim.trim()
                ? 'bg-[var(--accent)] text-white shadow-lg shadow-[var(--accent)]/40'
                : 'bg-gray-600/40 text-gray-400 cursor-not-allowed'}`}
          >
            送信 ➤
          </button>
        )}

        {errorText && (
          <div className="max-w-md rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            <div className="font-semibold mb-1">接続エラー</div>
            <div className="opacity-90 break-words">{errorText}</div>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-4 w-full">
        <ChatHistory messages={messages} />
        {state === 'idle' && textMode && (
          <form
            onSubmit={(e) => { e.preventDefault(); handleTextSend() }}
            className="flex items-center gap-2 w-full max-w-sm px-4"
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="メッセージを入力..."
              className="flex-1 min-w-0 rounded-full bg-white/10 border border-white/20 px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-secondary)]"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className={`rounded-full px-4 py-2.5 text-sm font-semibold transition-all active:scale-95 shrink-0
                ${draft.trim()
                  ? 'bg-[var(--accent)] text-white shadow-lg shadow-[var(--accent)]/40'
                  : 'bg-gray-600/40 text-gray-400 cursor-not-allowed'}`}
            >
              ➤
            </button>
            <button
              type="button"
              onClick={() => { setTextMode(false); setDraft('') }}
              className="rounded-full w-9 h-9 shrink-0 bg-white/10 text-[var(--text-secondary)] hover:bg-white/20 text-sm"
            >
              ✕
            </button>
          </form>
        )}
        {state === 'idle' && showSettings && (
          <div className="flex flex-col items-center gap-1 w-full max-w-sm px-4">
            <div className="flex items-center gap-3 w-full text-sm text-[var(--text-secondary)]">
              <span className="shrink-0">話速 {voiceSpeed.toFixed(1)}</span>
              <input
                type="range"
                min={0.8}
                max={1.6}
                step={0.1}
                value={voiceSpeed}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setVoiceSpeed(v)
                  localStorage.setItem('voice-speed', String(v))
                }}
                className="flex-1 accent-[var(--accent)]"
              />
              <button
                onClick={() => setShowSettings(false)}
                className="rounded-full w-9 h-9 shrink-0 bg-white/10 hover:bg-white/20 text-sm"
              >
                ✕
              </button>
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] opacity-50">
              ビルド: {__BUILD_TIME__}
            </p>
          </div>
        )}
        {state === 'idle' && showEngMenu && (
          <div className="flex flex-col items-center gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-secondary)] opacity-60">レベル</span>
              <button
                onClick={() => selectEngLevel('beginner')}
                className={`rounded-full px-4 py-2 font-semibold transition-all active:scale-95
                  ${engLevel === 'beginner' ? 'bg-[var(--highlight)] text-white' : 'bg-white/10 text-[var(--text-secondary)] hover:bg-white/20'}`}
              >
                初級(中学単語)
              </button>
              <button
                onClick={() => selectEngLevel('advanced')}
                className={`rounded-full px-4 py-2 font-semibold transition-all active:scale-95
                  ${engLevel === 'advanced' ? 'bg-[var(--highlight)] text-white' : 'bg-white/10 text-[var(--text-secondary)] hover:bg-white/20'}`}
              >
                上級(ビジネス)
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => selectEngMode('correct')}
                className={`rounded-full px-4 py-2 font-semibold transition-all active:scale-95
                  ${engMode === 'correct' ? 'bg-[var(--accent)] text-white' : 'bg-white/10 text-[var(--text-secondary)] hover:bg-white/20'}`}
              >
                添削あり
              </button>
              <button
                onClick={() => selectEngMode('only')}
                className={`rounded-full px-4 py-2 font-semibold transition-all active:scale-95
                  ${engMode === 'only' ? 'bg-[var(--accent)] text-white' : 'bg-white/10 text-[var(--text-secondary)] hover:bg-white/20'}`}
              >
                英語のみ
              </button>
              <button
                onClick={() => selectEngMode('off')}
                className="rounded-full px-4 py-2 font-semibold transition-all active:scale-95 bg-white/10 text-[var(--text-secondary)] hover:bg-white/20"
              >
                日本語に戻る
              </button>
              <button
                onClick={() => setShowEngMenu(false)}
                className="rounded-full w-9 h-9 shrink-0 bg-white/10 text-[var(--text-secondary)] hover:bg-white/20"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {(state === 'idle' || dancing) && !textMode && !showSettings && !showEngMenu && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowEngMenu(true)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-all active:scale-95
                ${engMode !== 'off'
                  ? 'bg-[var(--accent)] text-white shadow-lg shadow-[var(--accent)]/40'
                  : 'bg-white/10 text-[var(--text-secondary)] hover:bg-white/20'}`}
            >
              {engButtonLabel(engMode, engLevel)}
            </button>
            <button
              onClick={() => setTextMode(true)}
              className="rounded-full px-4 py-2 text-sm font-semibold transition-all active:scale-95 bg-white/10 text-[var(--text-secondary)] hover:bg-white/20"
            >
              💬 文字
            </button>
            <button
              onClick={() => setDancing((v) => !v)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-all active:scale-95
                ${dancing
                  ? 'bg-[var(--highlight)] text-white shadow-lg shadow-[var(--highlight)]/40'
                  : 'bg-white/10 text-[var(--text-secondary)] hover:bg-white/20'}`}
            >
              {dancing ? '⏸ とまる' : '💃 踊る'}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-full w-9 h-9 text-base transition-all active:scale-95 bg-white/10 text-[var(--text-secondary)] hover:bg-white/20"
            >
              ⚙
            </button>
          </div>
        )}
        <MicButton state={state} onTap={handleMicTap} />
        <p className="text-xs text-[var(--text-secondary)] opacity-40">
          {state === 'idle'
            ? 'マイクをタップ'
            : state === 'listening'
              ? '話してください(話し終わると自動送信)'
              : state === 'processing'
                ? '考え中...'
                : '再生中(タップで停止)'}
        </p>
      </div>
    </div>
  )
}
