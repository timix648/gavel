/**
 * logStore — shared in-memory + localStorage AuctionHouse event log cache.
 *
 * Scanning strategy
 * -----------------
 * • One address-only getLogs per chunk (no per-event topic filter).
 * • decodeEventLog against the full ABI; unknown topics silently skipped.
 * • Chunk size: LOGS_CHUNK_SIZE (100 000 blocks). Only halved on a genuine
 *   range/size RPC error. On -32005 / "rate limit" / HTTP 429 we backoff and
 *   retry the SAME range — firing more calls would make throttling worse.
 * • Minimum LOGS_MIN_INTERVAL_MS between calls (default 400 ms) to stay
 *   within the public RPC's request rate.
 * • RPC URL rotation: after LOG_RATELIMIT_THRESHOLD consecutive rate-limit
 *   hits the store advances to the next URL in RPC_URLS (wraps around).
 *
 * Persistence
 * -----------
 * Decoded logs + high-water mark are persisted to localStorage keyed by
 *   gavel:logs:<chainId>:<contractAddress>:<deployBlock>
 * so a returning visitor only scans new blocks. Every localStorage access is
 * wrapped in try/catch to handle quota errors and private browsing.
 *
 * Error handling
 * --------------
 * On final failure after all backoff attempts the store:
 *   • keeps everything already loaded — never throws away partial results
 *   • sets _error to a human-readable message including a retry countdown
 *   • sets _pausedUntil so auto-resume fires after the backoff delay
 * Callers poll getError() and getPausedUntil() to show the status UI.
 *
 * Subscriber pattern
 * ------------------
 * Components call subscribe() to receive incremental batches without
 * re-scanning from scratch.
 */

import { decodeEventLog, type PublicClient } from 'viem'
import {
  AUCTION_HOUSE_ADDRESS, CHAIN_ID, DEPLOY_BLOCK,
  LOGS_CHUNK_SIZE, LOGS_MIN_INTERVAL_MS,
} from './chain'
import { publicClient as _defaultClient } from './rpc'
import auctionHouseArtifact from '../contracts/out/AuctionHouse.sol/AuctionHouse.json'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DecodedLog {
  name:             string
  blockNumber:      bigint
  transactionHash:  `0x${string}`
  args:             Record<string, unknown>
}

export type StoreSubscriber = (newLogs: DecodedLog[], highWater: bigint) => void

// ── ABI ───────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AH_ABI = auctionHouseArtifact.abi as any[]

// ── Error classification ──────────────────────────────────────────────────────

function isRateLimitError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  // -32005, HTTP 429, "rate limit", "too many requests"
  return (
    msg.includes('-32005') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('429') ||
    msg.includes('limit exceeded')
  )
}

function isRangeSizeError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  // Explicit phrases for "range too wide" — safe to halve the chunk
  return (
    msg.includes('range too large') ||
    msg.includes('requested range too large') ||
    msg.includes('block range') ||
    msg.includes('query returned more than') ||
    msg.includes('response size') ||
    msg.includes('too many blocks')
  )
}

// RPC rotation is handled by the viem fallback transport in src/rpc.ts.

// ── localStorage persistence ──────────────────────────────────────────────────

const LS_KEY = `gavel:logs:${CHAIN_ID}:${AUCTION_HOUSE_ADDRESS}:${DEPLOY_BLOCK.toString()}`

interface PersistedCache {
  highWater: string           // bigint serialised as decimal string
  logs: Array<{
    name: string
    blockNumber: string       // bigint as decimal string
    transactionHash: string
    args: Record<string, unknown>
  }>
}

// Event args hold bigints (amounts, lot ids). JSON cannot store them, so they are saved as
// { "$big": "123" } and revived on load. Without this, amounts came back as strings and
// summing them on the landing page produced "NaN USDC".
const BIG_TAG = '$big'
const bigReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { [BIG_TAG]: v.toString() } : v)
const bigReviver = (_k: string, v: unknown) =>
  (v && typeof v === 'object' && BIG_TAG in (v as Record<string, unknown>) && Object.keys(v).length === 1
    ? BigInt((v as Record<string, string>)[BIG_TAG])
    : v)

function lsLoad(): { logs: DecodedLog[]; highWater: bigint } | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw, bigReviver) as PersistedCache
    // A cache written before bigint tagging has string amounts: drop it and rescan.
    const stale = parsed.logs.some(l => Object.values(l.args).some(v => typeof v === 'string' && /^\d+n?$/.test(v)))
    if (stale) { localStorage.removeItem(LS_KEY); return null }
    return {
      highWater: BigInt(parsed.highWater),
      logs: parsed.logs.map(l => ({
        name:            l.name,
        blockNumber:     BigInt(l.blockNumber),
        transactionHash: l.transactionHash as `0x${string}`,
        args:            l.args,
      })),
    }
  } catch {
    return null
  }
}

