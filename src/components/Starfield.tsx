import { useEffect, useRef } from 'react'

/**
 * Static starfield canvas behind the globe (§5.7) — the map canvas is
 * transparent outside the sphere, so this shows through as "space".
 */
export function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      const count = Math.round((w * h) / 2600)
      for (let i = 0; i < count; i++) {
        const x = Math.random() * w
        const y = Math.random() * h
        const r = Math.random() * Math.random() * 1.1 + 0.25
        const a = 0.12 + Math.random() * 0.55
        // mostly white, a few cool-blue and warm stars for depth
        const tint = Math.random()
        const color =
          tint < 0.78 ? '255, 255, 255' : tint < 0.92 ? '180, 205, 255' : '255, 225, 190'
        ctx.beginPath()
        ctx.fillStyle = `rgba(${color}, ${a})`
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      // a handful of brighter stars with a soft bloom
      const brightCount = Math.round(count / 40)
      for (let i = 0; i < brightCount; i++) {
        const x = Math.random() * w
        const y = Math.random() * h
        const r = 0.8 + Math.random() * 0.9
        ctx.save()
        ctx.shadowColor = 'rgba(200, 220, 255, 0.9)'
        ctx.shadowBlur = 4 + Math.random() * 5
        ctx.fillStyle = 'rgba(235, 244, 255, 0.9)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }

    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [])

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
}
