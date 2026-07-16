import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Hono API proxy (holds the FIRMS key + cache) — see server/index.ts
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
