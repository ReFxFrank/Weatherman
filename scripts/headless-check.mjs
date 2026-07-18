#!/usr/bin/env node
/**
 * Headless smoke-check for Ember: loads the app in a real (software-rendered)
 * Chromium, waits for the map + active globe's feed, then reports the HUD
 * text, native-layer feature counts, and page errors, and saves a screenshot.
 *
 * Usage:
 *   npm run dev                        # in another terminal (or use the live site)
 *   node scripts/headless-check.mjs [url] [screenshot.png]
 *
 * Examples:
 *   node scripts/headless-check.mjs
 *   node scripts/headless-check.mjs 'http://127.0.0.1:5173/?globe=hurricanes&z=3.4&lat=17&lon=-119'
 *   node scripts/headless-check.mjs 'https://refxfrank.github.io/Weatherman/?globe=lightning' pages.png
 *
 * Browser resolution: CHROMIUM_PATH env var, else /opt/pw-browsers/chromium-*
 * (the Claude Code remote container), else an installed Chrome (channel).
 *
 * Sandboxed-egress note: when HTTPS_PROXY is set (e.g. the Claude Code
 * remote container, whose TLS-intercepting proxy Chromium won't trust),
 * external hosts (basemap tiles, EONET, the live Pages site) are relayed
 * through undici — which does trust the proxy CA — via page.route().
 * Locally (no HTTPS_PROXY) requests go direct and the relay is skipped.
 *
 * DEV hooks used (only exposed by `npm run dev` builds): window.__emberMap.
 * Against a production URL the layer report is skipped; HUD + screenshot
 * still work.
 */
import { existsSync, readdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const shot = process.argv[3] ?? 'headless-check.png'

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = '/opt/pw-browsers'
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      const p = `${root}/${d}/chrome-linux/chrome`
      if (existsSync(p)) return p
    }
  }
  return undefined // fall through to channel: 'chrome'
}

const executablePath = findChromium()
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy
const browser = await chromium.launch({
  executablePath,
  channel: executablePath ? undefined : 'chrome',
  proxy: proxyServer ? { server: proxyServer, bypass: '127.0.0.1,localhost' } : undefined,
  // SwiftShader keeps WebGL working with no GPU (CI containers)
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

if (proxyServer) {
  const { fetch: ufetch, ProxyAgent } = await import('undici')
  const dispatcher = new ProxyAgent(proxyServer)
  await page.route(/cartocdn\.com|eonet\.gsfc\.nasa\.gov|github\.io/, async (route) => {
    try {
      const r = await ufetch(route.request().url(), { dispatcher })
      const body = Buffer.from(await r.arrayBuffer())
      await route.fulfill({
        status: r.status,
        body,
        headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' },
      })
    } catch {
      await route.abort()
    }
  })
}

console.log(`loading ${url}`)
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
// entrance + feed fetch + tile render; generous for software rendering
await page.waitForTimeout(22_000)

const hud = await page.evaluate(() =>
  [...document.querySelectorAll('header')]
    .map((h) => h.textContent)
    .find((t) => t?.includes('EMBER'))
    ?.slice(0, 300),
)
console.log('HUD:', hud ?? '(not found — app did not boot?)')

const layers = await page.evaluate(() => {
  const map = window.__emberMap
  if (!map) return null // production build: DEV hooks absent
  const out = []
  for (const l of map.getStyle().layers ?? []) {
    if (!/^(hur|svr|eq|aur|glm|terminator|eonet|ember)-/.test(l.id)) continue
    const vis = map.getLayoutProperty(l.id, 'visibility') ?? 'visible'
    // queryRenderedFeatures on a symbol layer can throw mid-glyph-load — one
    // fragile layer must not abort the whole report
    let n
    try {
      n = map.queryRenderedFeatures({ layers: [l.id] }).length
    } catch {
      n = 'err'
    }
    out.push(`${l.id}:${vis}:${n}`)
  }
  return out.join(' ')
})
if (layers !== null) console.log('layers:', layers || '(none)')

await page.screenshot({ path: shot, timeout: 120_000 })
console.log(`screenshot: ${shot}`)
if (errors.length) {
  console.log(`page errors (${errors.length}):`)
  for (const e of errors.slice(0, 10)) console.log(' -', e)
}
await browser.close()
console.log(errors.length ? 'DONE (with page errors)' : 'DONE')
