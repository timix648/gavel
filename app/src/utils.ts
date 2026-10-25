import { USDC_DECIMALS } from './chain'
export { txUrl, addrUrl } from './chain'

// ── USDC formatting ──────────────────────────────────────────────────────────

/** Format a 6-decimal raw bigint as "$X.XX" */
export function fmtUsdc(raw: bigint | undefined): string {
  if (raw === undefined) return '-'
  const n = Number(raw) / 10 ** USDC_DECIMALS
  return `$${n.toFixed(2)}`
}

/** Parse a user-entered string ("1.50") into 6-decimal bigint */
export function parseUsdc(s: string): bigint {
  const n = parseFloat(s)
  if (isNaN(n) || n < 0) return 0n
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS))
}

// ── Address formatting ───────────────────────────────────────────────────────

export function shortAddr(addr: string | undefined): string {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return '-'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ── Time formatting ──────────────────────────────────────────────────────────

export function fmtDuration(secs: number): string {
  if (secs <= 0) return '0:00'
  // Timed listings run for days: "3d 4h" reads better than "76:12:09".
  if (secs >= 86400) {
    const d = Math.floor(secs / 86400)
    const hd = Math.floor((secs % 86400) / 3600)
    return hd > 0 ? `${d}d ${hd}h` : `${d}d`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// ── Error parsing ────────────────────────────────────────────────────────────

export function parseOnchainError(err: unknown): string {
  const e = err as { message?: string; code?: number } | null
  const msg = (e?.message ?? '').toLowerCase()
  if (msg.includes('user rejected') || e?.code === 4001) return 'Cancelled.'
  if (msg.includes('insufficient')) return 'Insufficient USDC balance.'
  if (msg.includes('reverted')) {
    const m = (e?.message ?? '').match(/AuctionHouse: ([^"'\n]+)/)
    return m ? m[1] : 'Transaction reverted.'
  }
  if (msg.includes('network') || msg.includes('timeout')) return 'Network error. Please retry.'
  return 'Something went wrong.'
}
