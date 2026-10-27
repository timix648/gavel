/**
 * Vercel Function: POST /api/upload
 * Body: a WebP, JPEG or PNG image (the app compresses to WebP under 300 KB first).
 * Stores it publicly in Vercel Blob and returns { url }.
 *
 * Works with either Blob auth: OIDC (BLOB_STORE_ID, added when a store is connected
 * to the project) or the older BLOB_READ_WRITE_TOKEN. GET reports whether upload is
 * configured, so the app can fall back to "paste an image URL".
 */
export const config = { maxDuration: 15 }

const MAX_BYTES = 300 * 1024
// No SVG: it can carry script.
const TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }

const configured = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN)

export function GET() {
  return Response.json({ configured: configured() })
}

export async function POST(request) {
  if (!configured()) return Response.json({ error: 'Upload not configured' }, { status: 503 })

  const type = (request.headers.get('content-type') || '').split(';')[0].trim()
  const ext = TYPES[type]
  if (!ext) return Response.json({ error: 'Only WebP, JPEG or PNG images' }, { status: 415 })

  const declared = Number(request.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) return Response.json({ error: 'Image too large (max 300 KB)' }, { status: 413 })
  const body = await request.arrayBuffer()
  if (body.byteLength === 0) return Response.json({ error: 'Empty upload' }, { status: 400 })
  if (body.byteLength > MAX_BYTES) return Response.json({ error: 'Image too large (max 300 KB)' }, { status: 413 })

  try {
    const { put } = await import('@vercel/blob')
    const opts = { access: 'public', contentType: type, addRandomSuffix: true }
    if (process.env.BLOB_READ_WRITE_TOKEN) opts.token = process.env.BLOB_READ_WRITE_TOKEN
    const blob = await put(`lots/lot.${ext}`, body, opts)
    return Response.json({ url: blob.url })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
