/**
 * useBlock — subscribe to the latest block on the target chain.
 *
 * Returns { blockTimestamp, blockNumber } — updated on every new block.
 *
 * One shared poller for the whole app: every component that calls
 * useLatestBlock() subscribes to the same module-level store, so a page with
 * many lot cards still makes one block request per interval instead of one per
 * card. Polling pauses while the tab is hidden.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPublicClient, http } from 'viem'
import { CHAIN, RPC_URL } from './chain'

export interface BlockInfo {
  blockTimestamp: bigint   // block.timestamp (seconds)
  blockNumber: bigint
}

/** How often the shared poller asks for the latest block. Countdowns interpolate between polls. */
export const BLOCK_POLL_MS = 2000

const client = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL, { retryCount: 2, retryDelay: 1500 }),
})

let current: BlockInfo | undefined
/** Wall-clock ms when `current` was received, for interpolating chain time between polls. */
let receivedAt = 0
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let failures = 0

async function tick() {
  timer = undefined
  if (listeners.size === 0) return
  if (typeof document !== 'undefined' && document.hidden) return // resumed by visibilitychange
  try {
    const b = await client.getBlock()
    failures = 0
    if (!current || b.number !== current.blockNumber) {
      current = { blockTimestamp: b.timestamp, blockNumber: b.number }
      receivedAt = Date.now()
      listeners.forEach(l => l())
    }
  } catch {
    failures++
  }
  // Back off on repeated failures (rate limits), up to 30 s.
  const delay = failures === 0 ? BLOCK_POLL_MS : Math.min(30_000, BLOCK_POLL_MS * 2 ** failures)
  if (listeners.size > 0 && !timer) timer = setTimeout(() => void tick(), delay)
}

function start() {
  if (!timer) timer = setTimeout(() => void tick(), 0)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && listeners.size > 0) start()
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) { clearTimeout(timer); timer = undefined }
  }
}

const getSnapshot = () => current

export function useLatestBlock(): BlockInfo | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Current chain time in seconds: last block timestamp + time elapsed since it arrived.
 *  Never reads the user's PC clock as an absolute time (PCs can be many seconds off). */
export function chainNowSec(): number | undefined {
  if (!current) return undefined
  return Number(current.blockTimestamp) + (Date.now() - receivedAt) / 1000
}

/** chainNowSec(), re-rendering every `tickMs`. Undefined until the first block arrives. */
export function useChainNow(tickMs = 250): number | undefined {
  useLatestBlock() // keep the shared poller running while this is mounted
  const [now, setNow] = useState(chainNowSec)
  useEffect(() => {
    const t = setInterval(() => setNow(chainNowSec()), tickMs)
    return () => clearInterval(t)
  }, [tickMs])
  return now
}
