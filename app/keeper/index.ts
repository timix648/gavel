/**
 * Gavel House Keeper
 * ------------------
 * Runs a continuous house auction on AuctionHouse v5.
 * Each cycle: if no live house lot, list a new one.
 * When a house lot's deadline passes, calls settle().
 * After 7 days, calls releaseBondAfterTimeout() for old lots.
 *
 * State tracking: rebuilds the set of active house lots from Listed events
 * at startup (one chunked log scan), then tracks new lots in memory.
 * Each cycle reads only the tracked lot IDs + nextLotId — not all lots.
 *
 * GET /health → { lastAction, liveLotId, balance, trackedLots, scanReady }
 *
 * Env vars:
 *   HOUSE_PRIVATE_KEY  — 0x-prefixed EOA key (never logged)
 *   AUCTION_HOUSE      — contract address (default from chain constant)
 *   RPC_URL            — optional override
 *   KEEPER_PORT        — HTTP port (default 3002)
 *   CYCLE_MS           — poll interval ms (default 15000)
 */

import {
  createPublicClient, createWalletClient, http,
  parseUnits, encodeFunctionData, formatUnits, decodeEventLog,
  type Hex, type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from './chain-def'
// Import ABI from compiled artifact — never hand-write it
import ahArtifact from '../contracts/out/AuctionHouse.sol/AuctionHouse.json' assert { type: 'json' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AH_ABI = ahArtifact.abi as any[]

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'approve',   type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const

// ── Config ────────────────────────────────────────────────────────────────────

const HOUSE_PRIVATE_KEY = process.env.HOUSE_PRIVATE_KEY as Hex | undefined
if (!HOUSE_PRIVATE_KEY) { console.error('[keeper] HOUSE_PRIVATE_KEY not set — exiting'); process.exit(1) }

const AUCTION_HOUSE = (
  process.env.AUCTION_HOUSE ?? '0x6102D866Dcb9CFeE929Eb6b2A16468E9d0193A2E'
) as Address

const USDC_ADDRESS  = '0x3600000000000000000000000000000000000000' as Address
const USDC_DECIMALS = 6
const DEPLOY_BLOCK  = 28065938n

const RPC_URL  = process.env.RPC_URL   ?? 'https://rpc.mainnet.arc.io'
const PORT     = Number(process.env.KEEPER_PORT ?? 3002)
const CYCLE_MS = Number(process.env.CYCLE_MS    ?? 15_000)

const RESERVE       = parseUnits('0.10', USDC_DECIMALS)
const MIN_INCREMENT = parseUnits('0.05', USDC_DECIMALS)
// Gavel's own always-on lot. 10 minutes: long enough to feel like a real auction,
// short enough that a visitor sees one finish and relist. Override with HOUSE_LOT_SECS.
const DURATION      = Number(process.env.HOUSE_LOT_SECS ?? 600)
const LOW_BAL_WARN  = parseUnits('2', USDC_DECIMALS)
const APPROVE_AMT   = parseUnits('100', USDC_DECIMALS)
const MIN_GAS_WEI   = 20_000_000_000n
const SEVEN_DAYS    = 7 * 24 * 3600

// Starting chunk size for log scans; halved on range errors (down to MIN_CHUNK)
const START_CHUNK = 10_000n
const MIN_CHUNK   = 1_000n

const LOT_TITLES = [
  '30-min code review', 'Logo sketch', 'Custom avatar',
  'Domain name idea', 'Shout-out post', 'Tech stack audit',
  'UI wireframe', 'Tagline brainstorm', 'Color palette', 'Tweet thread draft',
]

// ── Error classification ──────────────────────────────────────────────────────

function isRangeSizeError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('range too large') ||
    msg.includes('requested range too large') ||
    msg.includes('block range') ||
    msg.includes('query returned more than') ||
    msg.includes('response size') ||
    msg.includes('too many blocks')
  )
}

function isRateLimitError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return (
    msg.includes('-32005') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('429') ||
    msg.includes('limit exceeded')
  )
}

// ── Clients ───────────────────────────────────────────────────────────────────

const account      = privateKeyToAccount(HOUSE_PRIVATE_KEY)
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) })
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) })

console.log(`[keeper] house wallet: ${account.address}`)
console.log(`[keeper] AuctionHouse: ${AUCTION_HOUSE}`)
console.log(`[keeper] cycle: ${CYCLE_MS}ms`)

// ── State ─────────────────────────────────────────────────────────────────────

let lastAction = 'started'
let liveLotId: number | null = null
let balance   = '0'
let titleIndex = 0

const activeLotIds = new Set<number>()
let activeScanReady = false

// ── Backoff ───────────────────────────────────────────────────────────────────

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000]
let backoffIdx = 0

function log(msg: string) {
  console.log(`[keeper ${new Date().toISOString()}] ${msg}`)
}

