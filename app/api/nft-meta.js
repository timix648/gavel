/**
 * GET /api/nft-meta?kind=721|1155&asset=0x..&id=N
 *
 * Reads tokenURI (ERC-721) or uri (ERC-1155) from Arc mainnet, resolves ipfs://,
 * fetches the JSON metadata (5 s timeout, 200 KB limit), and returns
 * { name, description, image } where image is a safe https or data:image/... URL.
 *
 * SSRF hardening:
 *  - Bare IP addresses (dotted, decimal, hex, IPv6 literal) are refused.
 *  - Before every fetch the hostname is resolved with DNS and ALL returned
 *    addresses are checked against private/loopback/link-local/CGNAT ranges.
 *  - Redirects are followed manually (max 2), each hop re-validated.
 *
 * Returns { name:null, description:null, image:null } with 200 on any failure.
 * Cache-Control: s-maxage=3600 so Vercel CDN caches results for 1 hour.
 */

import { createPublicClient, http, parseAbi, isAddress } from 'viem'
import dns from 'node:dns/promises'

// ── RPC URL ───────────────────────────────────────────────────────────────────
const proxyBase   = process.env.RPC_PROXY_BASE_URL
const proxyToken  = process.env.RPC_PROXY_TOKEN
const proxyChains = (process.env.RPC_PROXY_CHAINS || '').split(',')

const ARC_CHAIN_KEY = 'Arc'
const RPC_URL =
  proxyBase && proxyChains.includes(ARC_CHAIN_KEY)
    ? `${proxyBase}/api/rpc/${ARC_CHAIN_KEY}?_rpc_token=${proxyToken}`
    : process.env.ARC_RPC_URL || process.env.VITE_RPC_URL || 'https://rpc.mainnet.arc.io' // arc-studio-allow-onchain-literal

const arcChain = {
  id: 5042, name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
}

const client = createPublicClient({
  chain: arcChain,
  transport: http(RPC_URL, { retryCount: 2, retryDelay: 800 }),
})

const ERC721_URI_ABI  = parseAbi(['function tokenURI(uint256 tokenId) view returns (string)'])
const ERC1155_URI_ABI = parseAbi(['function uri(uint256 id) view returns (string)'])

// ── SSRF helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when an IP string (v4 or v6) falls in a blocked range:
 * 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local),
 * 172.16/12, 192.168/16, ::, ::1, fc00::/7 (ULA), fe80::/10 (link-local),
 * and the IPv4-mapped ::ffff: forms of the above.
 */
function isBlockedIp(addr) {
  // IPv4
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [, a, b, c] = v4.map(Number)
    if (a === 0)   return true                              // 0.0.0.0/8
    if (a === 10)  return true                              // 10/8
    if (a === 100 && b >= 64  && b <= 127) return true     // 100.64/10 CGNAT
    if (a === 127) return true                              // 127/8
    if (a === 169 && b === 254) return true                 // 169.254/16
    if (a === 172 && b >= 16  && b <= 31)  return true     // 172.16/12
    if (a === 192 && b === 168) return true                 // 192.168/16
    return false
  }
  // IPv6 — normalise to lowercase
  const lc = addr.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (lc === '::' || lc === '::1') return true             // unspecified, loopback
  if (/^fe80:/i.test(lc)) return true                      // link-local fe80::/10
  // fc00::/7 covers fc00:: – fdff:: (ULA)
  const first16 = parseInt(lc.split(':')[0] || '0', 16)
  if ((first16 & 0xfe00) === 0xfc00) return true           // ULA
  // IPv4-mapped: ::ffff:a.b.c.d or ::ffff:0x...
  const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIp(mapped[1])
  const mappedHex = lc.match(/^::ffff:([0-9a-f]{4}):([0-9a-f]{4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16); const lo = parseInt(mappedHex[2], 16)
    const a = (hi >> 8) & 0xff; const b = hi & 0xff
    const c = (lo >> 8) & 0xff; const d = lo & 0xff
    return isBlockedIp(`${a}.${b}.${c}.${d}`)
  }
  return false
}

/**
 * Returns true when the hostname string is a bare IP address in any form
 * (dotted-decimal IPv4, decimal-integer, hex, IPv6 literal).
 */
function isBareIp(hostname) {
  if (!hostname) return true
  // IPv6 literal (with or without brackets)
  if (hostname.startsWith('[') || /^[0-9a-f:]+$/i.test(hostname)) return true
  // Pure decimal integer (e.g. http://2130706433/ → 127.0.0.1)
  if (/^\d+$/.test(hostname)) return true
  // Hex (0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true
  // Dotted-decimal IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return true
  return false
}

