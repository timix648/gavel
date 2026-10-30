/**
 * LiveStatsStrip — slim one-line strip showing mainnet track record.
 * Reads from the shared log store (same counting as Landing §2):
 *   bids  = Bid events only  (RelayedBid is NOT counted separately)
 *   gasless = RelayedBid events
 *   volume  = sum of Bid.amount
 *   settled = Hammer events
 * Hidden until at least one Bid event has loaded (never flashes zeros).
 * Links to /proof.
 */
import { Link } from 'react-router-dom'
import { useLogStore } from '../useLogs'
import { fmtUsdc } from '../utils'

export default function LiveStatsStrip() {
  const { logs } = useLogStore()

  const bidLogs     = logs.filter(l => l.name === 'Bid')
  const relayedLogs = logs.filter(l => l.name === 'RelayedBid')
  const hammerLogs  = logs.filter(l => l.name === 'Hammer')

  // Hide until we have at least one Bid log — never flash zeros.
  if (bidLogs.length === 0) return null

  const totalVolume  = bidLogs.reduce((s, l) => s + ((l.args.amount as bigint) ?? 0n), 0n)
  const bids         = bidLogs.length
  const gasless      = relayedLogs.length
  const settled      = hammerLogs.length

  return (
    <div className="border-b border-line bg-surface-2 py-2 px-4 md:px-8 xl:px-12">
      <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-ink-3 tabular-nums leading-snug">
          <span className="font-semibold text-ink">Live on Arc mainnet:</span>
          {' '}{fmtUsdc(totalVolume)} USDC bid
          {' '}·{' '}{bids.toLocaleString()} bids ({gasless.toLocaleString()} gasless)
          {' '}·{' '}{settled.toLocaleString()} lots settled
        </p>
        <Link
          to="/proof"
          className="text-xs text-accent-text hover:underline underline-offset-2 whitespace-nowrap shrink-0"
        >
          Verify on-chain
        </Link>
      </div>
    </div>
  )
}