async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      const result = await fn()
      backoffIdx = 0
      return result
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err)
      const isRL = isRateLimitError(err)
      const delay = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)]
      backoffIdx++
      log(`${isRL ? 'rate-limit' : 'error'} — retrying in ${delay}ms: ${msg.slice(0, 120)}`)
      await new Promise(r => setTimeout(r, delay + Math.random() * 500))
    }
  }
}

// ── Tx helpers ────────────────────────────────────────────────────────────────

async function sendTx(data: Hex): Promise<Hex> {
  return withBackoff(async () => {
    const nonce = await publicClient.getTransactionCount({ address: account.address })
    const hash = await walletClient.sendTransaction({
      to: AUCTION_HOUSE, data, nonce,
      maxFeePerGas: MIN_GAS_WEI, maxPriorityFeePerGas: 0n,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    return hash
  })
}

async function sendApproveTx(spender: Address, amount: bigint): Promise<Hex> {
  return withBackoff(async () => {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] })
    const nonce = await publicClient.getTransactionCount({ address: account.address })
    const hash = await walletClient.sendTransaction({
      to: USDC_ADDRESS, data, nonce,
      maxFeePerGas: MIN_GAS_WEI, maxPriorityFeePerGas: 0n,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    return hash
  })
}

function makeLotUri(title: string): string {
  const meta = JSON.stringify({ name: title, description: 'House auction lot by the Gavel keeper.' })
  return `data:application/json;base64,${Buffer.from(meta).toString('base64')}`
}

// ── Event-driven lot-set rebuild (runs once at startup) ───────────────────────
//
// Uses AH_ABI from the compiled artifact for correct topic0.
// On range-size errors: halves chunk (down to MIN_CHUNK), remembers working size.
// On any other failure: logs and marks ready with an empty set so listing proceeds.

async function rebuildActiveLots(): Promise<void> {
  log('rebuilding active house lot set from Listed events…')

  let head: bigint
  try {
    head = await withBackoff(() => publicClient.getBlockNumber())
  } catch (err) {
    log(`rebuild: could not get block number (${String(err).slice(0, 80)}) — starting with empty set`)
    activeScanReady = true
    return
  }

  // Session-learned chunk size — start at START_CHUNK, halve on range errors
  let chunk = START_CHUNK

  let from = DEPLOY_BLOCK
  try {
    while (from <= head) {
      const to = from + chunk - 1n < head ? from + chunk - 1n : head

      let logs: Log[] = []
      let rangeOk = false

      // Inner loop: halve chunk on range errors, backoff on rate-limit errors
      while (!rangeOk) {
        try {
          // Use address-only filter (no topic) — avoids topic-mismatch bugs
          logs = await publicClient.getLogs({
            address: AUCTION_HOUSE,
            fromBlock: from,
            toBlock: to,
          })
          rangeOk = true
        } catch (err) {
          if (isRangeSizeError(err)) {
            if (chunk <= MIN_CHUNK) {
              log(`rebuild: chunk already at minimum ${MIN_CHUNK}; skipping range [${from}, ${to}]: ${String(err).slice(0, 80)}`)
              rangeOk = true   // skip this range, continue scan
            } else {
              chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n
              log(`rebuild: range too large — halving chunk to ${chunk}`)
              // recompute `to` with new chunk
              const newTo = from + chunk - 1n < head ? from + chunk - 1n : head
              // Re-enter inner loop with smaller range
              try {
                logs = await publicClient.getLogs({ address: AUCTION_HOUSE, fromBlock: from, toBlock: newTo })
                rangeOk = true
              } catch (err2) {
                if (isRateLimitError(err2)) {
                  const delay = 4000 + Math.random() * 1000
                  log(`rebuild: rate-limit, waiting ${Math.round(delay)}ms`)
                  await new Promise(r => setTimeout(r, delay))
                } else {
                  log(`rebuild: skipping range [${from}, ${newTo}] after halve failed: ${String(err2).slice(0, 80)}`)
                  rangeOk = true
                }
              }
            }
          } else if (isRateLimitError(err)) {
            const delay = 4000 + Math.random() * 1000
            log(`rebuild: rate-limit, waiting ${Math.round(delay)}ms`)
            await new Promise(r => setTimeout(r, delay))
          } else {
            log(`rebuild: unexpected error on [${from}, ${to}]: ${String(err).slice(0, 100)}`)
            rangeOk = true  // skip this range
          }
        }
      }

      // Decode only Listed events using the artifact ABI
      for (const l of logs) {
        if (!l.topics[0]) continue
        try {
          const decoded = decodeEventLog({ abi: AH_ABI, eventName: 'Listed', data: l.data, topics: l.topics })
          const args = decoded.args as { lotId: bigint; seller: string }
          if (args.seller?.toLowerCase() === account.address.toLowerCase()) {
            activeLotIds.add(Number(args.lotId))
          }
        } catch {
          // Not a Listed event or decode failed — skip
        }
      }

      from = (from + chunk) > head ? head + 1n : from + chunk

      // Pace between calls
      if (from <= head) await new Promise(r => setTimeout(r, 250))
    }

    log(`rebuild done: ${activeLotIds.size} house lot(s) found [${DEPLOY_BLOCK}..${head}], working chunk=${chunk}`)
  } catch (err) {
    log(`rebuild failed (${String(err).slice(0, 100)}) — continuing with ${activeLotIds.size} lot(s) found so far`)
  }

  activeScanReady = true
}

// ── Core cycle ────────────────────────────────────────────────────────────────

async function cycle() {
  try {
    // 1. Balance check
    const bal = await withBackoff(() =>
      publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] })
    ) as bigint
    balance = formatUnits(bal, USDC_DECIMALS)
    if (bal < LOW_BAL_WARN) log(`WARNING: balance ${balance} USDC < 2 USDC — replenish soon`)

    // 2. Approve once if needed
    const allowance = await withBackoff(() =>
      publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, AUCTION_HOUSE] })
    ) as bigint
    if (allowance < RESERVE) {
      log('approving USDC bond allowance…')
      const hash = await sendApproveTx(AUCTION_HOUSE, APPROVE_AMT)
      log(`approved — tx: ${hash}`)
      lastAction = `approved tx:${hash}`
    }

    // 3. Read nextLotId
    const nextId = Number(await withBackoff(() =>
      publicClient.readContract({ address: AUCTION_HOUSE, abi: AH_ABI, functionName: 'nextLotId', args: [] })
    ) as bigint)

    const now = Math.floor(Date.now() / 1000)
    let hasLiveLot = false

    // 4. Read only tracked lot ids
    const toRemove: number[] = []
    for (const i of activeLotIds) {
      const raw = await withBackoff(() =>
        publicClient.readContract({ address: AUCTION_HOUSE, abi: AH_ABI, functionName: 'lots', args: [BigInt(i)] })
      ) as readonly [Address, bigint, bigint, bigint, bigint, bigint, bigint, Address, bigint, bigint, boolean, boolean, boolean, boolean]

      const [, , , , , deadline, , , , settledAt, settled, cancelled, bondReleased] = raw
      const deadlineN  = Number(deadline)
      const settledAtN = Number(settledAt)

      if (!settled && !cancelled) {
        if (deadlineN > now) {
          hasLiveLot = true
          liveLotId  = i
        } else {
          log(`settling lot #${i}…`)
          const data = encodeFunctionData({ abi: AH_ABI, functionName: 'settle', args: [BigInt(i)] })
          const hash = await sendTx(data)
          log(`settled lot #${i} — tx: ${hash}`)
          lastAction = `settled #${i} tx:${hash}`
        }
      } else if (settled && !bondReleased && settledAtN > 0 && (now - settledAtN) >= SEVEN_DAYS) {
        log(`releaseBondAfterTimeout lot #${i}…`)
        const data = encodeFunctionData({ abi: AH_ABI, functionName: 'releaseBondAfterTimeout', args: [BigInt(i)] })
        const hash = await sendTx(data)
        log(`bond released lot #${i} — tx: ${hash}`)
        lastAction = `bond released #${i} tx:${hash}`
        toRemove.push(i)
      } else if (settled && bondReleased) {
        toRemove.push(i)
      }
    }
    for (const i of toRemove) activeLotIds.delete(i)

    // 5. List a new lot if none live
    if (!hasLiveLot) {
      if (bal < RESERVE) {
        log(`SKIP list — balance ${balance} USDC < reserve 0.10 USDC`)
        liveLotId = null
        return
      }
      const title = LOT_TITLES[titleIndex % LOT_TITLES.length]
      titleIndex++
      const uri = makeLotUri(title)
      log(`listing new lot: "${title}"…`)
      const data = encodeFunctionData({ abi: AH_ABI, functionName: 'list', args: [uri, RESERVE, BigInt(DURATION), MIN_INCREMENT] })
      const hash = await sendTx(data)
      const newId = nextId
      activeLotIds.add(newId)
      liveLotId  = newId
      lastAction = `listed #${newId} "${title}" tx:${hash}`
      log(`listed lot #${newId} — tx: ${hash}`)
    }
  } catch (err: unknown) {
    log(`cycle error: ${(err as Error)?.message ?? String(err)}`)
  }
}

// ── Health server ─────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        lastAction, liveLotId, balance,
        trackedLots: activeLotIds.size,
        scanReady: activeScanReady,
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('Gavel keeper\n', { status: 200 })
  },
})
log(`health server listening on http://localhost:${PORT}`)

// ── Boot ──────────────────────────────────────────────────────────────────────

// Rebuild is non-blocking on failure: if it errors, activeScanReady is set true
// and we proceed with an empty set. The keeper must never block listing.
await rebuildActiveLots()
await cycle()
setInterval(() => { void cycle() }, CYCLE_MS)
