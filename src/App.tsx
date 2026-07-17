import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { CloudOff, Flame, RotateCcw, Satellite, TriangleAlert } from 'lucide-react'
import {
  fetchEonetEvents,
  fetchFireDecoded,
  fetchLightningDecoded,
  fetchQuota,
  fetchSevere,
  LIGHTNING_REFRESH_MS,
  REFRESH_MS,
  SEVERE_REFRESH_MS,
} from './lib/api'
import { deriveRenderAttributes } from './lib/binary'
import { deriveLightningAttributes } from './lib/lightningBinary'
import { computeChoropleth } from './lib/choropleth'
import { startDeepLinkSync } from './lib/deepLink'
import { exportView } from './lib/exportView'
import { fetchPerimeters } from './lib/perimeters'
import { qualityConfig } from './lib/quality'
import { computeFireStats } from './lib/stats'
import { mapBus } from './lib/mapBus'
import { useFps } from './lib/useFps'
import { BottomSheet } from './components/BottomSheet'
import { EmberMap } from './components/EmberMap'
import { EventCard } from './components/EventCard'
import { FilterPanel } from './components/FilterPanel'
import { GlobeSwitcher } from './components/GlobeSwitcher'
import { HotspotCard } from './components/HotspotCard'
import { Legend } from './components/Legend'
import { SearchBox } from './components/SearchBox'
import { Starfield } from './components/Starfield'
import { StatsPanel } from './components/StatsPanel'
import { TimeControl } from './components/TimeControl'
import { glass } from './components/ui'
import { setEmber, SOURCES, useEmber } from './store'

/** Cards and the legend share the bottom-right slot; mobile centers them. */
const CARD_POS =
  'z-20 w-72 absolute lg:bottom-8 lg:right-4 max-lg:bottom-24 max-lg:left-1/2 max-lg:-translate-x-1/2'

