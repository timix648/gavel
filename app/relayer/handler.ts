/**
 * Gavel Relayer handler — shared by the Bun server (relayer/index.ts) and the
 * Vercel Function (api/relay/[action].ts). Submits bidWithAuthorization transactions on behalf of signers.
 *
 * Environment variables (set in /home/user/app/.env or shell):
 *   RELAYER_PRIVATE_KEY   — 0x-prefixed hex private key for the relayer EOA
 *   RELAYER_PORT          — port to listen on (default 3001)
 *   AUCTION_HOUSE_ADDRESS — override the default contract address
 *   ARC_RPC_URL           — override the default Arc Mainnet RPC
 *
 * POST /bid
 *   Body: { lotId, amount, topUp, from, validAfter, validBefore, salt, sig: { v, r, s } }
 *   The relayer calls bidWithAuthorization (v8) with the topUp portion signed by from.
 *   Returns: { txHash } on success or { error } on failure.
 *
 * GET /stats
 *   Returns: { relayedBids } -- count from on-chain RelayedBid events
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  parseAbi,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── Config ─────────────────────────────────────────────────────────────────────

const RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io'
const DEFAULT_AH_ADDRESS = '0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6'
const AH_ADDRESS = (process.env.AUCTION_HOUSE_ADDRESS ?? DEFAULT_AH_ADDRESS) as Address
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as Address
const MAX_FEE_PER_GAS = 20_000_000_000n  // 20 gwei — Arc's minimum floor
const PRIORITY_FEE   = 0n
const RECEIPT_TIMEOUT_MS = 15_000
// Per-address rate limit: 5 bids per minute
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 5
// Deploy block for the live v8 contract — scan starts here so we never miss events
const DEPLOY_BLOCK = BigInt(process.env.AUCTION_HOUSE_DEPLOY_BLOCK ?? '28077831')
const STATS_CHUNK  = 9_000n   // stay under the 10,000-block RPC cap
const STATS_TTL_MS = 60_000   // cache the count for 60 seconds

// ── ABI ────────────────────────────────────────────────────────────────────────

const AH_ABI = parseAbi([
  'function bidWithAuthorization(uint256 lotId, uint256 amount, uint256 topUp, address from, uint256 validAfter, uint256 validBefore, bytes32 salt, uint8 v, bytes32 r, bytes32 s) external',
  'event RelayedBid(uint256 indexed lotId, address indexed bidder, address indexed relayer, uint256 amount)',
  'function lots(uint256 lotId) external view returns (address seller, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint256 bond, uint256 deadline, uint256 highestBid, address highestBidder, uint256 extensions, uint256 settledAt, bool settled, bool cancelled, bool bondReleased, bool disputed)',
  'function paused() external view returns (bool)',
])

const USDC_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
])

// ── Chain ──────────────────────────────────────────────────────────────────────

const arcTestnet = {
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
} as const

// ── Wallet ─────────────────────────────────────────────────────────────────────

const relayerKey = process.env.RELAYER_PRIVATE_KEY
if (!relayerKey) throw new Error('RELAYER_PRIVATE_KEY is not set')
const account = privateKeyToAccount(relayerKey as Hex)

const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC_URL) })
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) })

// ── Nonce tracker ──────────────────────────────────────────────────────────────

// On a serverless host each instance starts empty, so the first call reads the
// pending nonce from chain; within one warm instance it counts up locally.
let pendingNonce: bigint | null = null
async function getNextNonce(): Promise<bigint> {
  if (pendingNonce === null) {
    pendingNonce = BigInt(await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }))
  }
  const n = pendingNonce
  pendingNonce += 1n
  return n
}

// ── Rate limiter ───────────────────────────────────────────────────────────────

// Maps address → array of timestamps (ms)
const rateLimitMap = new Map<string, number[]>()
function checkRateLimit(addr: string): { ok: boolean; reason?: string } {
  const now = Date.now()
  const window = rateLimitMap.get(addr) ?? []
  const recent = window.filter(t => now - t < RATE_LIMIT_WINDOW_MS)
  if (recent.length >= RATE_LIMIT_MAX) {
    return { ok: false, reason: `Rate limit: max ${RATE_LIMIT_MAX} relayed bids per minute per address` }
  }
  recent.push(now)
  rateLimitMap.set(addr, recent)
  return { ok: true }
}

// ── Stats cache ────────────────────────────────────────────────────────────────

// Counts all RelayedBid events from DEPLOY_BLOCK in 9,000-block chunks.
// Cached for STATS_TTL_MS so repeated front-end polls don't hammer the RPC.
let statsCache: { count: number; expiry: number } | null = null

async function fetchRelayedBidCount(): Promise<number> {
  if (statsCache && Date.now() < statsCache.expiry) return statsCache.count
  const relayedBidEvent = { name: 'RelayedBid', type: 'event', inputs: [
    { name: 'lotId',   type: 'uint256', indexed: true  },
    { name: 'bidder',  type: 'address', indexed: true  },
    { name: 'relayer', type: 'address', indexed: true  },
    { name: 'amount',  type: 'uint256', indexed: false },
  ]} as const
  const head = await publicClient.getBlockNumber()
  let count = 0
  for (let from = DEPLOY_BLOCK; from <= head; from += STATS_CHUNK) {
    const to = from + STATS_CHUNK - 1n < head ? from + STATS_CHUNK - 1n : head
    const logs = await publicClient.getLogs({ address: AH_ADDRESS, event: relayedBidEvent, fromBlock: from, toBlock: to })
    count += logs.length
  }
  statsCache = { count, expiry: Date.now() + STATS_TTL_MS }
  return count
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // CORS for the Vite dev server
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (req.method === 'GET' && url.pathname.endsWith('/stats')) {
      try {
        const relayedBids = await fetchRelayedBidCount()
        return Response.json({ relayedBids }, { headers: corsHeaders })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return Response.json({ error: msg }, { status: 502, headers: corsHeaders })
      }
    }

    if (req.method === 'POST' && url.pathname.endsWith('/bid')) {
      try {
        const body = await req.json() as {
          lotId: number
          amount: string
          topUp: string
          from: string
          validAfter: string
          validBefore: string
          salt: string
          sig: { v: number; r: string; s: string }
        }

        const { lotId, amount, topUp: topUpStr, from, validAfter, validBefore, salt, sig } = body
        const topUp = BigInt(topUpStr ?? '0')

        // ── Validate inputs ───────────────────────────────────────────────────
        if (!from || !salt || !sig) {
          return Response.json({ error: 'Missing required fields: from, salt, sig' }, { status: 400, headers: corsHeaders })
        }
        const nowSec = Math.floor(Date.now() / 1000)
        if (Number(validBefore) <= nowSec) {
          return Response.json({ error: 'validBefore is in the past' }, { status: 400, headers: corsHeaders })
        }

        // ── Rate limit ─────────────────────────────────────────────────────────
        const rl = checkRateLimit(from.toLowerCase())
        if (!rl.ok) return Response.json({ error: rl.reason }, { status: 429, headers: corsHeaders })

        // ── Validate lot state on-chain ───────────────────────────────────────
        const isPaused = await publicClient.readContract({ address: AH_ADDRESS, abi: AH_ABI, functionName: 'paused' })
        if (isPaused) return Response.json({ error: 'AuctionHouse is paused' }, { status: 400, headers: corsHeaders })

        const lotData = await publicClient.readContract({ address: AH_ADDRESS, abi: AH_ABI, functionName: 'lots', args: [BigInt(lotId)] })
        const [seller, , reserve, minIncrement, , deadline, highestBid, , , , settled, cancelled] = lotData as [Address, bigint, bigint, bigint, bigint, bigint, bigint, Address, bigint, bigint, boolean, boolean, boolean, boolean]
        if (seller === '0x0000000000000000000000000000000000000000') {
          return Response.json({ error: 'Lot does not exist' }, { status: 400, headers: corsHeaders })
        }
        if (settled || cancelled) return Response.json({ error: 'Lot is not active' }, { status: 400, headers: corsHeaders })
        if (BigInt(nowSec) >= deadline) return Response.json({ error: 'Auction has ended' }, { status: 400, headers: corsHeaders })

        // Validate bid amount
        const amountBig = BigInt(amount)
        if (highestBid === 0n) {
          if (amountBig < reserve) return Response.json({ error: `Below reserve (${reserve})` }, { status: 400, headers: corsHeaders })
        } else {
          const minBid = highestBid + minIncrement
          if (amountBig < minBid) return Response.json({ error: `Below minimum bid (${minBid})` }, { status: 400, headers: corsHeaders })
        }

        // Check bidder has enough USDC balance
        const balance = await publicClient.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [from as Address] })
        // v8: only topUp is pulled from wallet; credit covers the rest
        if (balance < topUp) return Response.json({ error: `Bidder USDC balance too low for topUp (${balance} < ${topUp})` }, { status: 400, headers: corsHeaders })

        // ── Submit transaction ────────────────────────────────────────────────
        const callData = encodeFunctionData({
          abi: AH_ABI,
          functionName: 'bidWithAuthorization',
          args: [
            BigInt(lotId),
            amountBig,
            topUp,
            from as Address,
            BigInt(validAfter),
            BigInt(validBefore),
            salt as Hex,
            sig.v,
            sig.r as Hex,
            sig.s as Hex,
          ],
        })

        const walletNonce = await getNextNonce()
        let txHash: Hex
        try {
          txHash = await walletClient.sendTransaction({
            to: AH_ADDRESS,
            data: callData,
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: PRIORITY_FEE,
            nonce: Number(walletNonce),
          })
        } catch (err) {
          // Nonce failed — reset so next call re-fetches
          pendingNonce = null
          throw err
        }

        // ── Wait for receipt (15s), retry once at higher fee ─────────────────
        let receipt = null
        try {
          receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS })
        } catch {
          // Retry at 1.5× fee
          console.warn(`No receipt in ${RECEIPT_TIMEOUT_MS}ms for ${txHash} — retrying at higher fee`)
          const retryHash = await walletClient.sendTransaction({
            to: AH_ADDRESS,
            data: callData,
            maxFeePerGas: (MAX_FEE_PER_GAS * 3n) / 2n,
            maxPriorityFeePerGas: PRIORITY_FEE,
            nonce: Number(walletNonce),
          })
          receipt = await publicClient.waitForTransactionReceipt({ hash: retryHash, timeout: RECEIPT_TIMEOUT_MS })
          txHash = retryHash
        }

        if (receipt.status !== 'success') {
          return Response.json({ error: `Transaction reverted (hash: ${txHash})` }, { status: 500, headers: corsHeaders })
        }

        // ── Log gas cost ──────────────────────────────────────────────────────
        console.log(`[relayed] lotId=${lotId} bidder=${from} amount=${amount} topUp=${topUp} tx=${txHash}`)

        return Response.json({ txHash }, { headers: corsHeaders })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('Relay error:', msg)
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders })
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders })
}

export const relayerAddress = account.address
