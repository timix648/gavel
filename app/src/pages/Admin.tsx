/**
 * Admin page — /admin
 * Owner-only view: lists DISPUTED lots with evidence, time since dispute, 14-day
 * resolution countdown. "Seller at fault" and "Not at fault" buttons trigger resolveDispute.
 */
/* eslint-disable react/set-state-in-effect */
/* eslint-disable react/purity */
import { useState, useEffect, useCallback } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, usePublicClient } from 'wagmi'
import { toast } from 'sonner'
import { ShieldWarning, Gavel } from '@phosphor-icons/react'
import { AUCTION_HOUSE_ADDRESS, CHAIN_ID, DEPLOY_BLOCK, txUrl } from '../chain'
import { AUCTION_HOUSE_ABI, type LotTuple, EscrowState } from '../abi'
import { fmtUsdc, shortAddr, parseOnchainError } from '../utils'
import { useWithGas } from '../txGas'
import EvidencePanel from '../components/EvidencePanel'
import { useLatestBlock } from '../useBlock'

const DISPUTE_RESOLVE_TIMEOUT_SECS = 14 * 24 * 3600

type DisputedLot = {
  id: bigint
  lot: LotTuple
  disputedAt: bigint
}

function fmtDays(secs: number) {
  if (secs <= 0) return '0 s'
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

export default function Admin() {
  const { address } = useAccount()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const block = useLatestBlock()
  const withGas = useWithGas()

  const { data: ownerRaw } = useReadContract({
    address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'owner', chainId: CHAIN_ID,
  })
  const owner = ownerRaw as `0x${string}` | undefined
  const isOwner = !!address && !!owner && address.toLowerCase() === owner.toLowerCase()

  const [lots, setLots] = useState<DisputedLot[]>([])
  const [loading, setLoading] = useState(true)

  const fetchDisputed = useCallback(async () => {
    if (!client) return
    try {
      setLoading(true)
      const head = await client.getBlockNumber()
      const from = head > 200_000n ? head - 200_000n : DEPLOY_BLOCK
      const events = await client.getContractEvents({
        address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI,
        eventName: 'Disputed', fromBlock: from, toBlock: head,
      })
      const ids = [...new Set(events.map(e => {
        const a = (e as unknown as { args: { lotId: bigint } }).args
        return a.lotId
      }))]
      const results: DisputedLot[] = []
      for (const id of ids) {
        try {
          const [raw, es, da] = await Promise.all([
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'lots', args: [id] }) as Promise<readonly [string, bigint, bigint, bigint, bigint, bigint, bigint, string, bigint, bigint, boolean, boolean, boolean, boolean]>,
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'escrowState', args: [id] }) as Promise<number>,
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'disputedAt', args: [id] }) as Promise<bigint>,
          ])
          const lot: LotTuple = {
            seller: raw[0] as `0x${string}`, tokenId: raw[1], reserve: raw[2], minIncrement: raw[3],
            bond: raw[4], deadline: raw[5], highestBid: raw[6], highestBidder: raw[7] as `0x${string}`,
            extensions: raw[8], settledAt: raw[9], settled: raw[10], cancelled: raw[11],
            bondReleased: raw[12], disputed: raw[13],
          }
          if ((es as EscrowState) === EscrowState.DISPUTED) {
            results.push({ id, lot, disputedAt: da })
          }
        } catch {}
      }
      results.sort((a, b) => Number(a.disputedAt) - Number(b.disputedAt))
      setLots(results)
    } catch (e) {
      toast.error(`Failed to load disputes: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [client])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void fetchDisputed() }, [fetchDisputed, block?.blockNumber])

  const [resolving, setResolving] = useState<bigint | null>(null)
  const { writeContract: resolveTx, data: resolveHash } = useWriteContract()
  const { isSuccess: resolveOk, isError: resolveErr, error: resolveRawErr } = useWaitForTransactionReceipt({ hash: resolveHash })
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (resolveOk) { toast.success('Dispute resolved'); setResolving(null); void fetchDisputed() }
    if (resolveErr) { toast.error(parseOnchainError(resolveRawErr)); setResolving(null) }
  }, [resolveOk, resolveErr, resolveRawErr, fetchDisputed])

  function handleResolve(lotId: bigint, sellerAtFault: boolean) {
    setResolving(lotId)
    void withGas('resolveDispute', {
      address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI,
      functionName: 'resolveDispute', args: [lotId, sellerAtFault], chainId: CHAIN_ID,
    }).then(resolveTx).catch(e => { toast.error(parseOnchainError(e)); setResolving(null) })
  }

  // eslint-disable-next-line react/purity -- fallback to wall clock when block not yet available
  const now = Number(block?.blockTimestamp ?? 0) || Math.floor(Date.now() / 1000)

  if (!address) {
    return (
      <div className="py-16 text-center text-ink-2">
        <ShieldWarning size={40} weight="thin" className="mx-auto mb-4 text-ink-3" />
        Connect your wallet to access the admin panel.
      </div>
    )
  }

  if (!isOwner) {
    return (
      <div className="py-16 text-center text-ink-2">
        <ShieldWarning size={40} weight="thin" className="mx-auto mb-4 text-ink-3" />
        This page is restricted to the contract owner.
      </div>
    )
  }

  return (
    <div className="py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-ink tracking-tight">Admin</h1>
        <p className="text-ink-2 mt-1 text-sm">Active disputes require your resolution within 14 days of the dispute being raised.</p>
      </div>

      {loading && (
        <div className="text-ink-3 text-sm py-8 text-center">Loading disputes...</div>
      )}

      {!loading && lots.length === 0 && (
        <div className="rounded-panel border border-line bg-surface p-8 text-center text-ink-3">
          <Gavel size={32} weight="thin" className="mx-auto mb-2" />
          No active disputes.
        </div>
      )}

      <div className="space-y-6">
        {lots.map(({ id, lot, disputedAt }) => {
          const sinceDispute = now - Number(disputedAt)
          const timeoutIn = Number(disputedAt) + DISPUTE_RESOLVE_TIMEOUT_SECS - now
          const isExpired = timeoutIn <= 0
          const isBusy = resolving === id

          return (
            <div key={id.toString()} className="rounded-panel border border-line bg-surface p-6 space-y-5">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-ink-3">Lot #{id.toString()}</span>
                    <a href={txUrl('')} className="hidden" />
                  </div>
                  <p className="text-ink font-semibold mt-0.5">
                    {fmtUsdc(lot.highestBid)} USDC
                    {lot.bond > 0n && <span className="ml-2 text-ink-3 font-normal text-xs">+ {fmtUsdc(lot.bond)} bond</span>}
                  </p>
                </div>
                <div className="text-xs text-ink-3 text-right space-y-0.5">
                  <p>Seller: <span className="font-mono">{shortAddr(lot.seller)}</span></p>
                  <p>Buyer: <span className="font-mono">{shortAddr(lot.highestBidder)}</span></p>
                </div>
              </div>

              {/* Timing */}
              <div className="flex flex-wrap gap-4 text-xs">
                <div className="rounded-tag border border-line px-2.5 py-1 text-ink-2">
                  Disputed <span className="font-semibold">{fmtDays(sinceDispute)}</span> ago
                </div>
                <div className={`rounded-tag border px-2.5 py-1 ${isExpired ? 'border-warn/50 text-warn' : 'border-line text-ink-2'}`}>
                  {isExpired
                    ? 'Timeout window open (anyone can call resolveDisputeTimeout)'
                    : <>Split timeout in <span className="font-semibold">{fmtDays(timeoutIn)}</span></>
                  }
                </div>
              </div>

              {/* Evidence */}
              <EvidencePanel
                lotId={id}
                buyer={lot.highestBidder}
                seller={lot.seller}
                escrowActive={true}
              />

              {/* Resolution buttons */}
              <div className="flex flex-col sm:flex-row gap-3 pt-2 border-t border-line">
                <button
                  disabled={isBusy}
                  onClick={() => handleResolve(id, true)}
                  className="flex-1 py-2.5 rounded-btn text-sm font-semibold border border-warn/40 text-warn hover:bg-warn/10 disabled:opacity-50 transition-colors"
                >
                  {isBusy ? 'Resolving...' : 'Seller at fault (refund buyer)'}
                </button>
                <button
                  disabled={isBusy}
                  onClick={() => handleResolve(id, false)}
                  className="flex-1 py-2.5 rounded-btn text-sm font-semibold border border-good/40 text-good hover:bg-good/10 disabled:opacity-50 transition-colors"
                >
                  {isBusy ? 'Resolving...' : 'Not at fault (pay seller)'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
