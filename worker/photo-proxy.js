/**
 * Ember aircraft-photo proxy — a Cloudflare Worker.
 *
 * WHY THIS EXISTS: the flights globe shows a photo of the selected aircraft
 * from planespotters.net. Their API rejects any request whose User-Agent lacks
 * a contact URL — and browsers physically cannot set `User-Agent` on fetch()
 * (it's a forbidden header). The static GitHub Pages site has no server, so it
 * cannot hold that header. This tiny Worker does: it holds a compliant UA,
 * calls planespotters, and returns just the photo metadata with permissive
 * CORS so the github.io page can read it. The image itself
 * (t.plnspttrs.net/…) then loads directly in an <img> on any origin.
 *
 * DEPLOY (one-time, your Cloudflare account — free tier is plenty):
 *   cd worker && npx wrangler deploy
 * It prints a URL like https://ember-photo-proxy.<you>.workers.dev
 * Then set a repo Actions *variable* PHOTO_PROXY_URL to that URL
 * (Settings → Secrets and variables → Actions → Variables → New variable).
 * The next Pages build injects it as VITE_PHOTO_PROXY and photos light up.
 *
 * Free-tier note: 100k requests/day. Responses are cached 24 h (the client
 * also caches per hex for the session), so real traffic stays tiny.
 */

const PLANESPOTTERS = 'https://api.planespotters.net/pub/photos/hex/'
// planespotters requires a contact URL in the UA; keep it accurate.
const UA = 'Ember-hazard-globes/1.0 (+https://github.com/ReFxFrank/Weatherman)'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const json = (body, extra = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  })

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    if (request.method !== 'GET') return json({ photo: null })

    const hex = (new URL(request.url).searchParams.get('hex') ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(hex)) return json({ photo: null })

    try {
      const res = await fetch(PLANESPOTTERS + hex, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        // Cloudflare edge-caches the upstream response for a day
        cf: { cacheTtl: 86400, cacheEverything: true },
      })
      if (!res.ok) return json({ photo: null })
      const data = await res.json()
      const p = data.photos && data.photos[0]
      if (!p) return json({ photo: null })
      return json(
        {
          thumb: (p.thumbnail_large ?? p.thumbnail ?? {}).src ?? '',
          link: p.link ?? '',
          photographer: p.photographer ?? '',
        },
        { 'Cache-Control': 'public, max-age=86400' },
      )
    } catch {
      return json({ photo: null })
    }
  },
}
