/**
 * AuctionPanel — reusable sticky auction widget.
 *
 * Used in three places:
 *   - /lot/:id  — full variant (with bid controls, settle, post-settle actions)
 *   - Landing   — compact variant (clock + bid + CTA link to /lot/:id)
 *   - /lots     — compact one-line strip variant
 *
 * The full variant owns all wagmi write hooks and the gasless bid flow.
 * The compact variant shows only the real-time data and links to the full page.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { Link } from 'react-router-dom'
import {
  Gavel, Timer, Lightning, ArrowRight, ArrowSquareOut,
} from '@phosphor-icons/react'
import { type LotTuple } from '../abi'
import { fmtUsdc, fmtDuration, shortAddr } from '../utils'
import TokenIcon from './TokenIcon'

export interface AuctionPanelProps {
  lotId: bigint
  lot: LotTuple
  secs: number
  extended: boolean
  compact?: boolean
  /** Only for compact: navigate to lot page on CTA click */
  className?: string
  /** Formatted asset label ('17 EURC', 'NFT #3') for on-chain lots */
  assetLabel?: string

  // ── Image priority (highest wins) ───────────────────────────────────────────
  /** Seller-uploaded image URL from lot metadata (highest priority). */
  lotImage?: string
  /** Auto-fetched NFT image from tokenURI/uri. */
  nftImage?: string
  /** ERC-20 token address for the token icon. */
  tokenIconAddress?: string
  /** Symbol for the token icon badge. */
  tokenIconSymbol?: string
}

