import { useState, useEffect } from 'react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { toast } from 'sonner'
import { useNavigate } from 'react-router-dom'
import { CheckCircle, Warning, Package, ImageSquare, Coins, Tag } from '@phosphor-icons/react'
import {
  AUCTION_HOUSE_ADDRESS, USDC_ADDRESS, CHAIN_ID,
  REPUTATION_WRITER_ADDRESS, IDENTITY_REGISTRY_ADDRESS,
  EURC_ADDRESS,
} from '../chain'
import { useWithGas } from '../txGas'
import { AUCTION_HOUSE_ABI, REPUTATION_WRITER_ABI, IDENTITY_REGISTRY_ABI, ERC721_ABI, ERC1155_ABI, LotKind } from '../abi'
import { fmtUsdc, parseUsdc, parseOnchainError } from '../utils'
import LotCard from '../components/LotCard'
import { useTokenMeta, parseTokenAmount, fmtTokenAmount } from '../hooks/useTokenMeta'

// ── Duration presets ─────────────────────────────────────────────────────────
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

// ── Known on-chain assets (for the dropdown helper) ──────────────────────────
const KNOWN_ERC20_ASSETS: { label: string; address: string; warning?: string }[] = [
  { label: 'EURC',  address: EURC_ADDRESS },
  // USYC is not offered: it is permissioned, so the vault itself would need to be
  // on USYC's allowlist before a listing could escrow it.
]

// ── Styling ───────────────────────────────────────────────────────────────────
const INPUT_CLS   = 'w-full bg-surface-2 border border-line rounded-input px-4 py-3 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink-2 transition-colors'
const LABEL_CLS   = 'block text-sm font-medium text-ink-2 mb-1.5'
const HELPER_CLS  = 'text-xs text-ink-3 mt-1'

const KIND_OPTIONS: { kind: LotKind; label: string; hint: string; icon: JSX.Element }[] = [
  { kind: LotKind.OFFCHAIN, label: 'Off-chain item',    hint: 'Physical goods, services, or digital files delivered off-chain. Bond + escrow protect both parties.', icon: <Package size={18} /> },
  { kind: LotKind.ERC721,   label: 'NFT (ERC-721)',     hint: 'Transfer ownership of a single non-fungible token held in escrow during the auction.',               icon: <ImageSquare size={18} /> },
  { kind: LotKind.ERC1155,  label: 'Multi-token (ERC-1155)', hint: 'Transfer a quantity of a semi-fungible token.',                                                  icon: <Tag size={18} /> },
  { kind: LotKind.ERC20,    label: 'Token (ERC-20)',    hint: 'Auction a quantity of any allowlisted ERC-20 token. Fee-on-transfer tokens are not accepted.',        icon: <Coins size={18} /> },
]

// -- Image compression helper (B3) --
async function compressToWebP(file: File, maxPx: number, maxBytes: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, w, h)
      let quality = 0.85
      const tryCompress = () => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('Compression failed')); return }
          if (blob.size <= maxBytes || quality < 0.4) { resolve(blob); return }
          quality -= 0.1
          tryCompress()
        }, 'image/webp', quality)
      }
      tryCompress()
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

