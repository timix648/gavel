import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Lightning } from '@phosphor-icons/react'
import { LotTuple } from '../abi'
import { fmtUsdc, shortAddr, fmtDuration } from '../utils'
import { useChainNow } from '../useBlock'

interface Props {
  lotId: bigint
  lot: LotTuple
  title?: string
  wide?: boolean       // spans 2 cols in the grid
  hasRelayedBid?: boolean
  /** Create-page preview: show this duration static, no countdown, "Preview" tag, not a link. */
  previewDurationSecs?: number
}

function getClientTimeSec() { return Date.now() / 1000 }

export default function LotCard({ lotId, lot, title, wide, hasRelayedBid, previewDurationSecs }: Props) {
  const isPreview = previewDurationSecs !== undefined
  // Chain time, interpolated between blocks. Before the first block arrives we fall back
  // to the PC clock once, so the card still renders something sensible.
  const now = useChainNow() ?? getClientTimeSec()

  const deadline  = Number(lot.deadline)
  const remaining = isPreview ? previewDurationSecs : Math.max(0, deadline - now)
  const live      = !isPreview && !lot.settled && !lot.cancelled && remaining > 0
  const settled   = lot.settled
  const urgent    = live && remaining < 30

  const priceDisplay = fmtUsdc(lot.highestBid > 0n ? lot.highestBid : lot.reserve)
  const priceLabel   = lot.highestBid > 0n ? 'Current bid' : 'Reserve'

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={wide ? 'md:col-span-2' : ''}
    >
      <Link
        to={isPreview ? '#' : `/lot/${lotId}`}
        onClick={isPreview ? (e) => e.preventDefault() : undefined}
        aria-disabled={isPreview || undefined}
        tabIndex={isPreview ? -1 : undefined}
        className={`group block rounded-panel border bg-surface transition-colors p-4 md:p-5 ${
          isPreview ? 'border-line cursor-default' : live ? 'border-line hover:border-ink-3 hover:bg-surface-2' : 'border-line hover:bg-surface-2'
        }`}
      >
        {/* Title row */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-ink truncate text-base leading-tight">
              {title ?? `Lot #${lotId}`}
            </p>
            <p className="text-xs text-ink-3 font-mono mt-0.5 truncate">
              {shortAddr(lot.seller)}
            </p>
          </div>

          {/* Status tag */}
          {isPreview ? (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-tag bg-surface-2 text-ink-2">
              Preview
            </span>
          ) : live ? (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-tag bg-accent/15 text-accent">
              Live
            </span>
          ) : settled ? (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-tag bg-good/15 text-good">
              Sold
            </span>
          ) : (
            <span className="shrink-0 text-[10px] font-semibold tracking-wider px-1.5 py-0.5 rounded-tag bg-surface-2 text-ink-3">
              Ended
            </span>
          )}
        </div>

        {/* Price + time row */}
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-[11px] text-ink-3 mb-0.5">{priceLabel}</p>
            <p className={`text-xl font-bold font-mono tabular-nums ${live ? 'text-ink' : 'text-ink-2'}`}>
              {priceDisplay}
            </p>
          </div>

          <div className="text-right">
            {isPreview && (
              <span className="text-sm font-mono tabular-nums text-ink-2" title="The clock starts when the lot is listed">
                {fmtDuration(remaining)}
              </span>
            )}
            {live && (
              <span className={`text-sm font-mono tabular-nums ${urgent ? 'text-accent-text font-semibold' : 'text-ink-2'}`}>
                {fmtDuration(remaining)}
              </span>
            )}
            {settled && lot.highestBidder !== '0x0000000000000000000000000000000000000000' && (
              <span className="text-xs text-ink-3 font-mono">
                {shortAddr(lot.highestBidder)}
              </span>
            )}
          </div>
        </div>

        {/* Gasless tag */}
        {hasRelayedBid && (
          <div className="mt-3 pt-3 border-t border-line flex items-center gap-1 text-[11px] text-ink-3">
            <Lightning size={11} weight="fill" className="text-warn" />
            Gasless bids accepted
          </div>
        )}
      </Link>
    </motion.div>
  )
}
