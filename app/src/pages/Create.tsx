import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { CheckCircle, Warning } from '@phosphor-icons/react'
import { AUCTION_HOUSE_ADDRESS, USDC_ADDRESS, CHAIN_ID, REPUTATION_WRITER_ADDRESS, IDENTITY_REGISTRY_ADDRESS } from '../chain'
import { useWithGas } from '../txGas'
import { AUCTION_HOUSE_ABI, REPUTATION_WRITER_ABI, IDENTITY_REGISTRY_ABI } from '../abi'
import { fmtUsdc, parseUsdc, parseOnchainError } from '../utils'
import LotCard from '../components/LotCard'

// Two kinds of auction: "live" for a watched session (a stream or a live event, where
// the 10-second soft close is the drama), "timed" for an ordinary listing that runs
// for hours or days. The contract accepts any duration > 0.
const DURATION_PRESETS = [
  { label: '10 min',   secs: 600,     kind: 'live'  },
  { label: '15 min',   secs: 900,     kind: 'live'  },
  { label: '30 min',   secs: 1800,    kind: 'live'  },
  { label: '1 hour',   secs: 3600,    kind: 'timed' },
  { label: '2 hours',  secs: 7200,    kind: 'timed' },
  { label: '6 hours',  secs: 21600,   kind: 'timed' },
  { label: '24 hours', secs: 86400,   kind: 'timed' },
  { label: '3 days',   secs: 259200,  kind: 'timed' },
  { label: '7 days',   secs: 604800,  kind: 'timed' },
]

const INPUT_CLS = 'w-full bg-surface-2 border border-line rounded-input px-4 py-3 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-2 transition-colors'
const LABEL_CLS = 'block text-sm font-medium text-ink-2 mb-1.5'
const HELPER_CLS = 'text-xs text-ink-3 mt-1'