export default function App() {
  const globe = useEmber((s) => s.globe)
  const source = useEmber((s) => s.source)
  const days = useEmber((s) => s.days)
  const tier = useEmber((s) => s.quality)
  const frpMin = useEmber((s) => s.frpMin)
  const confMin = useEmber((s) => s.confMin)
  const dayNight = useEmber((s) => s.dayNight)
  const playhead = useEmber((s) => s.playhead)
  const selectedHotspot = useEmber((s) => s.selectedHotspot)
  const selectedEventId = useEmber((s) => s.selectedEventId)
  const viewEpoch = useEmber((s) => s.viewEpoch)
  const showChoropleth = useEmber((s) => s.showChoropleth)
  const showPerimeters = useEmber((s) => s.showPerimeters)

  const quality = useMemo(() => qualityConfig(tier), [tier])
  const debug = useMemo(() => new URLSearchParams(location.search).has('debug'), [])
  const fps = useFps(debug)

  // Refetch happens ONLY when source/days change (§5.3) — plus the §5.2
  // auto-refresh tick, which swaps data in place without any reload. Paused
  // while another globe is up; cached data makes switching back instant.
  const { data: decoded, isLoading, isError, error, isPlaceholderData, dataUpdatedAt } = useQuery({
    queryKey: ['fire', source, days],
    queryFn: () => fetchFireDecoded(source, days),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    enabled: globe === 'fire',
  })

  // Lightning globe (Phase 6): GOES GLM rolling window via the proxy (live)
  // or the baked lightning.bin (Pages). The first live responses are a
  // partial window (meta.backfill < 1) that fills within a minute or two.
  const {
    data: lightningDecoded,
    isLoading: lightningLoading,
    isError: lightningError,
    error: lightningErr,
  } = useQuery({
    queryKey: ['lightning'],
    queryFn: fetchLightningDecoded,
    placeholderData: keepPreviousData,
    // poll fast while the server is still backfilling its window (cold start
    // fills in seconds instead of sitting on "0 detections" for a minute)
    refetchInterval: (query) =>
      query.state.data && query.state.data.meta.backfill < 0.98 ? 10_000 : LIGHTNING_REFRESH_MS,
    enabled: globe === 'lightning',
  })
  const lightningData = useMemo(
    () => (lightningDecoded ? deriveLightningAttributes(lightningDecoded, quality.maxPoints) : undefined),
    [lightningDecoded, quality],
  )

  // Severe weather globe (NWS/SPC): tiny JSON payload, fast poll — warnings
  // appear within seconds of issuance.
  const {
    data: severeData,
    isLoading: severeLoading,
    isError: severeError,
    error: severeErr,
  } = useQuery({
    queryKey: ['severe'],
    queryFn: fetchSevere,
    placeholderData: keepPreviousData,
    refetchInterval: SEVERE_REFRESH_MS,
    enabled: globe === 'severe',
  })

  // The satellite-lag chips are wall-clock readouts — re-render them between
  // refetches (which can be 10 min apart on Pages) so "live 1m" can't quietly
  // mean "live 9m" (review finding).
  const [, setLagTick] = useState(0)
  useEffect(() => {
    if (globe !== 'lightning') return
    const id = window.setInterval(() => setLagTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [globe])

  // EONET named events — keyless + CORS-friendly, fetched straight from the
  // client (§3.2), refreshed on the same cadence.
  const { data: events } = useQuery({
    queryKey: ['eonet'],
    queryFn: fetchEonetEvents,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  })

  // US perimeters (Phase 5): fetched lazily on first toggle, kept 30 min.
  const { data: perimeters } = useQuery({
    queryKey: ['perimeters'],
    queryFn: fetchPerimeters,
    enabled: showPerimeters,
    staleTime: 30 * 60_000,
  })

  // FIRMS quota readout for the ?debug corner (§3.1).
  const { data: quota } = useQuery({
    queryKey: ['quota'],
    queryFn: fetchQuota,
    enabled: debug,
    refetchInterval: 5 * 60_000,
  })

  // Decimation stride: the tier baseline, scaled up so multi-day windows stay
  // under the tier's rendered-point cap. ?stride=N (dev/test) wins outright.
  const stride = useMemo(() => {
    const override = Number(new URLSearchParams(location.search).get('stride'))
    if (Number.isFinite(override) && override >= 1) return Math.floor(override)
    if (!decoded) return quality.stride
    return Math.max(quality.stride, Math.ceil(decoded.count / quality.maxPoints))
  }, [decoded, quality])

  const data = useMemo(
    () => (decoded ? deriveRenderAttributes(decoded, stride) : undefined),
    [decoded, stride],
  )

  // Selected-hotspot indices are positions in the current payload — invalid
  // the moment the payload changes.
  useEffect(() => {
    setEmber({ selectedHotspot: null })
  }, [decoded])

  // "New since last refresh" (§5.4): rows acquired after the newest
  // acquisition in the previous payload of the same (source, days) feed.
  const prevPayloadRef = useRef<{ key: string; fetchedAt: string; maxTs: number } | null>(null)
  const [newSince, setNewSince] = useState<{ count: number; sinceIso: string } | null>(null)
  useEffect(() => {
    if (!decoded) return
    // keepPreviousData briefly pairs the OLD payload with the NEW query key —
    // seeding the baseline then would fake a huge "+N new" on source/window
    // switches (review finding). Wait for the real payload.
    if (isPlaceholderData) return
    const key = `${source}/${days}`
    let maxTs = 0
    for (let i = 0; i < decoded.count; i++) if (decoded.tsSec[i] > maxTs) maxTs = decoded.tsSec[i]
    const prev = prevPayloadRef.current
    if (prev && prev.key === key && prev.fetchedAt !== decoded.meta.fetchedAt) {
      let n = 0
      for (let i = 0; i < decoded.count; i++) if (decoded.tsSec[i] > prev.maxTs) n++
      setNewSince({ count: n, sinceIso: new Date(prev.maxTs * 1000).toISOString() })
    } else if (!prev || prev.key !== key) {
      setNewSince(null)
    }
    prevPayloadRef.current = { key, fetchedAt: decoded.meta.fetchedAt, maxTs }
  }, [decoded, source, days, isPlaceholderData])

  // Stats (§5.4). Only DURING playback quantize the time range (quarter-days)
  // so the full-array pass runs ~1-2×/s, not 60×/s; a resting scrub position
  // uses the exact range so stats always match the GPU slice (review finding).
  const playing = useEmber((s) => s.playing)
  const timeRange = useMemo<[number, number]>(
    () => (playhead === null ? [0, days] : [Math.max(0, playhead - 1), playhead]),
    [playhead, days],
  )
  const qLo = playing ? Math.round(timeRange[0] * 4) / 4 : timeRange[0]
  const qHi = playing ? Math.round(timeRange[1] * 4) / 4 : timeRange[1]
  const stats = useMemo(
    () =>
      // viewEpoch bumps on every camera settle — don't run the full-array
      // pass for a globe that isn't on screen
      globe === 'fire' && decoded
        ? computeFireStats(decoded, { frpMin, confMin, dayNight }, [qLo, qHi], mapBus.getBounds?.() ?? null)
        : null,
    // viewEpoch pulls fresh bounds after the camera settles
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [globe, decoded, frpMin, confMin, dayNight, qLo, qHi, viewEpoch],
  )

  const shownCount = stats?.shownTotal ?? 0
  const filtersActive = frpMin > 0 || confMin > 0 || dayNight !== 'all'
  const sourceLabel = SOURCES.find((x) => x.id === source)?.label ?? source

  // Validate the open selection at render time: it must belong to THIS
  // payload (indices shift across refetches — no one-paint flash of a wrong
  // detection) and still pass the active filters (no orphaned ring/card
  // after a filter change or playback scrub). Both were review findings.
  const decodedIdentityRef = useRef(decoded)
  const payloadChanged = decodedIdentityRef.current !== decoded
  decodedIdentityRef.current = decoded
  const validSelection = useMemo(() => {
    if (payloadChanged || !decoded || selectedHotspot === null) return null
    const i = selectedHotspot
    if (i >= decoded.count) return null
    if (decoded.frp[i] < frpMin || decoded.conf[i] < confMin) return null
    const wantNight = dayNight === 'all' ? -1 : dayNight === 'night' ? 1 : 0
    if (wantNight !== -1 && decoded.night[i] !== wantNight) return null
    const age = (Date.parse(decoded.meta.fetchedAt) / 1000 - decoded.tsSec[i]) / 86400
    if (age < timeRange[0] || age > timeRange[1]) return null
    return i
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadChanged, decoded, selectedHotspot, frpMin, confMin, dayNight, timeRange])

  const jumpToFire = (t: { index: number; lon: number; lat: number }) => {
    mapBus.flyTo?.({ lon: t.lon, lat: t.lat, zoom: 8.5 })
    setEmber({ selectedHotspot: t.index, selectedEventId: null, sheet: null })
  }
  const navigateTo = (t: { lon: number; lat: number; zoom: number }) => {
    mapBus.flyTo?.(t)
    setEmber({ sheet: null })
  }

  // Country choropleth (Phase 5): recompute when on and inputs change.
  const [choropleth, setChoropleth] = useState<GeoJSON.FeatureCollection | null>(null)
  useEffect(() => {
    if (!showChoropleth || !decoded || globe !== 'fire') {
      setChoropleth(null)
      return
    }
    let cancelled = false
    computeChoropleth(decoded, { frpMin, confMin, dayNight }, [qLo, qHi]).then((fc) => {
      if (!cancelled) setChoropleth(fc)
    })
    return () => {
      cancelled = true
    }
  }, [showChoropleth, decoded, frpMin, confMin, dayNight, qLo, qHi, globe])

  // Shareable deep links (Phase 5): keep the URL in sync with the view.
  useEffect(() => startDeepLinkSync(), [])

  const onExport = (format: 'csv' | 'geojson') => {
    if (!decoded) return
    exportView(format, decoded, { frpMin, confMin, dayNight }, timeRange, mapBus.getBounds?.() ?? null)
  }

  const quotaLike = isError && /quota|429|transaction/i.test(error instanceof Error ? error.message : '')

  if (import.meta.env.DEV) {
    // test hook: lets headless verification locate real event markers
    ;(window as unknown as { __emberEvents?: typeof events }).__emberEvents = events
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Starfield />
      <EmberMap
        data={data}
        full={decoded}
        lightning={globe === 'lightning' ? lightningData : undefined}
        severe={globe === 'severe' ? severeData : undefined}
        events={events}
        quality={quality}
        selectedIndex={validSelection}
        choropleth={choropleth}
        perimeters={showPerimeters ? (perimeters ?? null) : null}
      />
      <SearchBox onNavigate={navigateTo} />
      {/* fire-globe control surfaces (filters/stats/timeline operate on FIRMS
          semantics; lightning grows its own in a later phase) */}
      {globe === 'fire' && <FilterPanel eventsCount={events?.length} />}
      {globe === 'fire' && (
        <StatsPanel stats={stats} newSince={newSince} onJumpTo={jumpToFire} onExport={onExport} />
      )}
      {globe === 'fire' && <TimeControl data={data} dataUpdatedAt={dataUpdatedAt} />}

      {/* bottom-right slot: detail card wins, legend otherwise */}
      {globe === 'fire' && decoded && validSelection !== null ? (
        <HotspotCard
          data={decoded}
          index={validSelection}
          onClose={() => setEmber({ selectedHotspot: null })}
          className={CARD_POS}
        />
      ) : globe === 'fire' && selectedEventId ? (
        <EventCard events={events} className={CARD_POS} />
      ) : (
        <Legend
          globe={globe}
          hasMtg={Boolean(lightningDecoded?.meta.sats.some((s) => s.id.startsWith('MTI')))}
          className={`absolute bottom-8 right-4 z-0 hidden w-60 lg:block ${glass}`}
        />
      )}

      {globe === 'fire' && (
        <BottomSheet
          eventsCount={events?.length}
          stats={stats}
          newSince={newSince}
          onJumpTo={jumpToFire}
          onExport={onExport}
        />
      )}

      {/* status chips: error / stale / empty (§5.6 graceful states) */}
      <div className="pointer-events-none absolute left-1/2 top-4 z-30 flex max-w-[92vw] -translate-x-1/2 flex-col items-center gap-2">
        {globe === 'severe' && severeError && (
          <div className={`pointer-events-auto flex items-center gap-2 border-red-500/30 px-3 py-2 text-[11px] text-red-300 ${glass}`}>
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            Severe weather feed unreachable — retrying automatically
          </div>
        )}
        {globe === 'severe' &&
          severeData &&
          !severeError &&
          severeData.counts.tornadoWarnings +
            severeData.counts.severeWarnings +
            severeData.counts.tornadoWatches +
            severeData.counts.severeWatches ===
            0 && (
            <div className={`pointer-events-none flex items-center gap-2 px-3 py-2 text-[11px] text-slate-300 ${glass}`}>
              No active tornado or severe thunderstorm alerts — shading shows today's SPC risk outlook
            </div>
          )}
        {globe === 'lightning' && lightningError && (
          <div className={`pointer-events-auto flex items-center gap-2 border-red-500/30 px-3 py-2 text-[11px] text-red-300 ${glass}`}>
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            Lightning feed unreachable — retrying automatically
          </div>
        )}
        {globe === 'fire' && isError && (
          <div className={`pointer-events-auto flex items-center gap-2 border-red-500/30 px-3 py-2 text-[11px] text-red-300 ${glass}`}>
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
            {quotaLike ? 'FIRMS quota reached — retrying automatically' : 'Satellite feed unreachable — retrying automatically'}
          </div>
        )}
        {globe === 'fire' && !isError && data?.meta.stale && (
          <div className={`pointer-events-auto flex items-center gap-2 border-amber-500/30 px-3 py-2 text-[11px] text-amber-300 ${glass}`}>
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            Upstream unreachable — showing cached data from{' '}
            {new Date(data.meta.fetchedAt).toISOString().slice(11, 16)}Z
          </div>
        )}
        {globe === 'fire' && !isError && data && shownCount === 0 && !isLoading && (
          <div className={`pointer-events-auto flex items-center gap-2 px-3 py-2 text-[11px] text-slate-300 ${glass}`}>
            No detections match the current filters
            {filtersActive && (
              <button
                type="button"
                onClick={() => setEmber({ frpMin: 0, confMin: 0, dayNight: 'all', playhead: null, playing: false })}
                className="flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300 hover:bg-amber-500/20"
              >
                <RotateCcw className="h-3 w-3" /> reset
              </button>
            )}
          </div>
        )}
      </div>

      {/* Brand + feed status HUD */}
      <header className={`absolute left-4 top-4 z-10 px-4 py-3 select-none ${glass}`}>
        <div className="flex items-center gap-2">
          <Flame className="h-4 w-4 text-amber-500" strokeWidth={2.5} />
          <span className="text-sm font-semibold tracking-[0.25em] text-slate-100">EMBER</span>
          <span className="ml-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium tracking-widest text-amber-400">
            LIVE
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-slate-400 max-sm:text-[10px]">
          <Satellite className="h-3 w-3 shrink-0 text-slate-500" />
          {globe === 'severe' ? (
            <>
              {severeLoading && (
                <span className="animate-pulse text-slate-300">ACQUIRING NWS/SPC FEED…</span>
              )}
              {severeError && (
                <span className="text-red-400">
                  FEED ERROR — {severeErr instanceof Error ? severeErr.message.slice(0, 60) : 'unknown'}
                </span>
              )}
              {severeData && !severeError && (
                <span>
                  <span className={severeData.counts.tornadoWarnings > 0 ? 'text-red-400' : 'text-slate-300'}>
                    {severeData.counts.tornadoWarnings} TOR
                  </span>
                  {' · '}
                  <span className={severeData.counts.severeWarnings > 0 ? 'text-amber-300' : 'text-slate-300'}>
                    {severeData.counts.severeWarnings} SVR
                  </span>{' '}
                  warnings · {severeData.counts.tornadoWatches + severeData.counts.severeWatches} watches ·{' '}
                  {severeData.counts.reports} reports today
                  {severeData.stale ? ' · STALE' : ''}
                </span>
              )}
            </>
          ) : globe === 'fire' ? (
            <>
              {isLoading && <span className="animate-pulse text-slate-300">ACQUIRING SATELLITE FEED…</span>}
              {isError && (
                <span className="text-red-400">
                  FEED ERROR — {error instanceof Error ? error.message.slice(0, 60) : 'unknown'}
                </span>
              )}
              {data && !isError && (
                <span className={isPlaceholderData ? 'opacity-50' : ''}>
                  {/* headline = detections actually shown (time window + filters);
                      the raw feed also carries older-ingest rows the window hides */}
                  <span className="text-amber-300">{shownCount.toLocaleString()}</span>
                  {filtersActive && (
                    <span className="text-slate-500"> of {data.meta.count.toLocaleString()}</span>
                  )}{' '}
                  detections · last {Math.min(days, data.meta.coverageDays) * 24}h ·{' '}
                  <span className="max-sm:hidden">{sourceLabel} · </span>
                  {data.meta.mode === 'api' ? 'area API' : 'public feed'}
                  {data.meta.stale ? ' · STALE' : ''}
                  {isPlaceholderData ? ' · switching…' : ''}
                </span>
              )}
            </>
          ) : (
            <>
              {lightningLoading && (
                <span className="animate-pulse text-slate-300">ACQUIRING LIGHTNING FEED…</span>
              )}
              {lightningError && (
                <span className="text-red-400">
                  FEED ERROR — {lightningErr instanceof Error ? lightningErr.message.slice(0, 60) : 'unknown'}
                </span>
              )}
              {lightningDecoded && !lightningError && (
                <span>
                  {/* "detections": in the satellite-overlap zone one physical
                      flash can be seen (and counted) by both satellites */}
                  <span className="text-sky-300">{lightningDecoded.count.toLocaleString()}</span>{' '}
                  detections ·{' '}
                  {lightningDecoded.meta.mode === 'live'
                    ? `last ${lightningDecoded.meta.windowMin} min`
                    : `${lightningDecoded.meta.windowMin} min to ${new Date(lightningDecoded.meta.fetchedAt).toISOString().slice(11, 16)}Z`}{' '}
                  · GOES GLM
                  {lightningDecoded.meta.backfill < 0.98 &&
                    ` · filling ${Math.round(lightningDecoded.meta.backfill * 100)}%`}
                </span>
              )}
            </>
          )}
        </div>
        {globe === 'lightning' && lightningDecoded && (
          <div className="mt-1 font-mono text-[10px] text-slate-500">
            {lightningDecoded.meta.sats.map((s, i) => {
              // live payloads: freshness vs the wall clock. Baked payloads:
              // freshness AT BAKE TIME — the headline already anchors the
              // snapshot ("60 min to HH:MMZ"); blaming satellites for the
              // snapshot's age would misattribute it ("West 18m behind"
              // while West was <1m fresh when baked).
              const baseSec =
                lightningDecoded.meta.mode === 'live'
                  ? Date.now() / 1000
                  : Date.parse(lightningDecoded.meta.fetchedAt) / 1000 || Date.now() / 1000
              const label = s.id.startsWith('MTI') ? 'MTG' : s.name.replace('GOES-', '')
              // "behind" is cadence-relative: GLM lands every 20 s, Meteosat
              // products every 10 min — a 12-minute-old MTG product is normal
              const behindMin = (s.cadenceSec / 60) * 2 + 10
              if (!s.lastGranuleSec)
                return (
                  <span key={s.id}>
                    {i > 0 && ' · '}
                    {label}{' '}
                    {/* only call a satellite DARK once its bucket has actually
                        been listed with nothing pending — a cold-starting
                        server is "acquiring", not a dual outage */}
                    {s.everListed && s.pendingKeys === 0 ? (
                      <span className="text-red-400/90">DARK</span>
                    ) : (
                      <span className="animate-pulse text-slate-400">acquiring…</span>
                    )}
                  </span>
                )
              const lagMin = Math.max(0, baseSec - s.lastGranuleSec) / 60
              return (
                <span key={s.id}>
                  {i > 0 && ' · '}
                  {label}{' '}
                  <span className={lagMin > behindMin ? 'text-amber-400/90' : 'text-sky-400/90'}>
                    {lagMin > behindMin ? `${Math.round(lagMin)}m behind` : `live ${lagMin < 1 ? '<1' : Math.round(lagMin)}m`}
                  </span>
                  {s.failedKeys > 8 && <span className="text-amber-400/80"> ({s.failedKeys} gaps)</span>}
                </span>
              )
            })}
            {lightningDecoded.meta.mode === 'live' && (
              <span>
                {' '}· upd {new Date(lightningDecoded.meta.fetchedAt).toISOString().slice(11, 16)}Z
              </span>
            )}
          </div>
        )}
        {globe === 'severe' && severeData && (
          <div className="mt-1 font-mono text-[10px] text-slate-500">
            NWS warnings · SPC reports/outlook · US coverage ·{' '}
            {severeData.mode === 'live' ? 'upd' : 'as of'}{' '}
            {new Date(severeData.fetchedAt).toISOString().slice(11, 16)}Z
          </div>
        )}
        <GlobeSwitcher className="mt-2" />
        {debug && (
          <div className="mt-1 font-mono text-[10px] text-cyan-500/80">
            {fps} fps · {quality.tier} · rendering{' '}
            {globe === 'lightning'
              ? `${(lightningData?.count ?? 0).toLocaleString()}${
                  lightningData && lightningData.count !== lightningData.meta.count
                    ? ` of ${lightningData.meta.count.toLocaleString()}`
                    : ''
                } ⚡`
              : `${(data?.count ?? 0).toLocaleString()}${
                  data && data.count !== data.meta.count ? ` of ${data.meta.count.toLocaleString()}` : ''
                }`}
            {quota ? ` · quota ${quota.current}/${quota.limit}` : ''}
          </div>
        )}
      </header>

      {/* Required data attribution (§10 footer) */}
      <footer
        className={`absolute bottom-1 left-2 z-0 px-2 py-1 text-[9px] tracking-wide text-slate-600 ${glass}`}
      >
        Active fire data: NASA FIRMS (MODIS/VIIRS) · Lightning: NOAA GOES GLM + EUMETSAT MTG-LI ·
        Severe weather: NOAA NWS/SPC · Named events: NASA EONET · Boundaries: Natural Earth ·
        US perimeters: NIFC
      </footer>
    </div>
  )
}
