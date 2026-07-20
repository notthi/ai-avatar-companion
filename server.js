import 'dotenv/config' // .env があれば読み込む(Windows/Mac共通)
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const port = process.env.PORT || 8787
// 接続先エージェントの種類: 'openclaw' | 'hermes'(どちらもOpenAI互換の /v1/chat/completions)
const gatewayKind = (process.env.GATEWAY_KIND || 'openclaw').toLowerCase()
const gatewayUrl =
  process.env.GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  (gatewayKind === 'hermes' ? 'http://127.0.0.1:8643' : 'http://127.0.0.1:18789')
const gatewayToken = process.env.GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || ''
const agentId = process.env.OPENCLAW_AGENT_ID || 'main'
// 会話文脈のセッション。openclaw: agent:line:main 等 / hermes: 任意の識別子
const sessionKey =
  process.env.SESSION_KEY ||
  process.env.OPENCLAW_SESSION_KEY ||
  (gatewayKind === 'hermes' ? 'voice-assistant' : 'agent:line:main')
// チャット時のmodel指定(hermesは任意名でOK、openclawは openclaw:<agentId>)
const gatewayModel =
  process.env.GATEWAY_MODEL || (gatewayKind === 'hermes' ? 'hermes' : `openclaw:${agentId}`)

// エージェント種別ごとの認証・セッションヘッダ
function agentHeaders(session = sessionKey) {
  const base = {
    Authorization: `Bearer ${gatewayToken}`,
    'Content-Type': 'application/json',
  }
  if (gatewayKind === 'hermes') {
    return { ...base, 'X-Hermes-Session-Id': session, 'X-Hermes-Session-Key': session }
  }
  return { ...base, 'x-openclaw-agent-id': agentId, 'x-openclaw-session-key': session }
}

// 英会話モードの役割指示。日本語会話とはセッションを分ける
const EN_CORRECT_PROMPT =
  'You are a friendly English conversation partner helping a Japanese learner practice speaking. ' +
  'Reply in natural English (2-3 short sentences), and keep the conversation going with a question when it fits. ' +
  "If the learner's English contains a mistake, first add ONE short correction line in Japanese starting with 「💡」, then reply in English. " +
  'If there is no mistake, just reply in English.'
const EN_ONLY_PROMPT =
  'You are a friendly English conversation partner. Reply only in natural English (2-3 short sentences), ' +
  'and keep the conversation going with a question when it fits. Never use Japanese.'
// レベル別の語彙・難易度指示
const EN_LEVEL = {
  beginner:
    ' Use only simple everyday words a Japanese junior-high student would know (CEFR A1-A2). Keep sentences very short and clear.',
  advanced:
    ' Use natural business-level English (CEFR B2-C1) with idiomatic and professional expressions, as if chatting with a coworker.',
}

// mode: undefined | 'en-correct' | 'en-only' / level: 'beginner' | 'advanced'
function chatRequest(text, mode, level, stream) {
  const en = mode === 'en-correct' || mode === 'en-only'
  const session = en ? `${sessionKey}-en` : sessionKey
  const messages = []
  if (en) {
    const base = mode === 'en-correct' ? EN_CORRECT_PROMPT : EN_ONLY_PROMPT
    messages.push({ role: 'system', content: base + (EN_LEVEL[level] || EN_LEVEL.beginner) })
  }
  messages.push({ role: 'user', content: text })
  return {
    headers: agentHeaders(session),
    body: JSON.stringify({ model: gatewayModel, user: session, ...(stream ? { stream: true } : {}), messages }),
  }
}
const staticDir = path.join(__dirname, 'firebase-dist')
const voicevoxUrl = (process.env.VOICEVOX_URL || 'http://127.0.0.1:50021').replace(/\/$/, '')
const voicevoxSpeaker = Number(process.env.VOICEVOX_SPEAKER || 8) // 8 = 春日部つむぎ
const voicevoxSpeed = Number(process.env.VOICEVOX_SPEED || 1.1)

app.use(express.json({ limit: '1mb' }))

// 合成結果のキャッシュ(LRU)。相づち・つなぎ等の定型文は2回目以降0msで返る
const ttsCache = new Map()
const TTS_CACHE_MAX = 100

// VOICEVOXでテキストをwav化(audio_query → synthesis)。失敗時はthrow
async function synthesize(text, speaker, speed) {
  const key = `${speaker}|${speed}|${text}`
  const hit = ttsCache.get(key)
  if (hit) {
    ttsCache.delete(key)
    ttsCache.set(key, hit) // 使ったものを末尾へ(LRU)
    return hit
  }
  const qRes = await fetch(
    `${voicevoxUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: 'POST' },
  )
  if (!qRes.ok) throw new Error(`VOICEVOX audio_query failed: ${await qRes.text()}`)
  const query = await qRes.json()
  query.speedScale = speed
  const sRes = await fetch(`${voicevoxUrl}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  })
  if (!sRes.ok) throw new Error(`VOICEVOX synthesis failed: ${await sRes.text()}`)
  const wav = Buffer.from(await sRes.arrayBuffer())
  ttsCache.set(key, wav)
  if (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value)
  return wav
}

app.post('/api/tts', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'text is required' })

    const speaker = Number(req.body?.speaker || voicevoxSpeaker)
    // アプリからの話速指定(0.5〜2.0)。無ければ.envのデフォルト
    const reqSpeed = Number(req.body?.speed)
    const speed = reqSpeed >= 0.5 && reqSpeed <= 2 ? reqSpeed : voicevoxSpeed
    const wav = await synthesize(text, speaker, speed)
    res.set('Content-Type', 'audio/wav').send(wav)
  } catch (error) {
    // VOICEVOX未起動など。フロントはOS標準TTSにフォールバックする
    return res.status(502).json({ error: 'tts proxy failed', detail: String(error?.message || error) })
  }
})

