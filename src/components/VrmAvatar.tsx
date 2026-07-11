import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'
import type { AppState } from '../types'
import { Avatar } from './Avatar'

// キャラをタップしたときの反応パターン
export type PokePattern = 'blush' | 'relaxed' | 'surprised' | 'tickle' | 'angry'
export type PokeZone = 'head' | 'body'
// 返答内容に応じた表情
export type EmotionName = 'happy' | 'sad' | 'angry' | 'surprised'

interface Props {
  state: AppState
  // 口パク用: 現在の再生音量(0..1程度)を返す関数
  getLevel: () => number
  // 実際に音声が鳴っているか(喋りモーションをこれに同期させる)
  getSpeaking?: () => boolean
  // 返答の感情(表情に反映。nullで通常)
  emotion?: EmotionName | null
  // 値が変わるたびに1回転スピンする(マイクタップ等のトリガー)
  spinSignal?: number
  // trueの間、簡単なダンスを踊る
  dancing?: boolean
  // キャラがタップされたとき(頭/体・発動パターン)
  onPoke?: (zone: PokeZone, pattern: PokePattern) => void
}

const IDLE_SLEEP_MS = 2 * 60 * 1000 // 放置でうとうとし始めるまでの時間

const SPIN_DUR = 0.8 // スピン所要時間(秒)
const POKE_DUR = 1.5 // タップ反応の長さ(秒)
const POKE_PATTERNS: Record<PokeZone, PokePattern[]> = {
  head: ['blush', 'relaxed', 'surprised'],
  body: ['tickle', 'surprised', 'angry'],
}