/**
 * Validate a URL string for safe external HTTPS fetching:
 *  1. Must be https://
 *  2. Hostname must not be a bare IP
 *  3. Hostname must resolve and ALL addresses must be non-private
 * Returns an error string (reason) or null (safe).
 */
async function ssrfCheck(urlStr) {
  let u
  try { u = new URL(urlStr) } catch { return 'invalid URL' }
  if (u.protocol !== 'https:') return 'non-https'
  const h = u.hostname
  if (isBareIp(h)) return 'bare IP address'
  // DNS pre-resolution
  let records
  try {
    records = await dns.lookup(h, { all: true })
  } catch { return 'DNS resolution failed' }
  if (!records || records.length === 0) return 'no DNS records'
  for (const { address } of records) {
    if (isBlockedIp(address)) return `blocked IP ${address}`
  }
  return null // safe
}

// ── IPFS resolver ─────────────────────────────────────────────────────────────

function resolveIpfs(url) {
  if (typeof url !== 'string') return url
  if (url.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + url.slice(7)
  return url
}

// ── Safe image filter (no SVG) ────────────────────────────────────────────────

function sanitiseImage(url) {
  if (!url || typeof url !== 'string') return null
  const resolved = resolveIpfs(url.trim())
  if (resolved.startsWith('data:image/')) {
    if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(resolved)) return resolved
    return null
  }
  // HTTPS check is deferred to ssrfCheck at fetch time; here just ensure protocol
  try {
    const u = new URL(resolved)
    if (u.protocol !== 'https:') return null
  } catch { return null }
  return resolved
}

// ── Fetch with manual redirect (max 2 hops) ───────────────────────────────────

const MAX_REDIRECTS = 2

async function safeFetch(urlStr, signal) {
  let current = urlStr
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const err = await ssrfCheck(current)
    if (err) throw new Error(`SSRF: ${err} at ${current}`)

    const resp = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { accept: 'application/json, */*' },
    })

    // Follow 3xx manually
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) throw new Error('redirect with no Location')
      // Resolve relative Location against current URL
      current = new URL(loc, current).toString()
      continue
    }
    return resp
  }
  throw new Error('too many redirects')
}

// ── Main handler ──────────────────────────────────────────────────────────────

const NULL_RESULT = { name: null, description: null, image: null }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=60')
  res.setHeader('Access-Control-Allow-Origin', '*')

  const { kind, asset, id } = req.query

  if (!['721', '1155'].includes(kind))   return res.status(200).json(NULL_RESULT)
  if (!asset || !isAddress(asset))        return res.status(200).json(NULL_RESULT)
  if (!id || !/^\d+$/.test(String(id)))   return res.status(200).json(NULL_RESULT)

  const idNum = BigInt(id)

  try {
    // 1. Read the on-chain URI
    let rawUri
    if (kind === '721') {
      rawUri = await client.readContract({
        address: asset, abi: ERC721_URI_ABI, functionName: 'tokenURI', args: [idNum],
      })
    } else {
      const raw = await client.readContract({
        address: asset, abi: ERC1155_URI_ABI, functionName: 'uri', args: [idNum],
      })
      rawUri = String(raw).replace('{id}', idNum.toString(16).padStart(64, '0'))
    }

    if (!rawUri) return res.status(200).json(NULL_RESULT)

    // 2. data: URIs — parse inline, no network
    let metadata
    if (rawUri.startsWith('data:application/json')) {
      const comma = rawUri.indexOf(',')
      if (comma === -1) return res.status(200).json(NULL_RESULT)
      const payload = rawUri.slice(comma + 1)
      const isB64   = rawUri.slice(0, comma).includes('base64')
      const jsonStr = isB64
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload)
      metadata = JSON.parse(jsonStr)
    } else {
      // 3. External fetch (ipfs:// resolved to https://ipfs.io/ipfs/...)
      const fetchUrl = resolveIpfs(rawUri)

      const ctrl  = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      let fetchRes
      try {
        fetchRes = await safeFetch(fetchUrl, ctrl.signal)
      } finally {
        clearTimeout(timer)
      }

      if (!fetchRes.ok) return res.status(200).json(NULL_RESULT)

      // 200 KB size cap
      const MAX_BYTES = 200 * 1024
      const reader = fetchRes.body.getReader()
      const chunks = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > MAX_BYTES) return res.status(200).json(NULL_RESULT)
        chunks.push(value)
      }
      metadata = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'))
    }

    return res.status(200).json({
      name:        typeof metadata.name        === 'string' ? metadata.name.trim()        : null,
      description: typeof metadata.description === 'string' ? metadata.description.trim() : null,
      image:       sanitiseImage(metadata.image),
    })
  } catch {
    return res.status(200).json(NULL_RESULT)
  }
}