app.post('/api/chat', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim()

    if (!text) return res.status(400).json({ error: 'text is required' })
    if (!gatewayToken) {
      return res.status(503).json({
        error: 'GATEWAY_TOKEN is not set',
        detail: 'Set GATEWAY_KIND / GATEWAY_URL / GATEWAY_TOKEN in .env before starting serve:lan',
      })
    }

    const endpoint = `${gatewayUrl.replace(/\/$/, '')}/v1/chat/completions`
    const { headers, body } = chatRequest(text, req.body?.mode, req.body?.level, false)
    const ocRes = await fetch(endpoint, { method: 'POST', headers, body })

    const raw = await ocRes.text()
    if (!ocRes.ok) {
      return res.status(ocRes.status).json({ error: `${gatewayKind} request failed`, detail: raw })
    }

    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return res.status(502).json({ error: `Invalid JSON from ${gatewayKind}`, detail: raw })
    }

    const reply = data?.choices?.[0]?.message?.content || ''
    return res.json({ text: reply, raw: data })
  } catch (error) {
    return res.status(500).json({ error: 'chat proxy failed', detail: String(error?.message || error) })
  }
})

// ストリーミング版: GatewayのSSEをそのまま中継する。
// 全文を待たずに文単位でTTSを始められるので体感遅延が縮む。
// Gatewayがstream未対応でJSONを返した場合はJSONのまま返す(フロント側で吸収)。
app.post('/api/chat-stream', async (req, res) => {
  const ac = new AbortController()
  // クライアントが途中で切断したらupstreamも中断(送信完了後のcloseでは中断しない)
  res.on('close', () => { if (!res.writableEnded) ac.abort() })
  try {
    const text = String(req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'text is required' })
    if (!gatewayToken) {
      return res.status(503).json({ error: 'GATEWAY_TOKEN is not set' })
    }

    const endpoint = `${gatewayUrl.replace(/\/$/, '')}/v1/chat/completions`
    const t0 = Date.now()
    const { headers, body } = chatRequest(text, req.body?.mode, req.body?.level, true)
    const ocRes = await fetch(endpoint, { method: 'POST', signal: ac.signal, headers, body })

    if (!ocRes.ok) {
      const raw = await ocRes.text()
      return res.status(ocRes.status).json({ error: `${gatewayKind} request failed`, detail: raw })
    }

    const contentType = ocRes.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      // stream未対応のGateway: 通常のJSON応答に変換して返す
      const raw = await ocRes.text()
      console.log(`[chat-stream] gateway returned non-SSE (${contentType}), total ${Date.now() - t0}ms`)
      try {
        const data = JSON.parse(raw)
        return res.json({ text: data?.choices?.[0]?.message?.content || '', raw: data })
      } catch {
        return res.status(502).json({ error: `Invalid JSON from ${gatewayKind}`, detail: raw })
      }
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders()

    let first = true
    for await (const chunk of ocRes.body) {
      if (first) {
        console.log(`[chat-stream] TTFT ${Date.now() - t0}ms`)
        first = false
      }
      res.write(chunk)
    }
    console.log(`[chat-stream] total ${Date.now() - t0}ms`)
    res.end()
  } catch (error) {
    if (ac.signal.aborted) return // クライアント切断は正常系
    if (!res.headersSent) {
      return res.status(500).json({ error: 'chat stream proxy failed', detail: String(error?.message || error) })
    }
    res.end()
  }
})

app.use(express.static(staticDir))
app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')))

// 起動時ウォームアップ:
//  1. 話者モデルを事前初期化(エンジン起動後の初回合成が数秒かかるのを防ぐ)
//  2. よく使う定型文(タップ反応のセリフ)を事前合成してキャッシュ
//  ※フレーズはフロント(src/App.tsx の POKE_LINES)と同期しておくこと
const PREWARM_TEXTS = [
  'えへへ、なでなで?', 'ちょっと照れるなあ',
  'んー、きもちいい', 'えへへ、ありがと',
  'わっ、びっくりした!', 'きゃっ!?なになに?',
  'くすぐったいよー', 'あはは、やめてよー',
  'もう、いたずらしないの', 'ぷんぷん',
]
async function warmupVoicevox() {
  try {
    const t0 = Date.now()
    await fetch(`${voicevoxUrl}/initialize_speaker?speaker=${voicevoxSpeaker}&skip_reinit=true`, {
      method: 'POST',
    })
    for (const text of PREWARM_TEXTS) {
      await synthesize(text, voicevoxSpeaker, voicevoxSpeed)
    }
    console.log(`VOICEVOX warmup done: speaker ${voicevoxSpeaker} + ${PREWARM_TEXTS.length} phrases cached (${Date.now() - t0}ms)`)
  } catch (error) {
    console.warn(`VOICEVOX warmup skipped: ${String(error?.message || error)}`)
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`voice-assistant LAN server listening on http://0.0.0.0:${port}`)
  console.log(`agent: ${gatewayKind} at ${gatewayUrl} (model: ${gatewayModel}, session: ${sessionKey})`)
  console.log(`VOICEVOX at ${voicevoxUrl} (speaker: ${voicevoxSpeaker}, speed: ${voicevoxSpeed})`)
  if (!gatewayToken) console.warn('⚠ GATEWAY_TOKEN 未設定 — .env を用意してください')
  void warmupVoicevox()
})