// public/avatar.vrm を表示する3Dアバター。
// モデルが無い/読み込めない場合は従来の絵文字Avatarにフォールバック。
export function VrmAvatar({ state, getLevel, getSpeaking, emotion, spinSignal, dancing, onPoke }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state
  const levelRef = useRef(getLevel)
  levelRef.current = getLevel
  const speakingRef = useRef(getSpeaking)
  speakingRef.current = getSpeaking
  const emotionRef = useRef(emotion)
  emotionRef.current = emotion
  const dancingRef = useRef(dancing)
  dancingRef.current = dancing
  const onPokeRef = useRef(onPoke)
  onPokeRef.current = onPoke
  // タップ反応の進行状態
  const pokeRef = useRef<{ pattern: PokePattern; t: number } | null>(null)
  // 感情表情の重み(なめらかに変化させる)
  const emoWeightsRef = useRef({ happy: 0, sad: 0, angry: 0, surprised: 0 })
  // 放置反応: 最後に触れた/会話した時刻と、うとうと度(0..1)
  const lastActiveRef = useRef(Date.now())
  const drowsyRef = useRef(0)
  // ユーザー操作(ドラッグ回転・ピンチ/ホイールズーム)の状態
  const dragRotYRef = useRef(0)
  const baseRotYRef = useRef(0)
  const camDistRef = useRef(1.45)
  // ノリノリ度(0..1)とスピン残り時間(秒)
  const danceRef = useRef(0)
  const spinRemainingRef = useRef(0)
  // スマホの傾きパララックス(-1..1)。targetはセンサー値、currentは表示用に平滑化
  const tiltTargetRef = useRef({ x: 0, y: 0 })
  const tiltRef = useRef({ x: 0, y: 0 })

  // spinSignal が変わったら1回転スピンを開始
  useEffect(() => {
    if (spinSignal) spinRemainingRef.current = SPIN_DUR
  }, [spinSignal])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, mount.clientWidth / mount.clientHeight, 0.1, 20)
    const CAM_Y = 1.35
    const CAM_MIN = 0.7
    const CAM_MAX = 3.0
    camera.position.set(0, CAM_Y, camDistRef.current)
    camera.lookAt(0, CAM_Y, 0)

    const light = new THREE.DirectionalLight(0xffffff, Math.PI)
    light.position.set(1, 1, 1)
    scene.add(light)
    scene.add(new THREE.AmbientLight(0xffffff, 0.7))

    let vrm: VRM | null = null
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMLoaderPlugin(parser))
    loader.load(
      '/avatar.vrm',
      (gltf) => {
        if (disposed) return
        const loaded = gltf.userData.vrm as VRM
        VRMUtils.removeUnnecessaryVertices(gltf.scene)
        VRMUtils.combineSkeletons(gltf.scene)
        VRMUtils.rotateVRM0(loaded)
        loaded.scene.traverse((o) => { o.frustumCulled = false })
        scene.add(loaded.scene)
        if (loaded.lookAt) loaded.lookAt.target = camera
        baseRotYRef.current = loaded.scene.rotation.y
        vrm = loaded
      },
      undefined,
      () => setFailed(true),
    )

    const clock = new THREE.Clock()
    let nextBlink = 1 + Math.random() * 3
    let blinkT = -1
    let mouth = 0
    let raf = 0

    const animate = () => {
      raf = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      const t = clock.elapsedTime

      // 傾きパララックス: カメラが回り込み、視線追従で常にこちらを見ている感じになる
      const tilt = tiltRef.current
      const tiltTarget = tiltTargetRef.current
      tilt.x += (tiltTarget.x - tilt.x) * Math.min(1, delta * 5)
      tilt.y += (tiltTarget.y - tilt.y) * Math.min(1, delta * 5)
      camera.position.set(tilt.x * 0.3, CAM_Y + tilt.y * 0.3, camDistRef.current)
      camera.lookAt(-tilt.x * 0.08, CAM_Y - tilt.y * 0.1, 0)

      if (vrm) {
        // 触れた/会話した時刻を更新(放置判定用)
        if (stateRef.current !== 'idle' || dancingRef.current) lastActiveRef.current = Date.now()
        // うとうと度: 2分間なにもないと1へ、なにかあれば0へ(ゆっくり)
        const drowsyTarget = Date.now() - lastActiveRef.current > IDLE_SLEEP_MS ? 1 : 0
        drowsyRef.current += (drowsyTarget - drowsyRef.current) * Math.min(1, delta * 1.2)
        const drowsy = drowsyRef.current

        // ノリノリ度: 実際に声が鳴っている間 or 踊っている間は1へ、それ以外は0へイージング
        // (音声再生に同期させる。getSpeaking未指定時は従来のstate基準)
        const audible = speakingRef.current ? speakingRef.current() : stateRef.current === 'speaking'
        const danceTarget = (dancingRef.current || audible) ? 1 : 0
        danceRef.current += (danceTarget - danceRef.current) * Math.min(1, delta * 4)
        const dance = danceRef.current
        const beat = t * 6 // リズムの速さ
        // chore: 「踊る」ボタンによる本格的な振り付けの強度(会話中のノリは除外)
        const chore = dancingRef.current ? dance : 0
        const step = t * 2.4 // ステップの速さ(左右)

        // スピン: spinSignalで開始し、0.8秒かけて1回転(easeOutCubic)
        let spinAngle = 0
        if (spinRemainingRef.current > 0) {
          spinRemainingRef.current = Math.max(0, spinRemainingRef.current - delta)
          const p = 1 - spinRemainingRef.current / SPIN_DUR
          spinAngle = (1 - Math.pow(1 - p, 3)) * Math.PI * 2
        }
        // ドラッグ回転 + スピン + ダンス時の左右スイングをY軸に反映
        vrm.scene.rotation.y =
          baseRotYRef.current + dragRotYRef.current + spinAngle + Math.sin(step) * 0.28 * chore
        // 弾み(踊る時はステップで大きめに跳ねる)
        vrm.scene.position.y = Math.abs(Math.sin(beat)) * 0.03 * dance + Math.abs(Math.sin(step * 2)) * 0.05 * chore

        // Tポーズ解消 + ゆらぎ / ノリの腕振り / ダンス時は腕を上げて左右に振る
        const h = vrm.humanoid
        const armL = h.getNormalizedBoneNode('leftUpperArm')
        const armR = h.getNormalizedBoneNode('rightUpperArm')
        const armWave = 0.7 + 0.45 * Math.sin(step * 2) // 上げ幅
        if (armL) armL.rotation.z = -1.15 + Math.sin(t * 1.1) * 0.02 + Math.sin(beat) * 0.18 * dance + armWave * chore
        if (armR) armR.rotation.z = 1.15 - Math.sin(t * 1.1) * 0.02 - Math.sin(beat) * 0.18 * dance - (1.15 - 0.45 * Math.sin(step * 2)) * chore
        const armLlow = h.getNormalizedBoneNode('leftLowerArm')
        const armRlow = h.getNormalizedBoneNode('rightLowerArm')
        if (armLlow) armLlow.rotation.z = -0.6 * chore
        if (armRlow) armRlow.rotation.z = 0.6 * chore
        const spine = h.getNormalizedBoneNode('spine')
        if (spine) {
          spine.rotation.x = Math.sin(t * 1.4) * 0.015 + Math.sin(beat) * 0.03 * dance
          spine.rotation.z = Math.sin(beat * 0.5) * 0.06 * dance + Math.sin(step) * 0.1 * chore
        }
        const hips = h.getNormalizedBoneNode('hips')
        if (hips) {
          hips.rotation.y = Math.sin(beat * 0.5) * 0.12 * dance + Math.sin(step) * 0.14 * chore
          hips.rotation.z = Math.sin(beat) * 0.04 * dance + Math.sin(step) * 0.12 * chore
        }
        const head = h.getNormalizedBoneNode('head')
        if (head) {
          head.rotation.z = Math.sin(t * 0.6) * 0.03 + Math.sin(beat * 0.5) * 0.07 * dance + Math.sin(step) * 0.12 * chore
          head.rotation.x = Math.sin(t * 0.9) * 0.02 + Math.sin(beat) * 0.05 * dance
        }

        // 放置反応: うつむいて背中を丸め、ゆっくり船をこぐ
        if (drowsy > 0.01) {
          if (head) {
            head.rotation.x += 0.16 * drowsy + Math.sin(t * 0.7) * 0.03 * drowsy
            head.rotation.z += Math.sin(t * 0.35) * 0.04 * drowsy
          }
          if (spine) spine.rotation.x += 0.06 * drowsy
        }

        // タップ反応: 立ち上がり0.15秒 → 保持 → 減衰のエンベロープで表情とモーションを重ねる
        let pokeHappy = 0
        let pokeRelaxed = 0
        let pokeSurprised = 0
        let pokeAngry = 0
        const poke = pokeRef.current
        if (poke) {
          poke.t += delta
          if (poke.t >= POKE_DUR) {
            pokeRef.current = null
          } else {
            const env = poke.t < 0.15 ? poke.t / 0.15 : Math.max(0, 1 - (poke.t - 0.7) / (POKE_DUR - 0.7))
            switch (poke.pattern) {
              case 'blush': // 照れ笑い+小首かしげ
                pokeHappy = env
                if (head) head.rotation.z += 0.16 * env
                break
              case 'relaxed': // 目を閉じてにこ〜
                pokeRelaxed = env
                if (head) head.rotation.z -= 0.12 * env
                break
              case 'surprised': // びっくり+小さく跳ねてのけぞる
                pokeSurprised = env
                vrm.scene.position.y += 0.045 * env * Math.max(0, Math.sin(poke.t * 12))
                if (spine) spine.rotation.x -= 0.06 * env
                break
              case 'tickle': // くすぐったくて身をよじる
                pokeHappy = env * 0.9
                if (spine) spine.rotation.z += Math.sin(poke.t * 18) * 0.09 * env
                break
              case 'angry': // ぷんっとそっぽを向く(首だけ回すと怖いので全身でターン)
                pokeAngry = 0.7 * env
                vrm.scene.rotation.y += 0.4 * env
                break
            }
          }
        }

        const em = vrm.expressionManager
        if (em) {
          // まばたき
          nextBlink -= delta
          let blinkNow = 0
          if (nextBlink <= 0 && blinkT < 0) blinkT = 0
          if (blinkT >= 0) {
            blinkT += delta
            blinkNow = blinkT < 0.08 ? blinkT / 0.08 : Math.max(0, 1 - (blinkT - 0.08) / 0.08)
            if (blinkT > 0.16) {
              blinkT = -1
              nextBlink = 1.5 + Math.random() * 4
            }
          }
          // うとうと中は目を閉じ気味に
          em.setValue('blink', Math.max(blinkNow, drowsy * 0.85))
          // 口パク(再生音量に追従)。OS音声(英語等)はWebAudioを通らず音量が取れないため、
          // 「鳴っているのに音量ゼロ」のときはリズミカルな疑似口パクにする
          let target = 0
          if (stateRef.current === 'speaking') {
            const lvl = levelRef.current()
            target = Math.min(1, lvl * 2.8)
            if (audible && lvl < 0.02) {
              target = Math.max(0, 0.35 + 0.25 * Math.sin(t * 11) + 0.15 * Math.sin(t * 23))
            }
          }
          mouth += (target - mouth) * Math.min(1, delta * 18)
          em.setValue('aa', mouth)
          // 返答の感情による表情(なめらかに遷移)
          const ew = emoWeightsRef.current
          const emo = emotionRef.current
          const ease = Math.min(1, delta * 3)
          ew.happy += ((emo === 'happy' ? 0.7 : 0) - ew.happy) * ease
          ew.sad += ((emo === 'sad' ? 0.6 : 0) - ew.sad) * ease
          ew.angry += ((emo === 'angry' ? 0.5 : 0) - ew.angry) * ease
          ew.surprised += ((emo === 'surprised' ? 0.5 : 0) - ew.surprised) * ease
          // 表情(モデルに無い場合は無視される)。タップ反応・感情を重ねる
          em.setValue('happy', Math.min(1, (stateRef.current === 'speaking' ? 0.3 : 0.1) + pokeHappy + ew.happy))
          em.setValue('sad', ew.sad)
          em.setValue('relaxed', pokeRelaxed)
          em.setValue('surprised', Math.max(pokeSurprised, ew.surprised))
          em.setValue('angry', Math.max(pokeAngry, ew.angry))
        }
        vrm.update(delta)
      }
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)

    // ドラッグで回転 / ピンチ・ホイールでズーム
    const canvas = renderer.domElement
    canvas.style.touchAction = 'none'
    canvas.style.cursor = 'grab'
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    const pointers = new Map<number, { x: number; y: number }>()
    let pinchDist = 0
    // タップ判定用(ほぼ動かさず短時間で離したらタップ=キャラへのタッチ)
    let tap: { id: number; x0: number; y0: number; t0: number; moved: number } | null = null

    // タップ位置にレイを飛ばし、モデルに当たったら頭/体を判定して反応を発動
    const raycaster = new THREE.Raycaster()
    const doPoke = (clientX: number, clientY: number) => {
      if (!vrm) return
      const rect = canvas.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObject(vrm.scene, true)
      if (!hits.length) return
      const headNode = vrm.humanoid.getNormalizedBoneNode('head')
      const headY = headNode ? headNode.getWorldPosition(new THREE.Vector3()).y : 1.3
      const zone: PokeZone = hits[0].point.y > headY - 0.12 ? 'head' : 'body'
      const patterns = POKE_PATTERNS[zone]
      const pattern = patterns[Math.floor(Math.random() * patterns.length)]
      pokeRef.current = { pattern, t: 0 }
      onPokeRef.current?.(zone, pattern)
    }

    const onPointerDown = (e: PointerEvent) => {
      lastActiveRef.current = Date.now() // 触られたら目を覚ます
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      tap = pointers.size === 1
        ? { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0 }
        : null
      try { canvas.setPointerCapture(e.pointerId) } catch { /* 合成イベント等では失敗する */ }
      canvas.style.cursor = 'grabbing'
    }
    const onPointerMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      if (tap && tap.id === e.pointerId) {
        tap.moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y)
      }
      if (pointers.size === 1) {
        dragRotYRef.current += (e.clientX - prev.x) * 0.008
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDist > 0 && d > 0) {
          camDistRef.current = clamp(camDistRef.current * (pinchDist / d), CAM_MIN, CAM_MAX)
        }
        pinchDist = d
      }
    }
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinchDist = 0
      if (pointers.size === 0) canvas.style.cursor = 'grab'
      if (tap && tap.id === e.pointerId) {
        const dt = performance.now() - tap.t0
        if (tap.moved < 8 && dt < 350) doPoke(e.clientX, e.clientY)
        tap = null
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      camDistRef.current = clamp(camDistRef.current * (1 + e.deltaY * 0.001), CAM_MIN, CAM_MAX)
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // スマホの傾きでカメラを少し動かすパララックス。
    // 基準(持ち方)はゆっくり現在値に追従させて自動キャリブレーションする。
    const baseline = { beta: null as number | null, gamma: 0 }
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return
      if (baseline.beta == null) {
        baseline.beta = e.beta
        baseline.gamma = e.gamma
      } else {
        baseline.beta += (e.beta - baseline.beta) * 0.003
        baseline.gamma += (e.gamma - baseline.gamma) * 0.003
      }
      const clamp25 = (v: number) => Math.max(-25, Math.min(25, v))
      tiltTargetRef.current = {
        x: clamp25(e.gamma - baseline.gamma) / 25,
        y: clamp25(e.beta - baseline.beta) / 25,
      }
    }
    window.addEventListener('deviceorientation', onOrient)

    // iOSはユーザー操作中に許可が必要。初回タップで一度だけ要求する(Androidは無反応でOK)
    const askOrientPermission = () => {
      const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
      if (typeof D.requestPermission === 'function') D.requestPermission().catch(() => { /* ignore */ })
    }
    window.addEventListener('pointerdown', askOrientPermission, { once: true })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('deviceorientation', onOrient)
      window.removeEventListener('pointerdown', askOrientPermission)
      if (vrm) VRMUtils.deepDispose(vrm.scene)
      renderer.dispose()
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement)
    }
  }, [])

  if (failed) return <Avatar state={state} />

  return (
    <div className="relative w-full" style={{ height: '42dvh' }}>
      <div ref={mountRef} className="absolute inset-0" />
      {state === 'listening' && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-red-400/70 animate-pulse rounded-full pointer-events-none" />
      )}
      {state === 'speaking' && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-blue-400/70 animate-pulse rounded-full pointer-events-none" />
      )}
    </div>
  )
}
