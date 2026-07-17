#!/usr/bin/env node
/**
 * Interaction check for the severe/hurricane detail cards + the per-globe
 * mobile bottom sheet: boots the dev app in headless Chromium, REALLY clicks
 * map features (warning polygons, report dots, storm heads, forecast
 * points), and asserts the store selection + rendered card. Companion to
 * headless-check.mjs (which is render-only).
 *
 * Usage:
 *   npm run dev                          # in another terminal
 *   node scripts/verify-cards.mjs [baseUrl]
 *
 * Needs the DEV hooks (__emberMap/__emberStore), so it only works against a
 * dev-server URL. Feature clicks are skipped honestly when the live feed has
 * nothing to click (quiet weather is real data).
 *
 * Browser resolution matches headless-check.mjs: CHROMIUM_PATH, else the
 * container's /opt/pw-browsers, else installed Chrome, else Edge.
 */
import { existsSync, readdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const base = (process.argv[2] ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
let failures = 0
let skips = 0
const ok = (msg) => console.log(`  PASS ${msg}`)
const skip = (msg) => {
  skips++
  console.log(`  SKIP ${msg}`)
}
const fail = (msg) => {
  failures++
  console.log(`  FAIL ${msg}`)
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = '/opt/pw-browsers'
  if (existsSync(root)) {
    for (const d of readdirSync(root)) {
      const p = `${root}/${d}/chrome-linux/chrome`
      if (existsSync(p)) return p
    }
  }
  return undefined
}

const executablePath = findChromium()
const args = ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
let browser
try {
  browser = await chromium.launch({ executablePath, channel: executablePath ? undefined : 'chrome', args })
} catch {
  browser = await chromium.launch({ channel: 'msedge', args }) // Windows fallback
}

const pageErrors = []
async function newPage(viewport) {
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))
  return page
}

/** Poll an in-page probe until it returns truthy (or time out → null). */
async function waitFor(page, fn, arg, timeoutMs = 45_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await page.evaluate(fn, arg)
    if (v) return v
    await page.waitForTimeout(600)
  }
  return null
}

/** Jump the camera, project a lngLat, click it, return the new selection. */
async function clickAt(page, lon, lat, zoom, storeKey) {
  await page.evaluate(
    ([ln, lt, z]) => window.__emberMap.jumpTo({ center: [ln, lt], zoom: z }),
    [lon, lat, zoom],
  )
  await page.waitForTimeout(2000) // let tiles/layers render at the new camera
  const pt = await page.evaluate(([ln, lt]) => {
    const p = window.__emberMap.project([ln, lt])
    return { x: p.x, y: p.y }
  }, [lon, lat])
  await page.mouse.click(pt.x, pt.y)
  await page.waitForTimeout(700)
  return page.evaluate((k) => window.__emberStore.getState()[k], storeKey)
}