export default function Create() {
  const { address, chainId } = useAccount()
  const navigate = useNavigate()

  const [title, setTitle]           = useState('')
  const [description, setDescription] = useState('')
  const [imageUrl, setImageUrl]     = useState('')
  const [reserveStr, setReserveStr] = useState('1.00')
  const [incrementStr, setIncrementStr] = useState('0.50')
  const [durationSecs, setDurationSecs] = useState(3600) // default: a 1-hour timed listing
  const [step, setStep]             = useState<'form'|'approving'|'listing'>('form')
  const [error, setError]           = useState('')
  const [pendingLotURI, setPendingLotURI] = useState('')

  const reserve   = parseUsdc(reserveStr)
  const increment = parseUsdc(incrementStr)
  const bond      = reserve

  // ── Reputation ──────────────────────────────────────────────────────────────
  const [agentIdInput, setAgentIdInput] = useState('')
  const [regStep, setRegStep] = useState<'idle'|'registering'|'linking'>('idle')

  const { data: isLinked, refetch: refetchLinked } = useReadContract({
    address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'sellerRegistered',
    args: address ? [address] : undefined, chainId: CHAIN_ID, query: { enabled: !!address },
  })
  const { data: linkedAgentId } = useReadContract({
    address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'sellerAgentId',
    args: address ? [address] : undefined, chainId: CHAIN_ID, query: { enabled: !!address && !!isLinked },
  })
  const { data: cleanSalesCount } = useReadContract({
    address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'cleanSalesView',
    args: address ? [address] : undefined, chainId: CHAIN_ID, query: { enabled: !!address },
  })

  // Gas limit + fees estimated live before every send (see txGas.ts).
  const withGas = useWithGas()
  const onGasError = (e: unknown) => { const m = parseOnchainError(e); setError(m); toast.error(m); setStep('form'); setRegStep('idle') }
  const { writeContract: registerTx, data: registerHash } = useWriteContract()
  const { isSuccess: registerOk, isError: registerErr, error: registerRawErr } = useWaitForTransactionReceipt({ hash: registerHash })
  useEffect(() => {
    if (registerOk) { toast.success('Identity registered. Enter your agentId below.'); setRegStep('idle') }
    if (registerErr) { toast.error(parseOnchainError(registerRawErr)); setRegStep('idle') }
  }, [registerOk, registerErr, registerRawErr])

  const { writeContract: linkTx, data: linkHash } = useWriteContract()
  const { isSuccess: linkOk, isError: linkErr, error: linkRawErr } = useWaitForTransactionReceipt({ hash: linkHash })
  useEffect(() => {
    if (linkOk) { toast.success('Seller identity linked. Bond discounts unlock after 3 clean sales.'); void refetchLinked(); setRegStep('idle') }
    if (linkErr) { toast.error(parseOnchainError(linkRawErr)); setRegStep('idle') }
  }, [linkOk, linkErr, linkRawErr, refetchLinked])

  // ── Lot creation ────────────────────────────────────────────────────────────
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance',
    args: address ? [address, AUCTION_HOUSE_ADDRESS] : undefined,
    chainId: CHAIN_ID, query: { enabled: !!address },
  })
  const { writeContract: approveTx, data: approveHash } = useWriteContract()
  const { isSuccess: approveOk, isError: approveErr, error: approveRawErr } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: listTx, data: listHash } = useWriteContract()
  const { isSuccess: listOk, isError: listErr, error: listRawErr } = useWaitForTransactionReceipt({ hash: listHash })

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (approveOk && step === 'approving' && pendingLotURI) { void refetchAllowance(); doList(pendingLotURI) }
    if (approveErr && step === 'approving') { setError(parseOnchainError(approveRawErr)); setStep('form') }
  }, [approveOk, approveErr])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (listOk && step === 'listing') { toast.success('Lot created'); void navigate('/lots') }
    if (listErr && step === 'listing') { setError(parseOnchainError(listRawErr)); setStep('form') }
  }, [listOk, listErr])

  function buildLotURI() {
    return `data:application/json;base64,${btoa(JSON.stringify({ name: title || 'Untitled', description, image: imageUrl }))}`
  }
  function doList(lotURI: string) {
    setStep('listing')
    void withGas('list', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'list', args: [lotURI, reserve, BigInt(durationSecs), increment], chainId: CHAIN_ID }).then(listTx).catch(onGasError)
  }
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError('')
    if (!address)              { setError('Connect your wallet first.'); return }
    if (chainId !== CHAIN_ID)  { setError('Switch network first.'); return }
    if (reserve <= 0n)         { setError('Reserve must be above 0.'); return }
    if (reserve > 5_000_000n)  { setError('Reserve is capped at $5.00.'); return }
    if (increment <= 0n)       { setError('Min increment must be above 0.'); return }
    if (increment > 1_000_000n){ setError('Min increment is capped at $1.00.'); return }
    const lotURI = buildLotURI()
    if ((allowance ?? 0n) < reserve) {
      setPendingLotURI(lotURI); setStep('approving')
      void withGas('approve', { address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [AUCTION_HOUSE_ADDRESS, reserve * 10n], chainId: CHAIN_ID }).then(approveTx).catch(onGasError)
    } else { doList(lotURI) }
  }

  // ── Preview lot (synthetic) ────────────────────────────────────────────────
  const previewLot = {
    seller: address ?? '0x0000000000000000000000000000000000000000',
    tokenId: 0n, reserve, minIncrement: increment, bond,
    deadline: 0n, // unused: the preview shows the duration static (the clock starts on listing)
    highestBid: 0n, highestBidder: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    extensions: 0n, settledAt: 0n, settled: false, cancelled: false, bondReleased: false, disputed: false,
  }

  // ── No wallet ──────────────────────────────────────────────────────────────
  if (!address) {
    return (
      <div className="py-8 max-w-[640px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold text-ink tracking-tight">Create a lot</h1>
          <p className="text-ink-2 mt-2">Your lot goes live immediately. A bond equal to the reserve is held until delivery is confirmed.</p>
        </div>
        <div className="rounded-panel border border-line bg-surface p-8 flex flex-col items-center gap-3 text-center">
          <p className="text-ink-2">Connect your wallet to create a lot.</p>
          <p className="text-xs text-ink-3">You need USDC on {chainId ? 'the correct network' : 'Arc'} to post the seller bond.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="py-8">
      <div className="md:grid md:grid-cols-12 md:gap-10 flex flex-col gap-8">

        {/* ── Form (left 7 cols) ─────────────────────────────────────────── */}
        <div className="md:col-span-7 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold text-ink tracking-tight">Create a lot</h1>
            <p className="text-ink-2 mt-2">
              Your lot goes live immediately. Bond: {fmtUsdc(bond)} USDC, returned after delivery.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className={LABEL_CLS}>Title</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="What are you auctioning?"
                className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                placeholder="Describe condition, provenance, delivery method..."
                className={`${INPUT_CLS} resize-none`} />
            </div>
            <div>
              <label className={LABEL_CLS}>Image URL <span className="text-ink-3 font-normal">(optional)</span></label>
              <input type="url" value={imageUrl} onChange={e => setImageUrl(e.target.value)}
                placeholder="https://..."
                className={INPUT_CLS} />
            </div>
            <div>
              <label className={LABEL_CLS}>Reserve (USDC)</label>
              <input type="number" min="0.01" max="5.00" step="0.01" value={reserveStr}
                onChange={e => setReserveStr(e.target.value)}
                className={INPUT_CLS} />
              <p className={HELPER_CLS}>Bond: {fmtUsdc(bond)}, returned after delivery. Max $5.00.</p>
            </div>
            <div>
              <label className={LABEL_CLS}>Min increment (USDC)</label>
              <input type="number" min="0.01" max="1.00" step="0.01" value={incrementStr}
                onChange={e => setIncrementStr(e.target.value)}
                className={INPUT_CLS} />
              <p className={HELPER_CLS}>Max $1.00.</p>
            </div>
            <div>
              <label className={LABEL_CLS}>Duration</label>
              {([
                ['live',  'Live auction', 'For a stream or live event where people are watching.'],
                ['timed', 'Timed listing', 'Runs on its own; bidders come and go.'],
              ] as const).map(([kind, title, hint]) => (
                <div key={kind} className="mb-3 last:mb-0">
                  <p className="text-xs text-ink-2 mb-1.5"><span className="font-medium text-ink">{title}.</span> {hint}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {DURATION_PRESETS.filter(p => p.kind === kind).map(p => (
                      <button key={p.secs} type="button" onClick={() => setDurationSecs(p.secs)}
                        aria-pressed={durationSecs === p.secs}
                        className={`py-2.5 rounded-btn text-sm font-medium border transition-colors ${
                          durationSecs === p.secs
                            ? 'bg-accent text-accent-ink border-accent'
                            : 'bg-surface-2 border-line text-ink-2 hover:border-ink-3'
                        }`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className={HELPER_CLS}>Either way, a bid in the last 10 seconds adds 10 seconds.</p>
            </div>

            <div className="bg-surface-2 rounded-btn px-4 py-3 text-sm text-ink-2">
              Bond of <strong className="text-ink font-mono">{fmtUsdc(bond)}</strong> held until winner confirms delivery or 7 days pass.
            </div>

            {error && (
              <p className="flex items-start gap-1.5 text-sm text-warn">
                <Warning size={14} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}

            <button type="submit" disabled={step !== 'form'}
              className="w-full py-3.5 rounded-btn font-semibold text-base bg-accent text-accent-ink hover:opacity-90 active:translate-y-px disabled:opacity-50 transition-all flex items-center justify-center gap-2">
              {step === 'approving' ? 'Approving USDC...' : step === 'listing' ? 'Creating lot...' : `Create lot (bond ${fmtUsdc(bond)} USDC)`}
            </button>
          </form>

          {/* ── Seller Reputation ─────────────────────────────────────── */}
          <div className="rounded-panel border border-line bg-surface p-5 space-y-4">
            <div className="flex items-center gap-2">
              {Boolean(isLinked) && <CheckCircle size={16} weight="fill" className="text-good" />}
              <p className="font-semibold text-sm text-ink">Seller reputation</p>
            </div>

            {Boolean(isLinked) ? (
              <div className="space-y-1 text-sm">
                <p className="text-ink-3">Agent ID: <span className="font-mono text-ink">{linkedAgentId != null ? (linkedAgentId as bigint).toString() : '...'}</span></p>
                <p className="text-ink-3">
                  Clean sales: <span className="text-ink font-semibold">{cleanSalesCount != null ? (cleanSalesCount as bigint).toString() : '...'}</span>
                  {Number(cleanSalesCount ?? 0n) >= 3 && <span className="ml-2 text-good text-xs">50% bond discount active</span>}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-ink-2">Register an on-chain identity to build reputation. After 3 clean sales, your bond drops to 50%.</p>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-ink-2">Step 1 - Register identity</p>
                  <button
                    disabled={regStep !== 'idle' || chainId !== CHAIN_ID}
                    onClick={() => { setRegStep('registering'); void withGas('register', { address: IDENTITY_REGISTRY_ADDRESS, abi: IDENTITY_REGISTRY_ABI, functionName: 'register', args: [], chainId: CHAIN_ID }).then(registerTx).catch(onGasError) }}
                    className="w-full py-2.5 rounded-btn text-sm font-medium border border-line text-ink-2 hover:border-ink-3 hover:text-ink active:translate-y-px disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {regStep === 'registering' ? 'Registering...' : 'Register on IdentityRegistry'}
                  </button>
                  <p className={HELPER_CLS}>Mints an agentId NFT to your wallet. Note the agentId from the transaction.</p>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-ink-2">Step 2 - Link agentId</p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="number" min="0" placeholder="agentId from step 1"
                      value={agentIdInput} onChange={e => setAgentIdInput(e.target.value)}
                      className={`${INPUT_CLS} flex-1`}
                    />
                    <button
                      disabled={regStep !== 'idle' || !agentIdInput || chainId !== CHAIN_ID}
                      onClick={() => { setRegStep('linking'); void withGas('linkSeller', { address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'linkSeller', args: [BigInt(agentIdInput)], chainId: CHAIN_ID }).then(linkTx).catch(onGasError) }}
                      className="sm:w-auto px-5 py-3 rounded-btn text-sm font-semibold bg-accent text-accent-ink hover:opacity-90 active:translate-y-px disabled:opacity-50 flex items-center justify-center gap-1.5 min-h-[44px]"
                    >
                      {regStep === 'linking' ? 'Linking...' : 'Link'}
                    </button>
                  </div>
                  <p className={HELPER_CLS}>Proves ownership and links your identity to Gavel's reputation system.</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Live preview (right 5 cols) ─────────────────────────────── */}
        <div className="md:col-span-5">
          <div className="md:sticky md:top-20 space-y-3">
            <p className="text-xs text-ink-3">Preview</p>
            <LotCard lotId={0n} lot={previewLot} title={title || 'Untitled'} previewDurationSecs={durationSecs} />
            <p className="text-xs text-ink-3 mt-2">The clock starts when your lot is listed on chain.</p>
          </div>
        </div>

      </div>
    </div>
  )
}
