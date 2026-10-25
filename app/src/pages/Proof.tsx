import { useState, useEffect } from 'react'
import { ArrowSquareOut, Spinner, PauseCircle, Warning } from '@phosphor-icons/react'
import { DEPLOY_BLOCK, txUrl } from '../chain'
import { fmtUsdc, shortAddr } from '../utils'
import { useLogStore, useBlockWatcher, type AnyLog } from '../useLogs'

interface EventRow extends AnyLog { name: string }

const MARKET_EVENTS = new Set([
  'Listed', 'Bid', 'RelayedBid', 'Outbid', 'Extended',
  'Hammer', 'Unsold', 'Claimed', 'BondHeld', 'BondReleased',
  'Disputed', 'DisputeResolved', 'SaleRecorded',
])

function PauseBanner({ pausedUntil }: { pausedUntil: number }) {
  const [secsLeft, setSecsLeft] = useState(() => Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000)))
  useEffect(() => {
    if (pausedUntil === 0) return
    const t = setInterval(() => setSecsLeft(Math.max(0, Math.ceil((pausedUntil - Date.now()) / 1000))), 500)
    return () => clearInterval(t)
  }, [pausedUntil])
  if (pausedUntil === 0) return null
  return (
    <p className="text-sm text-ink-2 flex items-center gap-1.5">
      <PauseCircle size={13} className="text-warn shrink-0" />
      RPC rate-limited, retrying in{' '}
      <span className="font-mono tabular-nums text-warn">{secsLeft}s</span>
      {' '}- results so far are preserved.
    </p>
  )
}

function tagColor(name: string) {
  if (name === 'Bid' || name === 'RelayedBid') return 'bg-accent/15 text-accent'
  if (name === 'Hammer') return 'bg-good/15 text-good'
  if (name === 'Listed') return 'bg-surface-2 text-ink-2'
  return 'bg-surface-2 text-ink-3'
}

