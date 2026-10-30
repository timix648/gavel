/**
 * Shared viem fallback transport for Arc Mainnet.
 *
 * Wraps every entry in RPC_URLS with http() (batch + 10 s timeout, no per-URL
 * retries so the fallback chain can take over immediately on a 429/-32005).
 * The fallback itself retries up to 2 times (one full rotation through the
 * list) with a 400 ms delay between attempts.
 *
 * On each page load the public endpoints are shuffled so visitors spread across
 * providers, while VITE_RPC_URL (when set) stays pinned at index 0.
 *
 * Import `arcTransport` wherever a viem transport is needed, and
 * `makePublicClient` for a ready-to-use PublicClient.
 */

import { createPublicClient, fallback, http } from 'viem'
import { CHAIN, RPC_URLS } from './chain'

/** Shuffle in-place using Fisher-Yates. */
function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Build the ordered URL list once per page load.
 * VITE_RPC_URL stays first if set; the four public endpoints are shuffled.
 */
function buildOrderedUrls(): readonly string[] {
  const [first, ...rest] = RPC_URLS
  if (!first) return []
  const hasPrivate = !!import.meta.env.VITE_RPC_URL
  if (hasPrivate) {
    // first = VITE_RPC_URL, rest = public endpoints — shuffle the public ones
    return [first, ...shuffled(rest)]
  }
  // No private URL — shuffle everything
  return shuffled([first, ...rest])
}

const _orderedUrls = buildOrderedUrls()

/**
 * viem fallback transport over all known Arc Mainnet endpoints.
 * retryCount: 0 per-URL so a 429 falls through immediately;
 * the outer fallback retries up to 2 times (full list traversal × 2).
 */
export const arcTransport = fallback(
  _orderedUrls.map(url =>
    http(url, {
      batch:       { wait: 20 },
      retryCount:  0,
      timeout:     10_000,
    }),
  ),
  { retryCount: 2, retryDelay: 400 },
)

/**
 * A ready-to-use PublicClient on Arc Mainnet using the fallback transport.
 * Import this instead of calling createPublicClient() directly in src/.
 */
export const publicClient = createPublicClient({
  chain:     CHAIN,
  transport: arcTransport,
})
