/**
 * Gavel relayer — local Bun server. The logic lives in ./handler.ts, which the
 * Vercel Function in api/relay/[action].ts also uses.
 *   RELAYER_PRIVATE_KEY, RELAYER_PORT (default 3001), AUCTION_HOUSE_ADDRESS, ARC_RPC_URL
 */
import { handle, relayerAddress } from './handler'

const server = Bun.serve({ port: Number(process.env.RELAYER_PORT ?? 3001), fetch: handle })

console.log(`Relayer EOA: ${relayerAddress}`)
console.log(`Gavel relayer listening on http://localhost:${server.port}`)
