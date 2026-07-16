import { useEffect, useState } from 'react'

/** Lightweight FPS meter for the ?debug=1 HUD corner. */
export function useFps(enabled: boolean): number {
  const [fps, setFps] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let frames = 0
    let last = performance.now()
    let raf = requestAnimationFrame(function loop(now: number) {
      frames++
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(raf)
  }, [enabled])
  return fps
}
