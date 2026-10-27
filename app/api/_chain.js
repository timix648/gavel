/**
 * Shared server-side chain config for the Vercel Functions in api/.
 * src/chain.ts can't be imported here (it reads import.meta.env), so the two
 * values that matter are repeated. Env vars override them.
 */
import { createPublicClient, http, parseAbi } from 'viem'

export const AUCTION_HOUSE = process.env.AUCTION_HOUSE_ADDRESS || '0xA51A6ac3E1B6954614E25721b1EEf4c7F854dEa6'
export const DEPLOY_BLOCK  = BigInt(process.env.AUCTION_HOUSE_DEPLOY_BLOCK || '28077831')
export const RPC_URL       = process.env.ARC_RPC_URL || process.env.VITE_RPC_URL || 'https://rpc.mainnet.arc.io'
export const APP_URL       = process.env.APP_URL || 'https://gavel-alpha.vercel.app'

export const AH_ABI = parseAbi([
  'function escrowState(uint256 lotId) view returns (uint8)',
  'function disputedAt(uint256 lotId) view returns (uint256)',
  'function lots(uint256 lotId) view returns (address seller, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint256 bond, uint256 deadline, uint256 highestBid, address highestBidder, uint256 extensions, uint256 settledAt, bool settled, bool cancelled, bool bondReleased, bool disputed)',
  'event Disputed(uint256 indexed lotId, address indexed winner)',
])

export const client = createPublicClient({
  chain: {
    id: 5042, name: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
  transport: http(RPC_URL, { retryCount: 3, retryDelay: 1000 }),
})

const usd = (raw) => `$${(Number(raw) / 1e6).toFixed(2)}`

/** Emails the owner about one disputed lot through Resend. Returns false if not configured. */
export async function emailDispute(lotId) {
  const key = process.env.RESEND_API_KEY
  const to  = process.env.NOTIFY_EMAIL
  if (!key || !to) return false
  const lot = await client.readContract({ address: AUCTION_HOUSE, abi: AH_ABI, functionName: 'lots', args: [BigInt(lotId)] })
  const [seller, , , , bond, , highestBid, buyer] = lot
  const link = `${APP_URL}/lot/${lotId}`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      // Resend's shared sender works without a verified domain, for mail to the account owner.
      from: 'Gavel <onboarding@resend.dev>',
      to,
      subject: `Gavel: lot #${lotId} disputed (${usd(highestBid)})`,
      text: [
        `Lot #${lotId} has been disputed.`,
        ``,
        `Payment held: ${usd(highestBid)}   Seller bond: ${usd(bond)}`,
        `Buyer:  ${buyer}`,
        `Seller: ${seller}`,
        ``,
        `Review the evidence and resolve it: ${APP_URL}/admin`,
        `Lot page: ${link}`,
        ``,
        `If nobody resolves it within 14 days of the dispute, anyone can split the payment 50/50.`,
      ].join('\n'),
    }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
  return true
}
