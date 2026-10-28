/**
 * useNftMeta — fetches NFT metadata from /api/nft-meta for ERC-721 and ERC-1155 lots.
 *
 * Returns { name, description, image, loading } where image is already a safe URL.
 * Results are cached module-level by "kind:asset:id" so repeated renders are free.
 */
import { useEffect, useState } from 'react'
import { LotKind } from '../abi'

interface NftMeta {
  name:        string | null
  description: string | null
  image:       string | null
}

interface UseNftMetaResult extends NftMeta {
  loading: boolean
}

const NULL_META: NftMeta = { name: null, description: null, image: null }

// Module-level cache: "kind:asset:id" → NftMeta | 'loading'
const cache = new Map<string, NftMeta>()

function cacheKey(kind: LotKind, asset: string, id: bigint) {
  return `${kind}:${asset.toLowerCase()}:${id}`
}

export function useNftMeta(
  kind: LotKind | undefined,
  asset: string | undefined,
  id: bigint | undefined,
): UseNftMetaResult {
  const enabled =
    (kind === LotKind.ERC721 || kind === LotKind.ERC1155) &&
    !!asset &&
    asset !== '0x0000000000000000000000000000000000000000' &&
    id !== undefined

  const key = enabled ? cacheKey(kind, asset, id) : ''
  const cached = key ? cache.get(key) : undefined

  const [meta, setMeta] = useState<NftMeta>(cached ?? NULL_META)
  const [loading, setLoading] = useState(enabled && !cached)

  useEffect(() => {
    if (!enabled || !key) { setMeta(NULL_META); setLoading(false); return }

    const hit = cache.get(key)
    if (hit) { setMeta(hit); setLoading(false); return }

    let cancelled = false
    setLoading(true)

    const kindParam = kind === LotKind.ERC721 ? '721' : '1155'
    const url = `/api/nft-meta?kind=${kindParam}&asset=${encodeURIComponent(asset)}&id=${id.toString()}`

    fetch(url)
      .then(r => r.ok ? r.json() as Promise<NftMeta> : NULL_META)
      .then(data => {
        cache.set(key, data)
        if (!cancelled) { setMeta(data); setLoading(false) }
      })
      .catch(() => {
        cache.set(key, NULL_META)
        if (!cancelled) { setMeta(NULL_META); setLoading(false) }
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return { ...meta, loading }
}