function lsSave(logs: DecodedLog[], highWater: bigint) {
  try {
    const payload: PersistedCache = {
      highWater: highWater.toString(),
      logs: logs.map(l => ({
        name:            l.name,
        blockNumber:     l.blockNumber.toString(),
        transactionHash: l.transactionHash,
        args:            l.args,
      })),
    }
    localStorage.setItem(LS_KEY, JSON.stringify(payload, bigReplacer))
  } catch {
    // Quota exceeded or private browsing — silently continue without persistence
  }
}

// ── Module-level state ────────────────────────────────────────────────────────

/** All decoded logs from DEPLOY_BLOCK to highWater, newest-first. */
let _logs: DecodedLog[] = []
/** Last block fully scanned. 0n = nothing scanned yet. */
let _highWater = 0n
/** True while a scan is in flight. */
let _scanning = false
/** Human-readable error message, or null. */
let _error: string | null = null
/**
 * Wall-clock ms at which the store will auto-resume after a rate-limit pause.
 * 0 = not paused.
 */
let _pausedUntil = 0
/** Registered change listeners. */
const _subscribers = new Set<StoreSubscriber>()

// Hydrate from localStorage on module load (runs once at import time).
;(function hydrateFromLocalStorage() {
  const cached = lsLoad()
  if (cached && cached.highWater >= DEPLOY_BLOCK) {
    _logs      = cached.logs
    _highWater = cached.highWater
  }
})()

// ── Public getters ────────────────────────────────────────────────────────────

export const getLogs        = (): DecodedLog[]    => _logs
export const getHighWater   = (): bigint          => _highWater
export const getError       = (): string | null   => _error
export const getPausedUntil = (): number          => _pausedUntil
export const isScanning     = (): boolean         => _scanning

export function subscribe(fn: StoreSubscriber): () => void {
  _subscribers.add(fn)
  return () => { _subscribers.delete(fn) }
}

function notify(newLogs: DecodedLog[]) {
  for (const fn of _subscribers) fn(newLogs, _highWater)
}

// ── Timing helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Returns a jittered delay in ms: base * (0.75 + 0.5 * random). */
function jitter(baseMs: number): number {
  return Math.round(baseMs * (0.75 + 0.5 * Math.random()))
}

// ── One getLogs call with rate-limit backoff ──────────────────────────────────

const RATE_LIMIT_BACKOFF_MS  = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]
const MIN_CHUNK              = 1_000n

/**
 * Session-learned working chunk size.
 * Starts at LOGS_CHUNK_SIZE; halved whenever fetchRange encounters a range-size
 * error, and never reset upward. Later calls start from this floor instead of
 * re-halving from LOGS_CHUNK_SIZE every time.
 */
let _learnedChunkSize: bigint = LOGS_CHUNK_SIZE

interface FetchRangeResult {
  logs: DecodedLog[]
  /** Actual toBlock used (may be less than requested if chunk was halved). */
  toBlock: bigint
}

/**
 * Fetch logs for [from, to] with:
 *   - rate-limit backoff (exponential + jitter, 8 attempts, no halving)
 *   - range-size halving (down to MIN_CHUNK, 4 halvings max)
 *   - minimum LOGS_MIN_INTERVAL_MS inter-call pacing
 *
 * On unrecoverable failure throws so the caller can surface an error.
 * On rate-limit exhaustion sets _pausedUntil so the UI can show a countdown.
 */
let _lastCallAt = 0

