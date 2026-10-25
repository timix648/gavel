import { useEffect, useState, useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, usePublicClient } from 'wagmi'
import { keepPreviousData } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { ThemeToggle } from '../components/Layout'
import { AUCTION_HOUSE_ADDRESS, CHAIN_ID, txUrl, REPUTATION_WRITER_ADDRESS } from '../chain'
import { useWithGas } from '../txGas'
import { AUCTION_HOUSE_ABI, REPUTATION_WRITER_ABI } from '../abi'
import type { Abi } from 'viem'
const AH_ABI_TYPED = AUCTION_HOUSE_ABI as Abi
import { fmtUsdc, parseOnchainError } from '../utils'
import { useLatestBlock } from '../useBlock'
import { useLogStore } from '../useLogs'

interface LotRef { lotId: bigint; title: string; amount: bigint; txHash: string }

const TOKEN_URI_ABI = [{ name: 'tokenURI', type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' }] as const

function decodeTitle(uri: string, fallback: string): string {
  if (!uri) return fallback
  if (uri.startsWith('data:application/json')) {
    try {
      const p = JSON.parse(atob(uri.split(',')[1])) as { name?: string }
      return p.name?.trim() || fallback
    } catch { return fallback }
  }
  if (uri.startsWith('http') || uri.startsWith('ipfs')) return fallback
  return uri.trim() || fallback
}

// Module-level cache shared with Lobby
const titleCache = new Map<string, string>() // key: `${gavelAddr}:${tokenId}`

export default function Me() {
  const { address, chainId } = useAccount()
  const block  = useLatestBlock()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [lotTitles, setLotTitles] = useState<Record<string, string>>({})
  const [gavelAddr, setGavelAddr] = useState<`0x${string}` | undefined>()
  const [tab, setTab] = useState<'bidding'|'won'|'selling'>('bidding')

  const { data: claimable } = useReadContract({
    address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'claimable',
    args: address ? [address] : undefined, chainId: CHAIN_ID,
    blockNumber: block?.blockNumber, query: { enabled: !!address, placeholderData: keepPreviousData },
  })

  useEffect(() => {
    if (!client || gavelAddr) return
    void client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'gavelLot', args: [] })
      .then(a => setGavelAddr(a as `0x${string}`))
      .catch(() => {})
  }, [client, gavelAddr])

  const { logs: allLogs, scanning: loading } = useLogStore()
  const addrLower = address?.toLowerCase() ?? ''

  const bids: LotRef[] = []
  const seenBids = new Set<bigint>()
  for (const l of [...allLogs].reverse()) {
    if (l.name !== 'Bid') continue
    const bidder = typeof l.args.bidder === 'string' ? l.args.bidder.toLowerCase() : ''
    if (bidder !== addrLower) continue
    const lotId = typeof l.args.lotId === 'bigint' ? l.args.lotId : BigInt(String(l.args.lotId))
    if (seenBids.has(lotId)) continue
    seenBids.add(lotId)
    bids.push({ lotId, title: lotTitles[lotId.toString()] ?? `Lot #${lotId}`, amount: l.args.amount as bigint, txHash: l.transactionHash })
  }

  const wins: LotRef[] = []
  for (const l of [...allLogs].reverse()) {
    if (l.name !== 'Hammer') continue
    const winner = typeof l.args.winner === 'string' ? l.args.winner.toLowerCase() : ''
    if (winner !== addrLower) continue
    const lotId = typeof l.args.lotId === 'bigint' ? l.args.lotId : BigInt(String(l.args.lotId))
    wins.push({ lotId, title: lotTitles[lotId.toString()] ?? `Lot #${lotId}`, amount: l.args.amount as bigint, txHash: l.transactionHash })
  }

  const selling: LotRef[] = []
  for (const l of [...allLogs].reverse()) {
    if (l.name !== 'Listed') continue
    const seller = typeof l.args.seller === 'string' ? l.args.seller.toLowerCase() : ''
    if (seller !== addrLower) continue
    const lotId = typeof l.args.lotId === 'bigint' ? l.args.lotId : BigInt(String(l.args.lotId))
    selling.push({ lotId, title: lotTitles[lotId.toString()] ?? `Lot #${lotId}`, amount: l.args.reserve as bigint, txHash: l.transactionHash })
  }

  const loadTitles = useCallback(async () => {
    if (!gavelAddr || !client) return
    const allIds = [...new Set([...bids.map(b => b.lotId), ...wins.map(w => w.lotId), ...selling.map(s => s.lotId)])]

    // Batch 1: lots() for tokenIds of uncached lots
    const needTokenId: bigint[] = []
    for (const lotId of allIds) {
      const key = lotId.toString()
      if (!lotTitles[key]) needTokenId.push(lotId)
    }
    if (needTokenId.length === 0) return

    let tokenIds: (bigint | null)[]
    try {
      const results = await client.multicall({
        contracts: needTokenId.map(lotId => ({
          address: AUCTION_HOUSE_ADDRESS as `0x${string}`,
          abi: AH_ABI_TYPED,
          functionName: 'lots' as const,
          args: [lotId] as [bigint],
        })),
        allowFailure: true,
      })
      tokenIds = results.map(r =>
        r.status === 'success'
          ? (r.result as readonly [`0x${string}`, bigint, ...unknown[]])[1]
          : null
      )
    } catch { return }

    // Batch 2: tokenURI for uncached tokenIds
    const needUri: { idx: number; lotId: bigint; tokenId: bigint }[] = []
    for (let i = 0; i < needTokenId.length; i++) {
      const tokenId = tokenIds[i]
      if (!tokenId) continue
      const ck = `${gavelAddr}:${tokenId}`
      if (!titleCache.has(ck)) needUri.push({ idx: i, lotId: needTokenId[i], tokenId })
    }

    if (needUri.length > 0) {
      try {
        const uriResults = await client.multicall({
          contracts: needUri.map(({ tokenId }) => ({
            address: gavelAddr,
            abi: TOKEN_URI_ABI,
            functionName: 'tokenURI' as const,
            args: [tokenId] as [bigint],
          })),
          allowFailure: true,
        })
        for (let j = 0; j < needUri.length; j++) {
          const { lotId, tokenId } = needUri[j]
          const ck = `${gavelAddr}:${tokenId}`
          const title = uriResults[j].status === 'success'
            ? decodeTitle(uriResults[j].result as string, `Lot #${lotId}`)
            : `Lot #${lotId}`
          titleCache.set(ck, title)
        }
      } catch {}
    }

    // Merge into state
    const updates: Record<string, string> = {}
    for (let i = 0; i < needTokenId.length; i++) {
      const tokenId = tokenIds[i]
      if (!tokenId) continue
      const ck = `${gavelAddr}:${tokenId}`
      const key = needTokenId[i].toString()
      updates[key] = titleCache.get(ck) ?? `Lot #${needTokenId[i]}`
    }
    if (Object.keys(updates).length > 0) {
      setLotTitles(prev => ({ ...prev, ...updates }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, gavelAddr, bids.length, wins.length, selling.length])

  useEffect(() => { void loadTitles() }, [loadTitles])

  const { data: isLinked }       = useReadContract({ address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'sellerRegistered', args: address ? [address] : undefined, chainId: CHAIN_ID, query: { enabled: !!address } })
  const { data: cleanSalesCount } = useReadContract({ address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'cleanSalesView',   args: address ? [address] : undefined, chainId: CHAIN_ID, query: { enabled: !!address } })

  // Gas limit + fees estimated live before every send (see txGas.ts).
  const withGas = useWithGas()
  const onGasError = (e: unknown) => { toast.error(parseOnchainError(e)) }
  const { writeContract: claimTx, data: claimHash } = useWriteContract()
  const { isLoading: claimLoading, isSuccess: claimOk, isError: claimErr, error: claimRawErr } = useWaitForTransactionReceipt({ hash: claimHash })
  useEffect(() => {
    if (claimOk)  toast.success('USDC claimed')
    if (claimErr) toast.error(parseOnchainError(claimRawErr))
  }, [claimOk, claimErr, claimRawErr])

  // ── No wallet ──────────────────────────────────────────────────────────────
  if (!address) {
    return (
      <div className="py-24 flex flex-col items-center gap-4 text-center">
        <p className="text-ink-2 text-base">Connect your wallet to view your activity.</p>
      </div>
    )
  }

  const claimableAmt = (claimable as bigint | undefined) ?? 0n
  const cleanSales   = Number(cleanSalesCount ?? 0n)
  const bondLabel    = cleanSales >= 3 ? '50% bond' : '100% bond'
  const tabData = { bidding: bids, won: wins, selling } as const

  return (
    <div className="py-8 max-w-[640px] space-y-8">

      {/* ── Claimable ──────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-xs text-ink-3">Claimable USDC</p>
        <p className="text-5xl font-mono tabular-nums font-bold text-ink leading-none">
          {fmtUsdc(claimableAmt)}
        </p>
        {claimableAmt > 0n && (
          <button
            onClick={() => void withGas('claim', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'claim', args: [], chainId: CHAIN_ID }).then(claimTx).catch(onGasError)}
            disabled={claimLoading || chainId !== CHAIN_ID}
            className="mt-3 px-5 py-2.5 rounded-btn font-semibold text-sm bg-accent text-accent-ink hover:opacity-90 active:translate-y-px disabled:opacity-50 flex items-center gap-2"
          >
            {claimLoading ? 'Confirming...' : 'Claim USDC'}
          </button>
        )}
        {chainId !== CHAIN_ID && <p className="text-xs text-warn mt-1">Switch network to claim.</p>}
      </div>

      {/* ── Reputation one-liner ────────────────────────────────────────── */}
      {(Boolean(isLinked) || cleanSales > 0) && (
        <div className="text-sm text-ink-2">
          <span className="font-mono text-ink">{cleanSales}</span>
          {' '}clean sale{cleanSales !== 1 ? 's' : ''} · {bondLabel}
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div>
        <div className="flex border-b border-line gap-1 mb-5">
          {(['bidding', 'won', 'selling'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-sm font-medium capitalize transition-colors relative ${
                tab === t ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {t}
              {tab === t && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent rounded-t" />}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {loading && tabData[tab].length === 0 ? (
          <div className="space-y-2 animate-pulse">
            {[0,1,2].map(i => <div key={i} className="h-12 rounded-btn bg-surface-2" />)}
          </div>
        ) : tabData[tab].length === 0 ? (
          <p className="text-sm text-ink-3 py-4">
            {tab === 'bidding' ? 'No bids yet.' : tab === 'won' ? 'No wins yet.' : 'No lots listed yet.'}
          </p>
        ) : (
          <div className="divide-y divide-line">
            {tabData[tab].map((item, i) => (
              <div key={i} className="flex items-center justify-between py-3 gap-3">
                <Link to={`/lot/${item.lotId}`} className="text-sm text-ink hover:text-accent-text transition-colors font-medium truncate flex-1">
                  {item.title}
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono tabular-nums text-sm text-ink-2">{fmtUsdc(item.amount)}</span>
                  <a href={txUrl(item.txHash)} target="_blank" rel="noopener noreferrer"
                    className="text-ink-3 hover:text-accent-text transition-colors">
                    <ArrowSquareOut size={13} />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Display / theme toggle — mobile only (desktop toggle is in the nav) */}
      <div className="md:hidden mt-8 pt-6 border-t border-line">
        <h2 className="text-xs uppercase tracking-wider text-ink-3 mb-3">Display</h2>
        <div className="flex items-center justify-between">
          <span className="text-sm text-ink-2">Colour theme</span>
          <ThemeToggle compact />
        </div>
      </div>
    </div>
  )
}
