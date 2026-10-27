/**
 * Vercel Cron: GET /api/cron-disputes (daily, scheduled in vercel.json).
 * Backup for /api/notify-dispute: scans the last ~2 days of Disputed events in
 * 9,000-block chunks (the public RPC caps eth_getLogs at 10,000 blocks) and
 * emails every lot that is still DISPUTED.
 * Vercel signs cron calls with CRON_SECRET when that env var is set; if it is,
 * other callers are rejected.
 */
import { client, AUCTION_HOUSE, AH_ABI, DEPLOY_BLOCK, emailDispute } from './_chain.js'

export const config = { maxDuration: 60 }

const DISPUTED = 2
const CHUNK = 9_000n
const LOOKBACK = 400_000n   // Arc makes ~2 blocks/s: about 2.3 days

export async function GET(request) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) return new Response(null, { status: 204 })

  try {
    const head = await client.getBlockNumber()
    const start = head > LOOKBACK + DEPLOY_BLOCK ? head - LOOKBACK : DEPLOY_BLOCK
    const lotIds = new Set()
    for (let from = start; from <= head; from += CHUNK) {
      const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
      const logs = await client.getContractEvents({
        address: AUCTION_HOUSE, abi: AH_ABI, eventName: 'Disputed', fromBlock: from, toBlock: to,
      })
      for (const l of logs) lotIds.add(l.args.lotId.toString())
    }
    const sent = []
    for (const lot of lotIds) {
      const state = await client.readContract({ address: AUCTION_HOUSE, abi: AH_ABI, functionName: 'escrowState', args: [BigInt(lot)] })
      if (Number(state) === DISPUTED && await emailDispute(lot)) sent.push(lot)
    }
    return Response.json({ scannedFrom: start.toString(), head: head.toString(), disputed: [...lotIds], emailed: sent })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