export default function Create() {
  const { address, chainId } = useAccount()
  const navigate = useNavigate()

  // ── Asset kind ───────────────────────────────────────────────────────────
  const [kind, setKind] = useState<LotKind>(LotKind.OFFCHAIN)

  // ── Lot metadata (OFFCHAIN only) ─────────────────────────────────────────
  const [title, setTitle]           = useState('')
  const [description, setDescription] = useState('')
  const [imageUrl, setImageUrl]       = useState('')
  const [contactStr, setContactStr]   = useState('')
  const [deliveryStr, setDeliveryStr] = useState('')

  // ── Image upload state (B3) ─────────────────────
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadError, setUploadError]       = useState('')

  // ── On-chain asset (ERC721/ERC1155/ERC20) ──────────────────────────────────
  const [assetAddress, setAssetAddress] = useState('')
  const [tokenId, setTokenId]           = useState('')   // ERC721/ERC1155
  const [tokenAmountStr, setTokenAmountStr] = useState('') // human-units: '17' means 17 EURC

  // ── Auction params ───────────────────────────────────────────────────────
  const [reserveStr, setReserveStr]     = useState('1.00')
  const [incrementStr, setIncrementStr] = useState('0.50')
  const [durationSecs, setDurationSecs] = useState(3600)
  const [step, setStep]                 = useState<'form'|'approving-usdc'|'approving-asset'|'listing'>('form')
  const [error, setError]               = useState('')
  const [pendingLotURI, setPendingLotURI] = useState('')

  // ── Known ERC20 asset selection ──────────────────────────────────────────
  const knownAsset = KNOWN_ERC20_ASSETS.find(a => a.address.toLowerCase() === assetAddress.toLowerCase())

  // ERC-20 token metadata (decimals, symbol, seller balance)
  const { decimals: tokenDecimals, symbol: tokenSymbol, balance: tokenBalance } =
    useTokenMeta(kind === LotKind.ERC20 ? assetAddress : undefined, address)

  // Computed raw amounts from human-unit strings
  // Guard: if decimals haven't loaded yet, keep raw amount at 0n so no approval
  // can be triggered with the wrong scale (e.g. 17e18 instead of 17e6 for EURC).
  const erc20RawAmount = kind === LotKind.ERC20 && tokenDecimals !== undefined
    ? parseTokenAmount(tokenAmountStr, tokenDecimals)
    : 0n
  const erc1155RawAmount = kind === LotKind.ERC1155
    ? (tokenAmountStr.trim() && /^\d+$/.test(tokenAmountStr.trim()) ? BigInt(tokenAmountStr.trim()) : 0n)
    : 0n

  const reserve   = parseUsdc(reserveStr)
  const increment = parseUsdc(incrementStr)
  const bond      = kind === LotKind.OFFCHAIN ? reserve : 0n

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

  // ── Gas + tx hooks ──────────────────────────────────────────────────────────
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

  // ── USDC bond approval ────────────────────────────────────────────────────
  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance',
    args: address ? [address, AUCTION_HOUSE_ADDRESS] : undefined,
    chainId: CHAIN_ID, query: { enabled: !!address && kind === LotKind.OFFCHAIN },
  })
  const { writeContract: approveUsdcTx, data: approveUsdcHash } = useWriteContract()
  const { isSuccess: approveUsdcOk, isError: approveUsdcErr, error: approveUsdcRawErr } = useWaitForTransactionReceipt({ hash: approveUsdcHash })

  // ── ERC-20 asset approval ─────────────────────────────────────────────────
  const { data: erc20AssetAllowance, refetch: refetchAssetAllowance } = useReadContract({
    address: assetAddress as `0x${string}`,
    abi: erc20Abi, functionName: 'allowance',
    args: address && assetAddress ? [address, AUCTION_HOUSE_ADDRESS] : undefined,
    chainId: CHAIN_ID, query: { enabled: !!address && kind === LotKind.ERC20 && !!assetAddress },
  })
  const { writeContract: approveAssetTx, data: approveAssetHash } = useWriteContract()
  const { isSuccess: approveAssetOk, isError: approveAssetErr, error: approveAssetRawErr } = useWaitForTransactionReceipt({ hash: approveAssetHash })

  // ── ERC-721 approval ──────────────────────────────────────────────────────
  const { writeContract: approveERC721Tx, data: approveERC721Hash } = useWriteContract()
  const { isSuccess: approveERC721Ok, isError: approveERC721Err, error: approveERC721RawErr } = useWaitForTransactionReceipt({ hash: approveERC721Hash })

  // ── ERC-1155 approval ─────────────────────────────────────────────────────
  const { writeContract: approveERC1155Tx, data: approveERC1155Hash } = useWriteContract()
  const { isSuccess: approveERC1155Ok, isError: approveERC1155Err, error: approveERC1155RawErr } = useWaitForTransactionReceipt({ hash: approveERC1155Hash })

  // ── List tx ────────────────────────────────────────────────────────────────
  const { writeContract: listTx, data: listHash } = useWriteContract()
  const { isSuccess: listOk, isError: listErr, error: listRawErr } = useWaitForTransactionReceipt({ hash: listHash })

  // ── Effect: USDC approval done → proceed to list ─────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (approveUsdcOk && step === 'approving-usdc' && pendingLotURI) { void refetchAllowance(); doList(pendingLotURI) }
    if (approveUsdcErr && step === 'approving-usdc') { setError(parseOnchainError(approveUsdcRawErr)); setStep('form') }
  }, [approveUsdcOk, approveUsdcErr])

  // ── Effect: ERC-20 asset approval done → proceed to list ─────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (approveAssetOk && step === 'approving-asset' && pendingLotURI) { void refetchAssetAllowance(); doList(pendingLotURI) }
    if (approveAssetErr && step === 'approving-asset') { setError(parseOnchainError(approveAssetRawErr)); setStep('form') }
  }, [approveAssetOk, approveAssetErr])

  // ── Effect: ERC-721 approval done → list ─────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (approveERC721Ok && step === 'approving-asset' && pendingLotURI) { doList(pendingLotURI) }
    if (approveERC721Err && step === 'approving-asset') { setError(parseOnchainError(approveERC721RawErr)); setStep('form') }
  }, [approveERC721Ok, approveERC721Err])

  // ── Effect: ERC-1155 approval done → list ────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (approveERC1155Ok && step === 'approving-asset' && pendingLotURI) { doList(pendingLotURI) }
    if (approveERC1155Err && step === 'approving-asset') { setError(parseOnchainError(approveERC1155RawErr)); setStep('form') }
  }, [approveERC1155Ok, approveERC1155Err])

  // ── Effect: list done ─────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (listOk && step === 'listing') { toast.success('Lot created'); void navigate('/lots') }
    if (listErr && step === 'listing') { setError(parseOnchainError(listRawErr)); setStep('form') }
  }, [listOk, listErr])

  // ── Helpers ───────────────────────────────────────────────────────────────
  function buildOffchainURI() {
    const obj: Record<string, string> = { name: title || 'Untitled', description, image: imageUrl, contact: contactStr }
    if (deliveryStr) obj.delivery = deliveryStr
    return `data:application/json;base64,${btoa(JSON.stringify(obj))}`
  }

  // Ask the server whether Blob storage is connected, instead of relying on a build flag.
  const [uploadAvailable, setUploadAvailable] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/upload').then(r => r.ok ? r.json() : null)
      .then((d: { configured?: boolean } | null) => { if (live) setUploadAvailable(!!d?.configured) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  async function handleImageUpload(file: File) {
    setUploadError('')
    setUploadingImage(true)
    try {
      // Compress to WebP max 1200px, max 300KB in browser
      const compressed = await compressToWebP(file, 1200, 300 * 1024)
      const resp = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'image/webp' },
        body: compressed,
      })
      const data = await resp.json() as { url?: string; error?: string }
      if (!resp.ok || !data.url) throw new Error(data.error ?? 'Upload failed')
      setImageUrl(data.url)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploadingImage(false)
    }
  }

  function doList(lotURI: string) {
    setStep('listing')
    const assetAddr = (kind !== LotKind.OFFCHAIN && assetAddress) ? assetAddress as `0x${string}` : '0x0000000000000000000000000000000000000000' as `0x${string}`
    const tidBig    = (kind === LotKind.ERC721 || kind === LotKind.ERC1155) && tokenId ? BigInt(tokenId) : 0n
    const amtBig    = kind === LotKind.ERC20 ? erc20RawAmount : kind === LotKind.ERC1155 ? erc1155RawAmount : 0n
    void withGas('list', {
      address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'list',
      args: [kind, assetAddr, tidBig, amtBig, lotURI, reserve, BigInt(durationSecs), increment],
      chainId: CHAIN_ID,
    }).then(listTx).catch(onGasError)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError('')
    if (!address)             { setError('Connect your wallet first.'); return }
    if (chainId !== CHAIN_ID) { setError('Switch network first.'); return }
    if (reserve <= 0n)        { setError('Reserve must be above 0.'); return }
    if (increment <= 0n)      { setError('Min increment must be above 0.'); return }

    // Per-kind validation
    if (kind !== LotKind.OFFCHAIN) {
      if (!assetAddress) { setError('Enter the asset contract address.'); return }
    }
    if (kind === LotKind.ERC721 && !tokenId) { setError('Enter the token ID.'); return }
    if (kind === LotKind.ERC1155 && (!tokenId || !tokenAmountStr.trim())) { setError('Enter the token ID and amount.'); return }
    if (kind === LotKind.ERC1155 && !/^\d+$/.test(tokenAmountStr.trim())) { setError('Amount must be a whole number.'); return }
    if (kind === LotKind.ERC1155 && erc1155RawAmount <= 0n) { setError('Amount must be greater than 0.'); return }
    if (kind === LotKind.ERC20 && !tokenAmountStr.trim()) { setError('Enter the token amount.'); return }
    if (kind === LotKind.ERC20 && (tokenDecimals === undefined || tokenBalance === undefined)) {
      setError('Still reading the token from the chain. Try again in a moment.'); return
    }
    if (kind === LotKind.ERC20 && erc20RawAmount <= 0n) { setError('Enter a valid amount greater than 0.'); return }
    if (kind === LotKind.ERC20 && tokenBalance !== undefined && erc20RawAmount > tokenBalance) {
      const sym = tokenSymbol ?? 'tokens'
      const have = tokenDecimals !== undefined ? fmtTokenAmount(tokenBalance, tokenDecimals, sym) : tokenBalance.toString()
      setError(`Insufficient balance. You have ${have}.`); return
    }

    const lotURI = kind === LotKind.OFFCHAIN ? buildOffchainURI() : 'ipfs://gavel'

    if (kind === LotKind.OFFCHAIN && !contactStr.trim()) {
      setError('Enter a contact address so the winner can reach you.')
      return
    }

    if (kind === LotKind.OFFCHAIN) {
      // OFFCHAIN: need USDC approval for the bond
      if ((usdcAllowance ?? 0n) < reserve) {
        setPendingLotURI(lotURI); setStep('approving-usdc')
        void withGas('approve', { address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [AUCTION_HOUSE_ADDRESS, reserve * 10n], chainId: CHAIN_ID }).then(approveUsdcTx).catch(onGasError)
      } else { doList(lotURI) }
    } else if (kind === LotKind.ERC721) {
      // ERC-721: seller needs to setApprovalForAll (or approve individually)
      setPendingLotURI(lotURI); setStep('approving-asset')
      void withGas('approve-erc721', { address: assetAddress as `0x${string}`, abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [AUCTION_HOUSE_ADDRESS, true], chainId: CHAIN_ID }).then(approveERC721Tx).catch(onGasError)
    } else if (kind === LotKind.ERC1155) {
      setPendingLotURI(lotURI); setStep('approving-asset')
      void withGas('approve-erc1155', { address: assetAddress as `0x${string}`, abi: ERC1155_ABI, functionName: 'setApprovalForAll', args: [AUCTION_HOUSE_ADDRESS, true], chainId: CHAIN_ID }).then(approveERC1155Tx).catch(onGasError)
    } else {
      // ERC-20: approve the exact amount (already in raw units)
      if ((erc20AssetAllowance ?? 0n) < erc20RawAmount) {
        setPendingLotURI(lotURI); setStep('approving-asset')
        void withGas('approve-asset', { address: assetAddress as `0x${string}`, abi: erc20Abi, functionName: 'approve', args: [AUCTION_HOUSE_ADDRESS, erc20RawAmount], chainId: CHAIN_ID }).then(approveAssetTx).catch(onGasError)
      } else { doList(lotURI) }
    }
  }

  // ── Preview lot ─────────────────────────────────────────────────────────────
  const previewLot = {
    seller: address ?? '0x0000000000000000000000000000000000000000',
    tokenId: 0n, reserve, minIncrement: increment, bond,
    deadline: 0n,
    highestBid: 0n, highestBidder: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    extensions: 0n, settledAt: 0n, settled: false, cancelled: false, bondReleased: false, disputed: false,
  }

  // ── No wallet ──────────────────────────────────────────────────────────────
  if (!address) {
    return (
      <div className="py-8 max-w-[640px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold text-ink tracking-tight">Create a lot</h1>
          <p className="text-ink-2 mt-2">Your lot goes live immediately. Choose what you are auctioning and set your terms.</p>
        </div>
        <div className="rounded-panel border border-line bg-surface p-8 flex flex-col items-center gap-3 text-center">
          <p className="text-ink-2">Connect your wallet to create a lot.</p>
          <p className="text-xs text-ink-3">You need USDC on Arc to post the seller bond for off-chain lots.</p>
        </div>
      </div>
    )
  }

  const isBusy = step !== 'form'
  const submitLabel = (() => {
    if (step === 'approving-usdc')   return 'Approving USDC...'
    if (step === 'approving-asset')  return 'Approving asset...'
    if (step === 'listing')          return 'Creating lot...'
    if (kind === LotKind.OFFCHAIN)   return `Create lot (bond ${fmtUsdc(bond)} USDC)`
    return 'Create lot'
  })()

  return (
    <div className="py-8">
      <div className="md:grid md:grid-cols-12 md:gap-10 flex flex-col gap-8">

        {/* ── Form (left 7 cols) ─────────────────────────────────────────── */}
        <div className="md:col-span-7 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold text-ink tracking-tight">Create a lot</h1>
            <p className="text-ink-2 mt-2">
              {kind === LotKind.OFFCHAIN
                ? `Off-chain lot. Bond: ${fmtUsdc(bond)} USDC held until delivery confirmed.`
                : 'On-chain asset lot. The asset is held in escrow; payment is released to you on settlement.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* ── Kind selector ─────────────────────────────────────────── */}
            <div>
              <label className={LABEL_CLS}>What are you auctioning?</label>
              <div className="grid grid-cols-2 gap-2">
                {KIND_OPTIONS.map(({ kind: k, label, icon }) => (
                  <button
                    key={k} type="button" onClick={() => setKind(k)}
                    aria-pressed={kind === k}
                    className={`flex items-center gap-2 px-3 py-3 rounded-btn border text-sm font-medium transition-colors ${
                      kind === k
                        ? 'bg-accent/10 border-accent text-accent-text'
                        : 'bg-surface-2 border-line text-ink-2 hover:border-ink-3'
                    }`}
                  >
                    <span className={kind === k ? 'text-accent' : 'text-ink-3'}>{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
              <p className={HELPER_CLS}>{KIND_OPTIONS.find(o => o.kind === kind)?.hint}</p>
            </div>

            {/* ── OFFCHAIN metadata ─────────────────────────────────────── */}
            {kind === LotKind.OFFCHAIN && (
              <>
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
                  <label className={LABEL_CLS}>Image <span className="text-ink-3 font-normal">(optional)</span></label>
                  {/* B3: upload or paste URL */}
                  <div className="flex flex-col gap-2">
                    {uploadAvailable ? (
                      <div className="flex items-center gap-2">
                        <label className="flex-1 cursor-pointer rounded-input border border-dashed border-line bg-surface-2 px-4 py-2.5 text-sm text-ink-3 hover:border-ink-3 transition-colors flex items-center justify-center gap-2">
                          {uploadingImage ? 'Uploading...' : imageUrl ? 'Replace image' : 'Upload image (WebP, max 300 KB)'}
                          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={uploadingImage}
                            onChange={e => { const f = e.target.files?.[0]; if (f) void handleImageUpload(f) }} />
                        </label>
                      </div>
                    ) : (
                      <input type="url" value={imageUrl} onChange={e => setImageUrl(e.target.value)}
                        placeholder="https://..."
                        className={INPUT_CLS} />
                    )}
                    {uploadAvailable && (
                      <input type="url" value={imageUrl} onChange={e => setImageUrl(e.target.value)}
                        placeholder="or paste an image URL"
                        className={INPUT_CLS} />
                    )}
                    {uploadError && <p className="text-xs text-warn">{uploadError}</p>}
                    {imageUrl && <p className="text-xs text-good">Image set</p>}
                  </div>
                </div>
                {/* B2: Contact (required) and Delivery (optional) */}
                <div>
                  <label className={LABEL_CLS}>Contact <span className="text-warn text-xs">*</span></label>
                  <input type="text" value={contactStr} onChange={e => setContactStr(e.target.value)}
                    placeholder="Email, Telegram, or other contact"
                    className={INPUT_CLS} />
                  <p className={HELPER_CLS}>This is stored publicly on-chain. The winner uses it to arrange delivery.</p>
                </div>
                <div>
                  <label className={LABEL_CLS}>Delivery info <span className="text-ink-3 font-normal">(optional)</span></label>
                  <input type="text" value={deliveryStr} onChange={e => setDeliveryStr(e.target.value)}
                    placeholder="Shipping method, location, or conditions"
                    className={INPUT_CLS} />
                  <p className={HELPER_CLS}>Stored publicly on-chain.</p>
                </div>
              </>
            )}

            {/* ── On-chain asset fields ─────────────────────────────────── */}
            {kind !== LotKind.OFFCHAIN && (
              <>
                <div>
                  <label className={LABEL_CLS}>Asset contract address</label>
                  {kind === LotKind.ERC20 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {KNOWN_ERC20_ASSETS.map(a => (
                        <button
                          key={a.address} type="button"
                          onClick={() => setAssetAddress(a.address)}
                          className={`px-2.5 py-1 rounded-tag text-xs font-medium border transition-colors ${
                            assetAddress.toLowerCase() === a.address.toLowerCase()
                              ? 'bg-accent/10 border-accent text-accent-text'
                              : 'bg-surface-2 border-line text-ink-2 hover:border-ink-3'
                          }`}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <input type="text" value={assetAddress} onChange={e => setAssetAddress(e.target.value)}
                    placeholder="0x..."
                    className={INPUT_CLS} />
                  {knownAsset?.warning && (
                    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-warn">
                      <Warning size={12} className="mt-0.5 shrink-0" />
                      {knownAsset.warning}
                    </p>
                  )}
                </div>

                {(kind === LotKind.ERC721 || kind === LotKind.ERC1155) && (
                  <div>
                    <label className={LABEL_CLS}>Token ID</label>
                    <input type="number" min="0" value={tokenId} onChange={e => setTokenId(e.target.value)}
                      placeholder="0"
                      className={INPUT_CLS} />
                  </div>
                )}

                {(kind === LotKind.ERC1155 || kind === LotKind.ERC20) && (
                  <div>
                    <label className={LABEL_CLS}>Amount</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={tokenAmountStr}
                      onChange={e => setTokenAmountStr(e.target.value)}
                      placeholder={kind === LotKind.ERC20 ? '17' : '1'}
                      className={INPUT_CLS}
                    />
                    {/* Confirmation line */}
                    {tokenAmountStr.trim() && kind === LotKind.ERC20 && (
                      <p className={`${HELPER_CLS} ${erc20RawAmount > 0n ? 'text-good' : 'text-warn'}`}>
                        {erc20RawAmount > 0n && tokenDecimals !== undefined && tokenSymbol
                          ? `You are auctioning ${fmtTokenAmount(erc20RawAmount, tokenDecimals, tokenSymbol)}.`
                          : tokenDecimals === undefined
                          ? 'Enter a valid asset address to load decimals.'
                          : 'Enter a valid amount.'}
                      </p>
                    )}
                    {tokenAmountStr.trim() && kind === LotKind.ERC1155 && (
                      <p className={`${HELPER_CLS} ${erc1155RawAmount > 0n ? 'text-good' : 'text-warn'}`}>
                        {erc1155RawAmount > 0n
                          ? `You are auctioning ${erc1155RawAmount.toString()} token(s).`
                          : 'Amount must be a whole number greater than 0.'}
                      </p>
                    )}
                    {/* Balance check for ERC-20 */}
                    {kind === LotKind.ERC20 && erc20RawAmount > 0n && tokenBalance !== undefined && erc20RawAmount > tokenBalance && tokenDecimals !== undefined && tokenSymbol && (
                      <p className="text-xs text-warn mt-1">
                        Insufficient balance. You have {fmtTokenAmount(tokenBalance, tokenDecimals, tokenSymbol)}.
                      </p>
                    )}
                    {kind === LotKind.ERC20 && tokenBalance !== undefined && tokenDecimals !== undefined && tokenSymbol && (
                      <p className={HELPER_CLS}>Balance: {fmtTokenAmount(tokenBalance, tokenDecimals, tokenSymbol)}</p>
                    )}
                  </div>
                )}

              </>
            )}

            {/* ── Reserve ──────────────────────────────────────────────── */}
            <div>
              <label className={LABEL_CLS}>Reserve (USDC)</label>
              <input type="number" min="0.01" step="0.01" value={reserveStr}
                onChange={e => setReserveStr(e.target.value)}
                className={INPUT_CLS} />
              {kind === LotKind.OFFCHAIN
                ? <p className={HELPER_CLS}>Bond: {fmtUsdc(bond)} USDC held until delivery confirmed.</p>
                : <p className={HELPER_CLS}>Minimum first bid. No bond required for on-chain asset lots.</p>}
            </div>
            <div>
              <label className={LABEL_CLS}>Min increment (USDC)</label>
              <input type="number" min="0.01" step="0.01" value={incrementStr}
                onChange={e => setIncrementStr(e.target.value)}
                className={INPUT_CLS} />
            </div>

            {/* ── Duration ─────────────────────────────────────────────── */}
            <div>
              <label className={LABEL_CLS}>Duration</label>
              {([
                ['live',  'Live auction', 'For a stream or live event where people are watching.'],
                ['timed', 'Timed listing', 'Runs on its own; bidders come and go.'],
              ] as const).map(([k, lbl, hint]) => (
                <div key={k} className="mb-3 last:mb-0">
                  <p className="text-xs text-ink-2 mb-1.5"><span className="font-medium text-ink">{lbl}.</span> {hint}</p>
                  <div className="grid grid-cols-3 gap-2">
                    {DURATION_PRESETS.filter(p => p.kind === k).map(p => (
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
              <p className={HELPER_CLS}>A bid in the last 10 seconds adds 10 seconds. Up to 500 extensions.</p>
            </div>

            {kind === LotKind.OFFCHAIN && (
              <div className="bg-surface-2 rounded-btn px-4 py-3 text-sm text-ink-2">
                Bond of <strong className="text-ink font-mono">{fmtUsdc(bond)}</strong> held until winner confirms delivery or 7 days pass.
                If unresolved, either party may raise a dispute within 7 days of settlement.
              </div>
            )}

            {error && (
              <p className="flex items-start gap-1.5 text-sm text-warn">
                <Warning size={14} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}

            <button type="submit" disabled={isBusy}
              className="w-full py-3.5 rounded-btn font-semibold text-base bg-accent text-accent-ink hover:opacity-90 active:translate-y-px disabled:opacity-50 transition-all flex items-center justify-center gap-2">
              {submitLabel}
            </button>
          </form>

          {/* ── Seller Reputation (OFFCHAIN only) ─────────────────────── */}
          {kind === LotKind.OFFCHAIN && (
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
          )}
        </div>

        {/* ── Live preview (right 5 cols) ─────────────────────────────── */}
        <div className="md:col-span-5">
          <div className="md:sticky md:top-20 space-y-3">
            <p className="text-xs text-ink-3">Preview</p>
            <LotCard
              lotId={0n} lot={previewLot}
              title={kind === LotKind.OFFCHAIN ? (title || 'Untitled') : `${KIND_OPTIONS.find(o => o.kind === kind)?.label ?? 'Asset'} lot`}
              previewDurationSecs={durationSecs}
              kind={kind}
            />
            <p className="text-xs text-ink-3 mt-2">The clock starts when your lot is listed on chain.</p>
          </div>
        </div>

      </div>
    </div>
  )
}