/** A compact, read-only live panel for the landing hero and /lots strip. */
export function CompactPanel({
  lotId, lot, secs, extended, className = '', assetLabel,
  lotImage, nftImage, tokenIconAddress, tokenIconSymbol,
}: AuctionPanelProps) {
  const isLive    = !lot.settled && !lot.cancelled && secs > 0
  const urgent    = isLive && secs < 30
  const NULL_ADDR = '0x0000000000000000000000000000000000000000'

  const displayImage = lotImage || nftImage || null

  return (
    <Link
      to={`/lot/${lotId}`}
      className={`block rounded-panel border border-line bg-surface hover:border-accent/30 transition-colors ${className}`}
    >
      {/* Thumbnail */}
      {displayImage && (
        <div className="overflow-hidden rounded-t-panel aspect-[16/9] bg-surface-2">
          <img src={displayImage} alt={`Lot #${lotId}`} className="w-full h-full object-cover" loading="lazy" />
        </div>
      )}

      <div className="p-5 space-y-4">
        {/* Live tag */}
        {isLive && (
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-tag bg-accent/15 text-accent-text text-[10px] font-semibold uppercase tracking-widest">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              Live
            </span>
            {lot.extensions > 0n && (
              <span className="text-[10px] text-ink-3 font-mono">{lot.extensions.toString()} ext</span>
            )}
          </div>
        )}

        {/* Clock */}
        {isLive && (
          <div className="relative">
            <AnimatePresence>
              {extended && (
                <motion.span
                  key="ext"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="absolute -top-5 left-0 text-xs font-semibold text-warn bg-warn/15 px-2 py-0.5 rounded-tag"
                >
                  +10 s
                </motion.span>
              )}
            </AnimatePresence>
            <p className={`font-mono tabular-nums text-5xl font-bold tracking-tight leading-none ${
              extended ? 'text-warn' : urgent ? 'text-accent' : 'text-ink'
            }`}>
              {fmtDuration(secs)}
            </p>
            {urgent && secs > 0 && (
              <p className="text-xs text-accent-text mt-1 flex items-center gap-1">
                <Timer size={11} /> A bid now adds 10 seconds
              </p>
            )}
          </div>
        )}

        {/* Current bid */}
        <div>
          <p className="text-xs text-ink-3 mb-0.5">{lot.highestBid > 0n ? 'Current bid' : 'Reserve'}</p>
          <div className="flex items-center gap-1.5">
            {tokenIconAddress && (
              <TokenIcon address={tokenIconAddress} symbol={tokenIconSymbol} size={20} />
            )}
            <p className="font-mono tabular-nums text-3xl font-bold text-ink leading-none">
              {fmtUsdc(lot.highestBid > 0n ? lot.highestBid : lot.reserve)}
            </p>
          </div>
        </div>

        {/* Leader */}
        {lot.highestBidder !== NULL_ADDR && (
          <p className="text-xs font-mono text-ink-2 truncate">
            {shortAddr(lot.highestBidder)}
          </p>
        )}

        {/* Asset label for on-chain lots */}
        {assetLabel && (
          <p className="text-xs text-ink-3">{assetLabel}</p>
        )}

        {/* CTA */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-ink-3 font-mono">Min step {fmtUsdc(lot.minIncrement)}</span>
          <span className="flex items-center gap-1 text-xs font-semibold text-accent-text">
            Bid <ArrowRight size={12} />
          </span>
        </div>
      </div>
    </Link>
  )
}

/** Hero bezel wrapper for the landing page — adds the nested bezel frame. */
export function BezelPanel({
  lotId, lot, secs, extended, assetLabel, lotImage, nftImage, tokenIconAddress, tokenIconSymbol,
}: AuctionPanelProps) {
  const isLive = !lot.settled && !lot.cancelled && secs > 0
  return (
    <div className={`rounded-[22px] p-1.5 ring-1 ring-line bg-surface/60 ${isLive ? 'shadow-clock' : ''}`}>
      {/* Inset top highlight */}
      <div className="relative rounded-[16px] bg-surface overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-ink/10 to-transparent pointer-events-none" />
        <CompactPanel
          lotId={lotId} lot={lot} secs={secs} extended={extended}
          assetLabel={assetLabel}
          lotImage={lotImage} nftImage={nftImage}
          tokenIconAddress={tokenIconAddress} tokenIconSymbol={tokenIconSymbol}
        />
      </div>
    </div>
  )
}

/** Lot placeholder panel shown in bezel when no lot is live (scan has succeeded). */
export function BezelPlaceholder({
  lastLotId, lastBid, nextLotId,
}: { lastLotId?: bigint; lastBid?: bigint; nextLotId?: number }) {
  // "List the first lot" only when the contract is genuinely empty.
  const isEmpty = nextLotId === 0

  return (
    <div className="rounded-[22px] p-1.5 ring-1 ring-line bg-surface/60">
      <div className="rounded-[16px] bg-surface p-5 space-y-4 min-h-[200px] flex flex-col justify-center">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-pulse" />
          <span className="text-xs text-ink-3">No lot is live right now</span>
        </div>

        {/* Last result row — always show when available */}
        {lastBid !== undefined && lastBid > 0n && lastLotId !== undefined ? (
          <Link to={`/lot/${lastLotId}`} className="group space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-ink-3">Last result</p>
            <p className="font-mono tabular-nums text-3xl font-bold text-ink">
              {fmtUsdc(lastBid)}
            </p>
            <p className="text-xs text-ink-2 group-hover:text-accent-text transition-colors flex items-center gap-1">
              View lot <ArrowSquareOut size={10} />
            </p>
          </Link>
        ) : isEmpty ? (
          /* Only show "List the first lot" when nextLotId is confirmed 0 */
          <div className="space-y-2">
            <Gavel size={32} weight="thin" className="text-ink-3" />
            <Link to="/create" className="text-sm text-ink-2 hover:text-accent-text transition-colors">List the first lot</Link>
          </div>
        ) : (
          /* nextLotId > 0 but no settled lot in recent 24 — offer Browse */
          <Link to="/lots" className="text-sm text-ink-2 hover:text-accent-text transition-colors flex items-center gap-1">
            Browse lots <ArrowSquareOut size={12} />
          </Link>
        )}
      </div>
    </div>
  )
}

/** Mini strip panel for the top of /lots — single row. */
export function StripPanel({
  lotId, lot, secs, extended: _extended,
}: AuctionPanelProps) {
  const isLive = !lot.settled && !lot.cancelled && secs > 0
  const urgent = isLive && secs < 30

  return (
    <Link
      to={`/lot/${lotId}`}
      className="flex items-center gap-4 rounded-panel border border-line bg-surface hover:bg-surface-2 transition-colors px-5 py-3"
    >
      {isLive && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-tag bg-accent/15 text-accent-text text-[10px] font-semibold uppercase tracking-widest shrink-0">
          <span className="w-1 h-1 rounded-full bg-accent animate-pulse" />
          Live
        </span>
      )}
      <p className="font-medium text-ink text-sm truncate flex-1">Lot #{lotId.toString()}</p>
      <p className={`font-mono tabular-nums font-bold text-base shrink-0 ${urgent ? 'text-accent' : 'text-ink'}`}>
        {fmtDuration(secs)}
      </p>
      <p className="font-mono tabular-nums text-sm text-ink-2 shrink-0">
        {fmtUsdc(lot.highestBid > 0n ? lot.highestBid : lot.reserve)}
      </p>
      <span className="flex items-center gap-1 text-xs font-semibold text-accent-text shrink-0">
        {isLive && <Lightning size={11} weight="fill" />} Bid <ArrowRight size={11} />
      </span>
    </Link>
  )
}
