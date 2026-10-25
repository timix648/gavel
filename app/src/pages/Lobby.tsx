import { useEffect, useState, useCallback, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { Link } from 'react-router-dom'
import { ArrowSquareOut } from '@phosphor-icons/react'
import {
  AUCTION_HOUSE_ADDRESS, CHAIN_ID,
  GITHUB_URL, NETWORK_LABEL,
} from '../chain'
import { StudioWatermark } from '../main'
import { AUCTION_HOUSE_ABI, LotTuple } from '../abi'
import type { Abi } from 'viem'
const AH_ABI_TYPED = AUCTION_HOUSE_ABI as Abi
import { useLatestBlock, useChainNow } from '../useBlock'
import LotCard from '../components/LotCard'
import { fmtUsdc, shortAddr } from '../utils'
import { useLogStore } from '../useLogs'

const LOBBY_WINDOW = 24
/** Minimum gap between lobby refreshes, whatever the block rate. */
const LOBBY_REFRESH_MS = 4000

interface LotEntry { lotId: bigint; lot: LotTuple; title: string; hasRelayedBid: boolean }

function getClientTimeSec() { return Date.now() / 1000 }

function decodeLotTitle(uri: string, fallback: string): string {
  if (!uri) return fallback
  if (uri.startsWith('data:application/json')) {
    try {
      const json = JSON.parse(atob(uri.split(',')[1])) as { name?: string }
      return json.name?.trim() || fallback
    } catch { return fallback }
  }
  if (uri.startsWith('https://') || uri.startsWith('http://') || uri.startsWith('ipfs://')) return fallback
  return uri.trim() || fallback
}

const uriTitleCache = new Map<string, string>()

export default function Lobby() {
  const block  = useLatestBlock()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const { logs: allLogs } = useLogStore()

  const [lots, setLots]               = useState<LotEntry[]>([])
  const [initialLoaded, setInitialLoaded] = useState(false)
  const [showAllEnded, setShowAllEnded] = useState(false)
  // Set when the public RPC keeps refusing us: wall-clock ms of the next retry.
  const [busyUntil, setBusyUntil]     = useState(0)
  const gavelAddrRef  = useRef<`0x${string}` | undefined>(undefined)
  const inFlightRef   = useRef(false)
  const lastRunRef    = useRef(0)
  const failuresRef   = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const relayedLotIds = new Set(
    allLogs.filter(l => l.name === 'RelayedBid').map(l => (l.args.lotId as bigint).toString())
  )

  const prevLotsRef = useRef<Map<string, LotEntry>>(new Map())

  const loadLots = useCallback(async () => {
    if (!client || inFlightRef.current) return
    // At most one refresh every LOBBY_REFRESH_MS; block ticks in between are ignored.
    if (Date.now() - lastRunRef.current < LOBBY_REFRESH_MS) return
    inFlightRef.current = true
    lastRunRef.current = Date.now()
    try {
      await loadLotsOnce()
      failuresRef.current = 0
      setBusyUntil(0)
    } catch (err) {
      console.warn('[lobby] refresh failed', err)
      // Rate limited or offline: keep what is on screen, retry with exponential backoff.
      failuresRef.current++
      const delay = Math.min(30_000, 2000 * 2 ** (failuresRef.current - 1))
      setBusyUntil(Date.now() + delay)
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = setTimeout(() => { lastRunRef.current = 0; void loadLots() }, delay)
    } finally {
      inFlightRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // One refresh: nextLotId, then the newest LOBBY_WINDOW lots in one multicall.
  // Titles are best-effort: a failed tokenURI read never blocks the lots from showing.
  async function loadLotsOnce() {
    if (!client) return
    const count = Number(await client.readContract({
      address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'nextLotId', args: [],
    }) as bigint)
    if (count === 0) { setLots([]); setInitialLoaded(true); return }
    if (!gavelAddrRef.current) {
      gavelAddrRef.current = await client.readContract({
        address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'gavelLot', args: [],
      }).catch(() => undefined) as `0x${string}` | undefined
    }
    const gavelAddr = gavelAddrRef.current

    const start = Math.max(0, count - LOBBY_WINDOW)
    const ids = Array.from({ length: count - start }, (_, i) => BigInt(start + i))

    const lotsCalls = ids.map(id => ({
      address: AUCTION_HOUSE_ADDRESS as `0x${string}`,
      abi: AH_ABI_TYPED,
      functionName: 'lots' as const,
      args: [id] as [bigint],
    }))

    // Throws on RPC failure; loadLots() catches and backs off.
    const results = await client.multicall({ contracts: lotsCalls, allowFailure: true })
    const rawLots: (LotTuple | null)[] = results.map((r) => {
        if (r.status !== 'success') return null
        const raw = r.result as readonly [
          `0x${string}`, bigint, bigint, bigint, bigint, bigint, bigint,
          `0x${string}`, bigint, bigint, boolean, boolean, boolean, boolean,
        ]
        return {
          seller: raw[0], tokenId: raw[1], reserve: raw[2], minIncrement: raw[3],
          bond: raw[4], deadline: raw[5], highestBid: raw[6], highestBidder: raw[7],
          extensions: raw[8], settledAt: raw[9], settled: raw[10], cancelled: raw[11],
          bondReleased: raw[12], disputed: raw[13],
        }
      })
    if (results.length > 0 && results.every(r => r.status !== 'success')) throw new Error('all lot reads failed')

    const TOKEN_URI_ABI = [{ name: 'tokenURI', type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' }] as const
    const uncachedIdx: number[] = []
    for (let i = 0; i < rawLots.length; i++) {
      const lot = rawLots[i]
      if (!lot) continue
      const cacheKey = `${gavelAddr}:${lot.tokenId}`
      if (!uriTitleCache.has(cacheKey)) uncachedIdx.push(i)
    }

    if (gavelAddr && uncachedIdx.length > 0) {
      const uriCalls = uncachedIdx.map(i => ({
        address: gavelAddr,
        abi: TOKEN_URI_ABI,
        functionName: 'tokenURI' as const,
        args: [rawLots[i]!.tokenId] as [bigint],
      }))
      try {
        const uriResults = await client.multicall({ contracts: uriCalls, allowFailure: true })
        for (let j = 0; j < uncachedIdx.length; j++) {
          const i = uncachedIdx[j]
          const lot = rawLots[i]!
          const cacheKey = `${gavelAddr}:${lot.tokenId}`
          if (uriResults[j].status === 'success') {
            const uri = uriResults[j].result as string
            uriTitleCache.set(cacheKey, decodeLotTitle(uri, `Lot #${ids[i]}`))
          } else {
            uriTitleCache.set(cacheKey, `Lot #${ids[i]}`)
          }
        }
      } catch {}
    }

    const next = new Map<string, LotEntry>(prevLotsRef.current)
    for (let i = 0; i < rawLots.length; i++) {
      const lot = rawLots[i]
      const lotId = ids[i]
      const key = lotId.toString()
      if (!lot) continue
      const cacheKey = `${gavelAddr}:${lot.tokenId}`
      const title = uriTitleCache.get(cacheKey) ?? `Lot #${lotId}`
      next.set(key, { lotId, lot, title, hasRelayedBid: relayedLotIds.has(key) })
    }
    const windowKeys = new Set(ids.map(id => id.toString()))
    for (const k of next.keys()) {
      if (!windowKeys.has(k)) next.delete(k)
    }
    prevLotsRef.current = next
    setLots(Array.from(next.values()).sort((a, b) => Number(a.lotId - b.lotId)))
    setInitialLoaded(true)
  }

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void loadLots() }, [loadLots, block?.blockNumber])
  useEffect(() => () => clearTimeout(retryTimerRef.current), [])

  // Live countdown for the "RPC busy" line; only ticks while a retry is pending.
  const [busySecs, setBusySecs] = useState(0)
  useEffect(() => {
    if (!busyUntil) return
    const update = () => setBusySecs(Math.max(0, Math.ceil((busyUntil - Date.now()) / 1000)))
    update()
    const t = setInterval(update, 500)
    return () => clearInterval(t)
  }, [busyUntil])

  const nowSec = useChainNow() ?? getClientTimeSec()

  const live  = lots.filter(e => !e.lot.settled && !e.lot.cancelled && Number(e.lot.deadline) > nowSec)
                    .sort((a, b) => Number(a.lot.deadline) - Number(b.lot.deadline))
  const ended = lots.filter(e => e.lot.settled || e.lot.cancelled || Number(e.lot.deadline) <= nowSec)
                    .slice().reverse()

  const endedVisible = showAllEnded ? ended : ended.slice(0, 6)

  return (
    <div className="py-6 space-y-8">

      {/* ── Page title ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold text-ink tracking-tight whitespace-nowrap">Live lots</h1>
        {busyUntil > 0 && (
          <p role="status" className="text-sm text-ink-2">
            The public Arc RPC is busy. Retrying in <span className="font-mono tabular-nums">{busySecs}s</span>
          </p>
        )}
      </div>

      {/* ── Main content: XL = 8/4 split (live grid + ended aside) ─────────── */}
      <div className="xl:grid xl:grid-cols-12 xl:gap-8 space-y-8 xl:space-y-0">

        {/* ── Live lots grid ────────────────────────────────────────────────── */}
        <div className="xl:col-span-8">
          {!initialLoaded ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse">
              {[0,1,2,3].map(i => (
                <div key={i} className={`h-36 rounded-panel bg-surface-2 ${i === 0 ? 'lg:col-span-2' : ''}`} />
              ))}
            </div>
          ) : live.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
              {live.map((e, idx) => (
                <LotCard
                  key={e.lotId.toString()}
                  lotId={e.lotId} lot={e.lot} title={e.title}
                  wide={idx === 0}
                  hasRelayedBid={e.hasRelayedBid}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-panel border border-line bg-surface px-5 py-4">
              <p className="text-sm text-ink-2">No live auction right now.{' '}
                <Link to="/create" className="text-accent-text hover:underline">Create one.</Link>
              </p>
            </div>
          )}
        </div>

        {/* ── Ended aside (XL right column) ────────────────────────────────── */}
        {(ended.length > 0 || !initialLoaded) && (
          <div className="xl:col-span-4">
            {!initialLoaded ? (
              <div className="rounded-panel border border-line bg-surface overflow-hidden animate-pulse">
                {[0,1,2].map(i => (
                  <div key={i} className="h-11 border-b border-line last:border-0 bg-surface-2/50" />
                ))}
              </div>
            ) : ended.length > 0 ? (
              <div className="space-y-3">
                <h2 className="text-sm font-semibold text-ink-2">Recently ended</h2>
                <div className="divide-y divide-line rounded-panel border border-line bg-surface overflow-hidden">
                  {endedVisible.map(e => {
                    const NULL = '0x0000000000000000000000000000000000000000'
                    const sold = e.lot.settled && e.lot.highestBidder !== NULL
                    return (
                      <Link
                        key={e.lotId.toString()}
                        to={`/lot/${e.lotId}`}
                        className="flex items-center justify-between px-4 py-3 hover:bg-surface-2 transition-colors gap-3"
                      >
                        <p className="text-sm text-ink font-medium truncate flex-1">{e.title}</p>
                        <div className="shrink-0 text-right">
                          {sold ? (
                            <>
                              <p className="text-sm font-mono tabular-nums text-ink-2">{fmtUsdc(e.lot.highestBid)}</p>
                              <p className="text-xs text-ink-3 font-mono">{shortAddr(e.lot.highestBidder)}</p>
                            </>
                          ) : (
                            <p className="text-xs text-ink-3">
                              {e.lot.cancelled ? 'Cancelled'
                                : e.lot.highestBidder !== NULL ? 'Awaiting settle'
                                : 'No bids'}
                            </p>
                          )}
                        </div>
                      </Link>
                    )
                  })}
                </div>
                {ended.length > 6 && !showAllEnded && (
                  <button
                    onClick={() => setShowAllEnded(true)}
                    className="text-sm text-ink-2 hover:text-ink transition-colors underline underline-offset-2 block"
                  >
                    Show all {ended.length} ended
                  </button>
                )}
                {lots.length >= LOBBY_WINDOW && (
                  <Link
                    to="/proof"
                    className="text-sm text-ink-2 hover:text-ink transition-colors underline underline-offset-2"
                  >
                    Full history on Proof
                  </Link>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-4 pb-6 text-xs text-ink-3 border-t border-line">
        <Link to="/proof" className="hover:text-ink transition-colors">
          On-chain proof
        </Link>
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-ink transition-colors flex items-center gap-1">
          GitHub <ArrowSquareOut size={11} />
        </a>
        <span>Built on {NETWORK_LABEL}</span>
        <StudioWatermark />
      </footer>
    </div>
  )
}
