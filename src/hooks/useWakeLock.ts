import { useEffect, useRef } from 'react'

export function useWakeLock() {
  const lockRef = useRef<any>(null)

  useEffect(() => {
    const req = async () => {
      try {
        if ('wakeLock' in navigator) {
          lockRef.current = await (navigator as any).wakeLock.request('screen')
        }
      } catch { /* ignore */ }
    }
    req()
    const onVis = () => { if (document.visibilityState === 'visible') req() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      lockRef.current?.release()
    }
  }, [])
}
