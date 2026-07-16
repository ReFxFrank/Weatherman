import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/ — the Pages workflow
  // sets VITE_BASE accordingly; local dev/preview stays at '/'.
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Hono API proxy (holds the FIRMS key + cache) — see server/index.ts
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
