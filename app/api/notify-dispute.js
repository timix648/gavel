/**
 * Vercel Function: GET /api/notify-dispute?lot=N
 * Called by the app right after a dispute transaction confirms. It checks the
 * chain itself and only emails if the lot really is DISPUTED and the dispute is
 * less than an hour old, so the endpoint can't be used to spam the owner.
 * Returns 204 when RESEND_API_KEY / NOTIFY_EMAIL are not set.
 */
import { client, AUCTION_HOUSE, AH_ABI, emailDispute } from './_chain.js'

export const config = { maxDuration: 15 }

const DISPUTED = 2

export async function GET(request) {
  if (!process.env.RESEND_API_KEY || !process.env.NOTIFY_EMAIL) return new Response(null, { status: 204 })

  const lot = new URL(request.url).searchParams.get('lot') ?? ''
  if (!/^\d{1,12}$/.test(lot)) return Response.json({ error: 'lot must be a lot number' }, { status: 400 })
  const lotId = BigInt(lot)

  try {
    const [state, disputedAt] = await Promise.all([
      client.readContract({ address: AUCTION_HOUSE, abi: AH_ABI, functionName: 'escrowState', args: [lotId] }),
      client.readContract({ address: AUCTION_HOUSE, abi: AH_ABI, functionName: 'disputedAt', args: [lotId] }),
    ])
    if (Number(state) !== DISPUTED) return Response.json({ skipped: 'not disputed' })
    if (Math.floor(Date.now() / 1000) - Number(disputedAt) > 3600) return Response.json({ skipped: 'dispute older than 1 hour' })
    await emailDispute(lot)
    return Response.json({ sent: true, lot })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
