/**
 * EvidencePanel — shown on OFFCHAIN lots in HELD or DISPUTED escrow state.
 * Spec B5: displays submitted evidence newest-first with timestamps.
 *          Both buyer and seller may submit (up to 10 each).
 */
import { useState, useCallback, useEffect } from 'react'
import { usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { toast } from 'sonner'
import { Chat, Warning } from '@phosphor-icons/react'
import { AUCTION_HOUSE_ADDRESS, CHAIN_ID } from '../chain'
import { AUCTION_HOUSE_ABI } from '../abi'
import { shortAddr, parseOnchainError } from '../utils'
import { useWithGas } from '../txGas'

interface EvidenceEntry {
  party: string
  text: string
  blockNumber: bigint
  timestamp?: number
}

interface Props {
  lotId: bigint
  buyer: string   // highestBidder
  seller: string
  walletAddress?: string
  chainId?: number
  escrowActive: boolean // true when HELD or DISPUTED
}

export default function EvidencePanel({ lotId, buyer, seller, walletAddress, chainId: userChain, escrowActive }: Props) {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [entries, setEntries] = useState<EvidenceEntry[]>([])
  const [buyerCount, setBuyerCount] = useState(0)
  const [sellerCount, setSellerCount] = useState(0)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const isParty = walletAddress && (
    walletAddress.toLowerCase() === buyer.toLowerCase() ||
    walletAddress.toLowerCase() === seller.toLowerCase()
  )
  const partyCount = walletAddress?.toLowerCase() === buyer.toLowerCase() ? buyerCount : sellerCount

  const fetchEvidence = useCallback(async () => {
    if (!client) return
    try {
      const head = await client.getBlockNumber()
      const from = head > 50_000n ? head - 50_000n : 0n
      const logs = await client.getContractEvents({
        address: AUCTION_HOUSE_ADDRESS,
        abi: AUCTION_HOUSE_ABI,
        eventName: 'Evidence',
        args: { lotId },
        fromBlock: from,
        toBlock: head,
      })
      const fetched: EvidenceEntry[] = []
      let bc = 0; let sc = 0
      for (const log of logs) {
        const args = (log as unknown as { args: { party: string; text: string } }).args
        fetched.push({ party: args.party, text: args.text, blockNumber: log.blockNumber })
        if (args.party.toLowerCase() === buyer.toLowerCase()) bc++
        else if (args.party.toLowerCase() === seller.toLowerCase()) sc++
      }
      setEntries(fetched.reverse()) // newest first
      setBuyerCount(bc)
      setSellerCount(sc)
    } catch {}
  }, [client, lotId, buyer, seller])

  useEffect(() => { void fetchEvidence() }, [fetchEvidence])

  const withGas = useWithGas()
  const { writeContract: submitTx, data: submitHash } = useWriteContract()
  const { isSuccess: submitOk, isError: submitErr, error: submitRawErr } =
    useWaitForTransactionReceipt({ hash: submitHash })

  useEffect(() => {
    if (submitOk) {
      toast.success('Evidence submitted')
      setSubmitting(false)
      setText('')
      void fetchEvidence()
    }
    if (submitErr) {
      toast.error(parseOnchainError(submitRawErr))
      setSubmitting(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitOk, submitErr])

  function handleSubmit() {
    setError('')
    if (!text.trim()) { setError('Evidence text is required.'); return }
    if (text.length > 1000) { setError('Text must be 1000 characters or fewer.'); return }
    if (!walletAddress || userChain !== CHAIN_ID) { setError('Connect your wallet first.'); return }
    setSubmitting(true)
    void withGas('submitEvidence', {
      address: AUCTION_HOUSE_ADDRESS,
      abi: AUCTION_HOUSE_ABI,
      functionName: 'submitEvidence',
      args: [lotId, text],
      chainId: CHAIN_ID,
    }).then(submitTx).catch(e => { toast.error(parseOnchainError(e)); setSubmitting(false) })
  }

  const LABEL = 'block text-xs font-medium text-ink-2 mb-1'
  const INPUT_CLS = 'w-full bg-surface-2 border border-line rounded-input px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-2 transition-colors resize-none'

  return (
    <div className="rounded-panel border border-line bg-surface p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Chat size={15} className="text-ink-3" />
        <p className="font-semibold text-sm text-ink">Evidence</p>
        <span className="ml-auto text-xs text-ink-3">{entries.length} submission{entries.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Submission form — only for parties while escrow is active */}
      {escrowActive && isParty && partyCount < 10 && (
        <div className="space-y-2">
          <label className={LABEL}>Add evidence ({10 - partyCount} remaining)</label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Tracking number, description, URL, or any relevant detail..."
            className={INPUT_CLS}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3">{text.length}/1000</span>
            {error && (
              <span className="flex items-center gap-1 text-xs text-warn">
                <Warning size={11} /> {error}
              </span>
            )}
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting || !text.trim()}
            className="w-full py-2.5 rounded-btn text-sm font-medium border border-line text-ink-2 hover:border-ink-3 hover:text-ink active:translate-y-px disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit evidence'}
          </button>
        </div>
      )}

      {escrowActive && isParty && partyCount >= 10 && (
        <p className="text-xs text-ink-3">You have reached the 10-submission limit for this lot.</p>
      )}

      {/* Evidence list */}
      {entries.length === 0 ? (
        <p className="text-xs text-ink-3">No evidence submitted yet.</p>
      ) : (
        <div className="divide-y divide-line">
          {entries.map((e, i) => (
            <div key={i} className="py-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-tag ${
                  e.party.toLowerCase() === buyer.toLowerCase()
                    ? 'bg-accent/10 text-accent-text'
                    : 'bg-surface-2 text-ink-3'
                }`}>
                  {e.party.toLowerCase() === seller.toLowerCase() ? 'Seller' : 'Buyer'}
                </span>
                <span className="text-xs font-mono text-ink-3">{shortAddr(e.party)}</span>
                <span className="ml-auto text-xs text-ink-3 font-mono">block {e.blockNumber.toString()}</span>
              </div>
              <p className="text-sm text-ink break-words">{e.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