export default function Proof() {
  const { logs: allLogs, scanning, progress, highWater, error, pausedUntil } = useLogStore()
  useBlockWatcher()

  const logs = allLogs.filter(l => MARKET_EVENTS.has(l.name))

  let usdcBids = 0n
  let bidsPlaced = 0
  const bidders = new Set<string>()
  let lotsSettled = 0
  for (const log of logs) {
    if (log.name === 'Bid') {
      const amt = log.args.amount
      if (typeof amt === 'bigint') usdcBids += amt
      bidsPlaced++
      const bidder = log.args.bidder
      if (typeof bidder === 'string') bidders.add(bidder.toLowerCase())
    }
    if (log.name === 'Hammer') lotsSettled++
  }

  const progressPct = progress && progress.head > DEPLOY_BLOCK
    ? Math.min(100, Number((progress.current - DEPLOY_BLOCK) * 100n / (progress.head - DEPLOY_BLOCK)))
    : (highWater > 0n ? 100 : 0)

  function argsString(row: EventRow) {
    const a = row.args
    const parts: string[] = []
    if ('lotId'   in a) parts.push(`lot #${String(a.lotId)}`)
    const amtKey = 'amount' in a ? 'amount' : 'previousBid' in a ? 'previousBid' : 'bond' in a ? 'bond' : null
    if (amtKey) { const amt = a[amtKey]; if (typeof amt === 'bigint') parts.push(fmtUsdc(amt)) }
    if ('bidder'    in a && typeof a.bidder    === 'string') parts.push(shortAddr(a.bidder))
    if ('winner'    in a && typeof a.winner    === 'string') parts.push(`winner ${shortAddr(a.winner)}`)
    if ('seller'    in a && typeof a.seller    === 'string') parts.push(`seller ${shortAddr(a.seller)}`)
    if ('claimant'  in a && typeof a.claimant  === 'string') parts.push(`claimant ${shortAddr(a.claimant)}`)
    if ('recipient' in a && typeof a.recipient === 'string') parts.push(`to ${shortAddr(a.recipient)}`)
    return parts.join(' - ')
  }

  const isRateLimitPause = pausedUntil > 0
  const hardError = error && !isRateLimitPause ? error : null

  return (
    <div className="py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-semibold text-ink tracking-tight">Chain proof</h1>
        <p className="text-ink-2 mt-2">Everything on this page is read from the chain. No wallet needed.</p>
      </div>

      {/* ── Stat figures — plain large mono, no boxes ───────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
        {[
          { label: 'USDC bid volume',  value: fmtUsdc(usdcBids) },
          { label: 'Bids',             value: bidsPlaced.toLocaleString() },
          { label: 'Distinct bidders', value: bidders.size.toLocaleString() },
          { label: 'Lots settled',     value: lotsSettled.toLocaleString() },
        ].map(t => (
          <div key={t.label}>
            <p className="text-xs text-ink-3 mb-1">{t.label}</p>
            <p className="text-3xl font-mono tabular-nums font-bold text-ink">{t.value}</p>
          </div>
        ))}
      </div>

      {/* ── Inline status line ──────────────────────────────────────── */}
      {(scanning || progressPct < 100 || isRateLimitPause || hardError) && (
        <div className="space-y-1.5">
          {hardError ? (
            <p className="text-sm text-warn flex items-center gap-1.5">
              <Warning size={13} className="shrink-0" />
              {hardError}
            </p>
          ) : isRateLimitPause ? (
            <PauseBanner pausedUntil={pausedUntil} />
          ) : (
            <div className="flex items-center justify-between text-xs text-ink-3">
              <span className="flex items-center gap-1.5">
                {scanning && <Spinner size={11} className="animate-spin" />}
                {scanning ? 'Scanning blocks...' : 'Scan complete'}
              </span>
              <span className="font-mono tabular-nums">{Math.round(progressPct)}%</span>
            </div>
          )}
          {!hardError && !isRateLimitPause && (
            <div className="h-px bg-line overflow-hidden rounded-full">
              <div className="h-full bg-accent transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          )}
          {progress && !hardError && (
            <p className="text-xs text-ink-3 font-mono tabular-nums text-right">
              {progress.current.toLocaleString()} / {progress.head.toLocaleString()}
            </p>
          )}
        </div>
      )}

      {!scanning && highWater > 0n && !hardError && (
        <p className="text-xs text-ink-3 font-mono tabular-nums">
          Cached through block {highWater.toLocaleString()} - updates on each new block
        </p>
      )}

      {/* ── Event table ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-base font-semibold text-ink">Events</p>
          <p className="text-xs text-ink-3 font-mono tabular-nums">{logs.length} market events</p>
        </div>

        {logs.length === 0 && !scanning ? (
          <p className="text-sm text-ink-3 py-6 border-t border-line">No events found.</p>
        ) : (
          <div className="border-t border-line max-h-[70vh] overflow-y-auto">
            {/* Group by block — show a hairline between groups */}
            {logs.map((row, i) => {
              const prevBlock = i > 0 ? logs[i - 1].blockNumber : undefined
              const newBlock  = prevBlock !== row.blockNumber
              return (
                <div
                  key={i}
                  className={`flex items-start justify-between gap-3 py-2.5 ${newBlock && i > 0 ? 'border-t border-line' : ''}`}
                >
                  <div className="flex items-start gap-2 min-w-0">
                    <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-tag ${tagColor(row.name)}`}>
                      {row.name}
                    </span>
                    <span className="text-xs text-ink-2 truncate">{argsString(row)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-ink-3 font-mono tabular-nums hidden md:inline">
                      #{row.blockNumber.toLocaleString()}
                    </span>
                    <a
                      href={txUrl(row.transactionHash)}
                      target="_blank" rel="noopener noreferrer"
                      className="text-ink-3 hover:text-accent-text transition-colors"
                      aria-label="View transaction"
                    >
                      <ArrowSquareOut size={13} />
                    </a>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