// ---------------------------------------------------------------------------
console.log('SEVERE globe — warning/report cards')
{
  const page = await newPage({ width: 1280, height: 800 })
  await page.goto(`${base}/?globe=severe&quality=performance&lat=38&lon=-97&z=4`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const ready = await waitFor(page, () => {
    const map = window.__emberMap
    if (!map || !map.getSource('svr-alerts')) return false
    // severe data has landed once the HUD shows the warning COUNTS —
    // "warnings" alone also appears in the legend copy (false positive)
    return /\d+ TOR · \d+ SVR/.test(document.body.innerText)
  })
  if (!ready) fail('severe globe did not boot')
  else {
    // --- alert polygon click (prefer a warning, fall back to a watch).
    // waitFor: GeoJSON setData parses/tiles async — the HUD counts can be
    // on screen before querySourceFeatures sees the features.
    const target = await waitFor(page, () => {
      const feats = window.__emberMap.querySourceFeatures('svr-alerts')
      const pick =
        feats.find((f) => String(f.properties.kind).includes('warning')) ??
        feats.find((f) => String(f.properties.kind).includes('watch'))
      if (!pick) return null
      const g = pick.geometry
      const ring =
        g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null
      if (!ring || !ring.length) return null
      let sx = 0
      let sy = 0
      for (const [x, y] of ring) {
        sx += x
        sy += y
      }
      return { lon: sx / ring.length, lat: sy / ring.length, kind: pick.properties.kind }
    }, undefined, 20_000)
    if (!target) skip('no active alerts in view to click (quiet weather is real data)')
    else {
      const sel = await clickAt(page, target.lon, target.lat, 6, 'selectedSevere')
      if (sel?.type === 'alert') {
        const cardText = await page.evaluate(() => document.body.innerText)
        if (/WARNING|WATCH/.test(cardText) && /until|expires/i.test(cardText)) {
          ok(`clicked ${target.kind} → alert card with expiry rendered`)
          await page.screenshot({ path: 'verify-severe-card.png' })
        } else fail(`alert selected but card text missing (${target.kind})`)
      } else fail(`click on ${target.kind} centroid selected ${JSON.stringify(sel)} (vertex-average may sit outside a concave polygon)`)
    }

    // --- report dot click. querySourceFeatures only sees the current
    // viewport's tiles — come back to the CONUS overview first (the alert
    // click above left the camera zoomed into that alert).
    await page.evaluate(() => window.__emberMap.jumpTo({ center: [-97, 38], zoom: 4 }))
    await page.waitForTimeout(1500)
    const report = await waitFor(page, () => {
      const feats = window.__emberMap.querySourceFeatures('svr-reports')
      const f = feats[0]
      return f ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : null
    }, undefined, 20_000)
    if (!report) skip('no SPC reports in view to click')
    else {
      const sel = await clickAt(page, report.lon, report.lat, 6, 'selectedSevere')
      if (sel?.type === 'report') {
        const t = await page.evaluate(() => document.body.innerText)
        if (/REPORT/.test(t)) ok('clicked report dot → report card rendered')
        else fail('report selected but card text missing')
      } else fail(`report dot click selected ${JSON.stringify(sel)}`)
    }
  }
  await page.close()
}

// ---------------------------------------------------------------------------
console.log('HURRICANES globe — storm/forecast cards')
{
  const page = await newPage({ width: 1280, height: 800 })
  await page.goto(`${base}/?globe=hurricanes&quality=performance&lat=15&lon=-110&z=3`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const ready = await waitFor(page, () => {
    const map = window.__emberMap
    if (!map || !map.getSource('hur-heads')) return false
    return /\d+ NHC storm/.test(document.body.innerText)
  })
  if (!ready) fail('hurricanes globe did not boot')
  else {
    const head = await waitFor(page, () => {
      const feats = window.__emberMap.querySourceFeatures('hur-heads')
      const pick = feats.find((f) => f.properties.kind === 'nhc') ?? feats[0]
      if (!pick) return null
      return {
        lon: pick.geometry.coordinates[0],
        lat: pick.geometry.coordinates[1],
        kind: pick.properties.kind,
        name: String(pick.properties.label ?? '').split(' ·')[0],
      }
    }, undefined, 20_000)
    if (!head) skip('no active storms to click (quiet season is real data)')
    else {
      const sel = await clickAt(page, head.lon, head.lat, 4.5, 'selectedHurricane')
      if (sel?.type === 'storm' || sel?.type === 'global') {
        const t = await page.evaluate(() => document.body.innerText)
        if (head.name && t.includes(head.name)) {
          ok(`clicked ${head.kind} storm head → card for ${head.name} rendered`)
          await page.screenshot({ path: 'verify-hurricane-card.png' })
        } else fail(`storm selected but card for ${head.name} not found`)
      } else fail(`storm head click selected ${JSON.stringify(sel)}`)

      // --- forecast point (mid-track: far enough from the head's click pad)
      const fpt = await page.evaluate(() => {
        const feats = window.__emberMap.querySourceFeatures('hur-points')
        const f = feats[Math.floor(feats.length / 2)]
        return f ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : null
      })
      if (!fpt) skip('no forecast points to click')
      else {
        const sel2 = await clickAt(page, fpt.lon, fpt.lat, 5, 'selectedHurricane')
        if (sel2?.type === 'forecast') {
          const t = await page.evaluate(() => document.body.innerText)
          if (/FORECAST/.test(t)) ok('clicked forecast point → forecast card rendered')
          else fail('forecast selected but card text missing')
        } else if (sel2?.type === 'storm' || sel2?.type === 'global') {
          skip('forecast point sat within the storm-head click pad (head wins by design)')
        } else fail(`forecast point click selected ${JSON.stringify(sel2)}`)
      }
    }
  }
  await page.close()
}

// ---------------------------------------------------------------------------
console.log('QUAKES globe — earthquake card')
{
  const page = await newPage({ width: 1280, height: 800 })
  await page.goto(`${base}/?globe=quakes&quality=performance&lat=20&lon=-40&z=1.6`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const ready = await waitFor(page, () => {
    const map = window.__emberMap
    if (!map || !map.getSource('eq-quakes')) return false
    return /\d+ quakes/.test(document.body.innerText)
  })
  if (!ready) fail('quakes globe did not boot')
  else {
    // pick the strongest quake in the source (most visible, definitely present)
    const q = await waitFor(page, () => {
      const feats = window.__emberMap.querySourceFeatures('eq-quakes')
      if (!feats.length) return null
      let best = feats[0]
      for (const f of feats) if ((f.properties.mag ?? -9) > (best.properties.mag ?? -9)) best = f
      return { lon: best.geometry.coordinates[0], lat: best.geometry.coordinates[1], mag: best.properties.mag }
    }, undefined, 20_000)
    if (!q) skip('no quakes in the feed to click (should never happen for all_day)')
    else {
      const sel = await clickAt(page, q.lon, q.lat, 4, 'selectedQuake')
      if (sel?.id) {
        const t = await page.evaluate(() => document.body.innerText)
        if (/EARTHQUAKE/.test(t) && /M\d/.test(t)) {
          ok(`clicked M${q.mag} quake → earthquake card rendered`)
          await page.screenshot({ path: 'verify-quake-card.png' })
        } else fail('quake selected but card text missing')
      } else fail(`quake click selected ${JSON.stringify(sel)}`)
    }
  }
  await page.close()
}

// ---------------------------------------------------------------------------
console.log('MOBILE bottom sheet — per-globe tabs')
{
  const page = await newPage({ width: 375, height: 812 })
  await page.goto(`${base}/?globe=severe&quality=performance&lat=38&lon=-97&z=4`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const booted = await waitFor(page, () => /warnings|FEED ERROR|ACQUIRING/.test(document.body.innerText))
  if (!booted) fail('mobile severe globe did not boot')
  else {
    const hasButtons = await page.evaluate(
      () => Boolean(document.querySelector('button[title="Display"]') && document.querySelector('button[title="Legend"]')),
    )
    if (!hasButtons) fail('Display/Legend floating buttons missing on mobile severe globe')
    else {
      await page.click('button[title="Display"]')
      await page.waitForTimeout(400)
      const display = await page.evaluate(() => document.body.innerText)
      if (/QUALITY/.test(display) && /VIEW/.test(display)) ok('Display sheet shows shared controls')
      else fail('Display sheet content missing')
      await page.click('button:has-text("Legend")')
      await page.waitForTimeout(400)
      const legend = await page.evaluate(() => document.body.innerText)
      if (/SPC day-1/i.test(legend)) {
        ok('Legend sheet shows the severe legend (coverage honesty reachable on mobile)')
        await page.screenshot({ path: 'verify-mobile-sheet.png' })
      } else fail('Legend sheet content missing')
    }
  }
  // fire globe regression: original tabs intact
  await page.goto(`${base}/?globe=fire&quality=performance&lat=38&lon=-97&z=4`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  const fireBooted = await waitFor(page, () => /detections|ACQUIRING|FEED ERROR/.test(document.body.innerText))
  if (!fireBooted) fail('mobile fire globe did not boot')
  else {
    const hasFireButtons = await page.evaluate(
      () =>
        Boolean(
          document.querySelector('button[title="Filters & layers"]') &&
            document.querySelector('button[title="Statistics"]'),
        ),
    )
    if (hasFireButtons) ok('fire globe keeps Filters/Stats buttons')
    else fail('fire globe mobile buttons regressed')
  }
  await page.close()
}

await browser.close()
if (pageErrors.length) {
  console.log(`page errors (${pageErrors.length}):`)
  for (const e of pageErrors.slice(0, 10)) console.log(' -', e)
}
// A page error (uncaught exception) during these interactions — e.g. a crash
// in the map click handler, which runs outside React and wouldn't blank the
// DOM the innerText assertions read — must fail the run, or interaction-only
// crashes stay invisible (headless-check.mjs never performs these clicks).
const clean = failures === 0 && pageErrors.length === 0
console.log(
  `\n${clean ? 'DONE' : 'DONE WITH FAILURES'} — ${failures} failed, ${skips} skipped, ${pageErrors.length} page errors`,
)
process.exit(clean ? 0 : 1)
