/**
 * Vercel Function: /api/relay/bid and /api/relay/stats (the app calls /relay/*,
 * rewritten here by vercel.json). Same handler as the local Bun relayer.
 * Needs RELAYER_PRIVATE_KEY set in the Vercel project's environment variables.
 */
import { handle } from '../../relayer/handler.js'

export const config = { maxDuration: 60 }

export function GET(req: Request) { return handle(req) }
export function POST(req: Request) { return handle(req) }
export function OPTIONS(req: Request) { return handle(req) }