async function fetchRange(
  client: PublicClient,
  from: bigint,
  to: bigint,
  onPauseNotify?: (resumeMs: number) => void,
): Promise<FetchRangeResult> {
  // Start from the session-learned floor, not always from the requested range
  const requestedSize = to - from + 1n
  let attempt = requestedSize < _learnedChunkSize ? requestedSize : _learnedChunkSize
  const MIN_HALVINGS = 6  // 10k → 5k → 2.5k → 1.25k → MIN_CHUNK

  for (let halvings = 0; halvings <= MIN_HALVINGS; halvings++) {
    const chunkTo = from + attempt - 1n <= to ? from + attempt - 1n : to

    // Rate-limit backoff loop for this chunk size
    for (let rl = 0; rl < RATE_LIMIT_BACKOFF_MS.length; rl++) {
      // Enforce minimum inter-call interval
      const now = Date.now()
      const sinceLast = now - _lastCallAt
      if (sinceLast < LOGS_MIN_INTERVAL_MS) {
        await sleep(LOGS_MIN_INTERVAL_MS - sinceLast)
      }

      try {
        _lastCallAt = Date.now()
        const raw = await client.getLogs({
          address:   AUCTION_HOUSE_ADDRESS,
          fromBlock: from,
          toBlock:   chunkTo,
        })
        // If we halved to get here, remember the working size for future calls
        if (attempt < _learnedChunkSize) {
          _learnedChunkSize = attempt < MIN_CHUNK ? MIN_CHUNK : attempt
        }

        const decoded: DecodedLog[] = []
        for (const log of raw) {
          if (!log.topics[0]) continue
          try {
            const d = decodeEventLog({
              abi:    AH_ABI,
              data:   log.data,
              topics: log.topics,
            }) as { eventName: string; args: Record<string, unknown> }
            decoded.push({
              name:            d.eventName,
              blockNumber:     log.blockNumber ?? 0n,
              transactionHash: log.transactionHash,
              args:            d.args,
            })
          } catch {
            // Unknown event — skip silently
          }
        }
        return { logs: decoded, toBlock: chunkTo }

      } catch (e: unknown) {
        if (isRateLimitError(e)) {
          const backoffMs  = RATE_LIMIT_BACKOFF_MS[rl]
          const waitMs     = jitter(backoffMs)
          const resumeAt   = Date.now() + waitMs

          _pausedUntil = resumeAt
          _error       = `Loading paused: public RPC is rate-limiting, retrying in ${Math.ceil(waitMs / 1000)}s`
          onPauseNotify?.(resumeAt)

          await sleep(waitMs)
          _pausedUntil = 0
          // DON'T halve — retry the same range
          continue
        }

        if (isRangeSizeError(e) && attempt > MIN_CHUNK) {
          // Genuine "range too big" — halve and try again from the outer loop
          break
        }

        // Any other error — surface immediately
        throw new Error(`getLogs failed on [${from}, ${chunkTo}]: ${String(e).slice(0, 300)}`)
      }
    }

    // If we exhausted all rate-limit retries at this chunk size, surface the error.
    // If we broke out due to a range error, halve.
    if (halvings < MIN_HALVINGS && attempt > MIN_CHUNK) {
      attempt = attempt / 2n < MIN_CHUNK ? MIN_CHUNK : attempt / 2n
    } else if (halvings >= MIN_HALVINGS) {
      throw new Error(`getLogs repeatedly failed on [${from}, ${from + attempt - 1n}] after ${halvings} halvings`)
    }
  }

  throw new Error(`getLogs failed on [${from}, ${to}]: all attempts exhausted`)
}

// ── Public scan API ───────────────────────────────────────────────────────────

/**
 * Kick off (or extend) the full scan from DEPLOY_BLOCK to current head.
 * Safe to call on every new block — no-ops if already scanning or caught up.
 *
 * @param clientOverride  Optional viem PublicClient. When omitted the store
 *   creates one from the current RPC_URLS entry so the scan works outside
 *   React (e.g. in the CLI scan script).
 * @param onProgress  Called with (currentBlock, headBlock) after each chunk.
 */
export async function scanLogs(
  clientOverride?: PublicClient,
  onProgress?: (current: bigint, head: bigint) => void,
): Promise<void> {
  if (_scanning) return
  _scanning = true
  _error    = null

  // Use the shared fallback transport client when not provided by the React context.
  const client = clientOverride ?? _defaultClient

  function onPauseNotify(_resumeMs: number) {
    // Subscribers get notified of the error state change so UI can update.
    notify([])
  }

  try {
    const head = await client.getBlockNumber()
    const from = _highWater === 0n ? DEPLOY_BLOCK : _highWater + 1n

    if (from > head) {
      _scanning = false
      return
    }

    let cur = from
    while (cur <= head) {
      const requestedTo = cur + _learnedChunkSize - 1n <= head ? cur + _learnedChunkSize - 1n : head
      onProgress?.(cur, head)

      // fetchRange may use a smaller chunkTo if halving was needed.
      const { logs: batch, toBlock: actualTo } = await fetchRange(
        client, cur, requestedTo, onPauseNotify,
      )

      if (batch.length > 0) {
        const sorted = [...batch].sort((a, b) =>
          a.blockNumber < b.blockNumber ? 1 : a.blockNumber > b.blockNumber ? -1 : 0
        )
        _logs      = [...sorted, ..._logs]
        _highWater = actualTo
        lsSave(_logs, _highWater)
        notify(batch)
      } else {
        _highWater = actualTo
        lsSave(_logs, _highWater)
      }

      cur = actualTo + 1n

      // If we were showing a rate-limit pause message, clear it on success.
      if (_error !== null) { if ((_error as string).indexOf('rate-limiting') !== -1) _error = null }
    }

    // Final progress ping.
    onProgress?.(head, head)
    _error = null
  } catch (e: unknown) {
    _error = String(e)
    // Keep _logs and _highWater intact — never discard partial results.
  }

  _scanning = false
}

/**
 * Reset the in-memory store AND the localStorage cache.
 * Useful when switching networks or forcing a full rescan.
 */
export function resetStore(): void {
  _logs      = []
  _highWater = 0n
  _scanning  = false
  _error     = null
  _pausedUntil = 0
  try { localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
}
