import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import {
  useAccount, useWriteContract, useWaitForTransactionReceipt,
  useReadContract, usePublicClient, useSignTypedData, useBalance,
} from 'wagmi'
import { erc20Abi, toHex, encodeAbiParameters, parseAbiParameters, keccak256, type Hex } from 'viem'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import {
  Gavel, Timer, ArrowSquareOut, CheckCircle, ShieldWarning,
  Lightning, Spinner, Warning,
} from '@phosphor-icons/react'
import {
  AUCTION_HOUSE_ADDRESS, USDC_ADDRESS, CHAIN_ID, txUrl, addrUrl,
  MEMO_ADDRESS, REPUTATION_WRITER_ADDRESS,
} from '../chain'
import { AUCTION_HOUSE_ABI, MEMO_ABI, REPUTATION_WRITER_ABI, type LotTuple } from '../abi'
import { encodeFunctionData } from 'viem'
import { fmtUsdc, fmtDuration, shortAddr, parseOnchainError } from '../utils'
import { useLatestBlock } from '../useBlock'
import { keepPreviousData } from '@tanstack/react-query'
import { useWithGas } from '../txGas'
import { useLogStore } from '../useLogs'

// ── Helpers ────────────────────────────────────────────────────────────────────
function splitSig(sig: Hex) {
  const hex = sig as string
  const r: Hex = `0x${hex.slice(2, 66)}`
  const s: Hex = `0x${hex.slice(66, 130)}`
  const v = parseInt(hex.slice(130, 132), 16)
  return { v, r, s }
}

// ── Countdown hook — block-synced + interpolated ───────────────────────────────
function useCountdown(deadlineSec: number) {
  const block = useLatestBlock()
  const [secs, setSecs] = useState(0)
  const [extended, setExtended] = useState(false)
  const prevDeadline = useRef(deadlineSec)

  useEffect(() => {
    if (deadlineSec > prevDeadline.current && deadlineSec !== prevDeadline.current) {
      setExtended(true)
      const t = setTimeout(() => setExtended(false), 1500)
      prevDeadline.current = deadlineSec
      return () => clearTimeout(t)
    }
    prevDeadline.current = deadlineSec
  }, [deadlineSec])

  useEffect(() => {
    if (!block) return
    const base = Number(block.blockTimestamp)
    const capturedAt = Date.now() / 1000
    const timer = setInterval(() => {
      const elapsed = Date.now() / 1000 - capturedAt
      setSecs(Math.max(0, deadlineSec - (base + elapsed)))
    }, 50)
    return () => clearInterval(timer)
  }, [block, deadlineSec])

  return { secs, extended }
}

// ── Bid row ────────────────────────────────────────────────────────────────────
function BidRow({ amount, bidder, hash, isGasless }: {
  amount: bigint; bidder: string; hash: string; isGasless: boolean
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="flex items-center justify-between py-2.5 border-b border-line last:border-0"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="font-mono tabular-nums font-semibold text-ink text-sm">{fmtUsdc(amount)}</span>
        <span className="font-mono text-ink-2 text-xs truncate">{shortAddr(bidder)}</span>
        {isGasless && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-tag text-[10px] font-semibold bg-warn/15 text-warn">
            <Lightning size={9} weight="fill" /> No gas
          </span>
        )}
      </div>
      <a
        href={txUrl(hash)} target="_blank" rel="noopener noreferrer"
        className="ml-3 shrink-0 text-ink-3 hover:text-accent-text transition-colors"
        aria-label="View transaction"
      >
        <ArrowSquareOut size={14} />
      </a>
    </motion.div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function AuctionRoom() {
  const { id } = useParams<{ id: string }>()
  const lotId = BigInt(id ?? '0')
  const { address, chainId } = useAccount()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const block = useLatestBlock()

  // ── Lot state ──────────────────────────────────────────────────────────────
  const [lot, setLot] = useState<LotTuple | undefined>()
  const [lotLoading, setLotLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [lotImage, setLotImage] = useState<string | null>(null)
  const [prevBid, setPrevBid] = useState<bigint>(0n)
  const [bidFlash, setBidFlash] = useState(false)

  const fetchLot = useCallback(async () => {
    if (!client) return
    try {
      const raw = await client.readContract({
        address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI,
        functionName: 'lots', args: [lotId],
      }) as [`0x${string}`,bigint,bigint,bigint,bigint,bigint,bigint,`0x${string}`,bigint,bigint,boolean,boolean,boolean,boolean]
      const next: LotTuple = {
        seller: raw[0], tokenId: raw[1], reserve: raw[2],
        minIncrement: raw[3], bond: raw[4], deadline: raw[5],
        highestBid: raw[6], highestBidder: raw[7], extensions: raw[8],
        settledAt: raw[9], settled: raw[10], cancelled: raw[11],
        bondReleased: raw[12], disputed: raw[13],
      }
      setLot(prev => {
        if (prev && next.highestBid > prev.highestBid) {
          setPrevBid(prev.highestBid)
          setBidFlash(true)
          setTimeout(() => setBidFlash(false), 800)
        }
        return next
      })
      setLotLoading(false)
    } catch { setLotLoading(false) }
  }, [client, lotId])

  useEffect(() => {
    if (!client || !lot || title) return
    void (async () => {
      try {
        const gavelAddr = await client.readContract({
          address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI,
          functionName: 'gavelLot', args: [],
        }) as `0x${string}`
        const uri = await client.readContract({
          address: gavelAddr,
          abi: [{ name: 'tokenURI', type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' }] as const,
          functionName: 'tokenURI', args: [lot.tokenId],
        })
        if (uri.startsWith('data:application/json')) {
          const json = JSON.parse(atob(uri.split(',')[1])) as { name?: string; image?: string }
          setTitle(json.name ?? '')
          setLotImage(json.image?.trim() || null)
        } else if (uri && !uri.startsWith('http') && !uri.startsWith('ipfs')) {
          setTitle(uri.trim())
        }
      } catch {}
    })()
  }, [client, lot, title])

  useEffect(() => { void fetchLot() }, [fetchLot, block?.blockNumber])

  // ── Log store ──────────────────────────────────────────────────────────────
  const { logs: allStoreLogs } = useLogStore()

  const relayedHashes = new Set(
    allStoreLogs
      .filter(l => l.name === 'RelayedBid' && typeof l.args.lotId === 'bigint' && l.args.lotId === lotId)
      .map(l => l.transactionHash)
  )
  // This lot's own Bid events, fetched directly (one small getLogs filtered by lotId over
  // the recent blocks) so new bids show at once instead of waiting for the shared store's
  // full-history scan. Refetched whenever the current bid changes.
  type LotBid = { amount: bigint; bidder: string; hash: `0x${string}`; blockNumber: bigint }
  const [recentBids, setRecentBids] = useState<LotBid[]>([])
  const currentHighBid = lot?.highestBid
  useEffect(() => {
    if (!client) return
    let cancelled = false
    let retryT: ReturnType<typeof setTimeout> | undefined
    // The lot state can update a moment before the RPC serves the matching Bid log, so if
    // the newest fetched bid is below the lot's current high bid, retry a few times.
    const load = async (attempt: number) => {
      try {
        const head = await client.getBlockNumber()
        const from = head > 9_000n ? head - 9_000n : 0n
        const logs = await client.getContractEvents({
          address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, eventName: 'Bid',
          args: { lotId }, fromBlock: from, toBlock: head,
        })
        if (cancelled) return
        const bids = logs.map(l => {
          // The ABI is loaded from JSON, so event args are not inferred; cast to the known shape.
          const a = (l as unknown as { args: { amount: bigint; bidder: string } }).args
          return { amount: a.amount, bidder: a.bidder, hash: l.transactionHash, blockNumber: l.blockNumber }
        })
        setRecentBids(bids)
        const top = bids.reduce((m, b) => (b.amount > m ? b.amount : m), 0n)
        if (currentHighBid !== undefined && top < currentHighBid && attempt < 5) {
          retryT = setTimeout(() => void load(attempt + 1), 1500)
        }
      } catch {
        if (attempt < 5) retryT = setTimeout(() => void load(attempt + 1), 2000)
      }
    }
    void load(0)
    return () => { cancelled = true; clearTimeout(retryT) }
  }, [client, lotId, currentHighBid])

  const bidLogs = (() => {
    const byHash = new Map<string, LotBid>()
    for (const l of allStoreLogs) {
      if (l.name === 'Bid' && typeof l.args.lotId === 'bigint' && l.args.lotId === lotId) {
        byHash.set(l.transactionHash, { amount: l.args.amount as bigint, bidder: l.args.bidder as string, hash: l.transactionHash, blockNumber: l.blockNumber })
      }
    }
    for (const b of recentBids) byHash.set(b.hash, b)
    return Array.from(byHash.values())
      .map(b => ({ ...b, isGasless: relayedHashes.has(b.hash) }))
      .sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))
  })()

  const hammerHash = allStoreLogs.find(
    l => l.name === 'Hammer' && typeof l.args.lotId === 'bigint' && l.args.lotId === lotId
  )?.transactionHash ?? ''

  // ── Live watchers ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!client) return
    let cancelled = false
    let unsubExt: (() => void) | null = null
    let unsubBid: (() => void) | null = null
    let retryT: ReturnType<typeof setTimeout> | null = null
    const BACK = [1000, 2000, 4000, 8000, 16000, 30000]
    let att = 0

    function start() {
      if (cancelled) return
      try {
        unsubExt = client!.watchContractEvent({ address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, eventName: 'Extended', args: { lotId }, onLogs: () => { void fetchLot() }, onError: err })
        unsubBid = client!.watchContractEvent({ address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, eventName: 'Bid',      args: { lotId }, onLogs: () => { void fetchLot() }, onError: err })
        att = 0
      } catch (e) { err(e as Error) }
    }
    function err(e: Error) {
      if (cancelled) return
      unsubExt?.(); unsubBid?.(); unsubExt = unsubBid = null
      const isRL = e.message?.toLowerCase().includes('rate') || e.message?.includes('-32005')
      const delay = BACK[Math.min(att, BACK.length - 1)] * (isRL ? 1 : 0.5)
      att++
      retryT = setTimeout(start, delay + Math.random() * 500)
    }
    start()
    return () => { cancelled = true; if (retryT) clearTimeout(retryT); unsubExt?.(); unsubBid?.() }
  }, [client, lotId, fetchLot])

  // ── Countdown ──────────────────────────────────────────────────────────────
  const { secs, extended } = useCountdown(lot ? Number(lot.deadline) : 0)
  const isLive    = !!lot && !lot.settled && !lot.cancelled && secs > 0
  const isEnded   = !!lot && !lot.settled && !lot.cancelled && secs <= 0
  const isSettled = !!lot?.settled

  // ── Gasless auto-detect ────────────────────────────────────────────────────
  const { data: nativeBal } = useBalance({ address, chainId: CHAIN_ID })
  const [gaslessMode, setGaslessMode] = useState(false)
  useEffect(() => {
    if (!nativeBal) return
    setGaslessMode(nativeBal.value < 10_000_000_000_000_000n)
  }, [nativeBal])

  // ── Bid flow ───────────────────────────────────────────────────────────────
  const nextBid = lot ? (lot.highestBid === 0n ? lot.reserve : lot.highestBid + lot.minIncrement) : 0n
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'allowance',
    args: address ? [address, AUCTION_HOUSE_ADDRESS] : undefined,
    chainId: CHAIN_ID, query: { enabled: !!address },
  })
  const { data: claimable } = useReadContract({
    address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'claimable',
    args: address ? [address] : undefined, chainId: CHAIN_ID,
    // keepPreviousData: each block is a new query key; without it the value is
    // undefined until refetched and the outbid banner flickers in and out.
    blockNumber: block?.blockNumber, query: { enabled: !!address, placeholderData: keepPreviousData },
  })

  const [bidStep, setBidStep] = useState<'idle'|'approving'|'bidding'|'confirming'|'signing'|'relaying'>('idle')
  const [bidError, setBidError] = useState('')

  // Gas limit + fees estimated live before every send (see txGas.ts). A revert found
  // during estimation is shown here and nothing is sent.
  const withGas = useWithGas()
  const onGasError = (e: unknown) => { setBidError(parseOnchainError(e)); toast.error(parseOnchainError(e)); setBidStep('idle') }
  const { writeContract: approveTx, data: approveHash } = useWriteContract()
  const { isSuccess: approveOk, isError: approveErr, error: approveRawErr } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: bidTx, data: bidHash } = useWriteContract()
  const { isSuccess: bidOk, isLoading: bidConfirming, isError: bidErr, error: bidRawErr } = useWaitForTransactionReceipt({ hash: bidHash })
  const { signTypedDataAsync } = useSignTypedData()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (approveOk && bidStep === 'approving') { void refetchAllowance(); placeBid() }
    if (approveErr && bidStep === 'approving') { setBidError(parseOnchainError(approveRawErr)); setBidStep('idle') }
  }, [approveOk, approveErr])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (bidConfirming && bidStep === 'bidding') setBidStep('confirming')
    if (bidOk && (bidStep === 'bidding' || bidStep === 'confirming')) { toast.success('Bid placed'); setBidStep('idle'); void fetchLot() }
    if (bidErr && (bidStep === 'bidding' || bidStep === 'confirming')) { setBidError(parseOnchainError(bidRawErr)); setBidStep('idle') }
  }, [bidOk, bidErr, bidConfirming])

  function placeBid() {
    setBidStep('bidding')
    void withGas('bid', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'bid', args: [lotId, nextBid], chainId: CHAIN_ID }).then(bidTx).catch(onGasError)
  }

  async function placeGaslessBid() {
    if (!address || !client) return
    setBidError(''); setBidStep('signing')
    try {
      const salt        = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const validAfter  = 0n
      // Use the latest block timestamp as the time base so clock skew cannot
      // cause USDC to reject the authorization as expired. Fall back to
      // Date.now() only before the first block arrives.
      const chainNow = block?.blockTimestamp ? Number(block.blockTimestamp) : Math.floor(Date.now() / 1000)
      const validBefore = BigInt(chainNow + 120)
      const usdcNonce   = keccak256(encodeAbiParameters(
        parseAbiParameters('address, uint256, uint256, uint256, bytes32'),
        [AUCTION_HOUSE_ADDRESS, BigInt(CHAIN_ID), lotId, nextBid, salt],
      ))
      const sigHex = await signTypedDataAsync({
        domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC_ADDRESS },
        types: { ReceiveWithAuthorization: [
          { name: 'from',        type: 'address' },
          { name: 'to',          type: 'address' },
          { name: 'value',       type: 'uint256' },
          { name: 'validAfter',  type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce',       type: 'bytes32' },
        ]},
        primaryType: 'ReceiveWithAuthorization',
        // uint256 fields as decimal strings: MetaMask's SDK connector serialises bigint
        // as "150000n", which MetaMask rejects ("Invalid number"). EIP-712 accepts
        // decimal strings for uintN, and the signed hash is identical.
        message: {
          from: address, to: AUCTION_HOUSE_ADDRESS,
          value: nextBid.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(),
          nonce: usdcNonce,
        } as never,
      })
      setBidStep('relaying')
      const resp = await fetch('/relay/bid', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lotId: Number(lotId), amount: nextBid.toString(), from: address, validAfter: validAfter.toString(), validBefore: validBefore.toString(), salt, sig: splitSig(sigHex) }),
      })
      const data = await resp.json() as { txHash?: string; error?: string }
      if (!resp.ok || data.error) throw new Error(data.error ?? 'The relayer did not respond. Try again or bid with gas.')
      toast.success('Gasless bid submitted')
      setBidStep('idle'); void fetchLot()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('User rejected') || msg.includes('user rejected') || msg.includes('denied')) { setBidStep('idle'); return }
      setBidError(msg); setBidStep('idle')
    }
  }

  function handleBid() {
    setBidError('')
    if (!address)            { setBidError('Connect your wallet to bid.'); return }
    if (chainId !== CHAIN_ID){ setBidError('Switch network to bid.'); return }
    if (gaslessMode) { void placeGaslessBid(); return }
    if ((allowance ?? 0n) < nextBid) {
      setBidStep('approving')
      void withGas('approve', { address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve', args: [AUCTION_HOUSE_ADDRESS, nextBid * 10n], chainId: CHAIN_ID }).then(approveTx).catch(onGasError)
    } else { placeBid() }
  }

  // ── Settle / Memo settle ────────────────────────────────────────────────────
  const { writeContract: settleTx, data: settleHash } = useWriteContract()
  const { isSuccess: settleOk } = useWaitForTransactionReceipt({ hash: settleHash })
  useEffect(() => { if (settleOk) void fetchLot() }, [settleOk, fetchLot])

  const { writeContract: settleViaMemoTx, data: settleViaMemoHash } = useWriteContract()
  const { isSuccess: settleViaMemoOk } = useWaitForTransactionReceipt({ hash: settleViaMemoHash })
  useEffect(() => { if (settleViaMemoOk) { toast.success('Settled with Memo'); void fetchLot() } }, [settleViaMemoOk, fetchLot])

  function handleSettleViaMemo() {
    const settleCalldata = encodeFunctionData({ abi: AUCTION_HOUSE_ABI, functionName: 'settle', args: [lotId] })
    const memoId      = ('0x' + lotId.toString(16).padStart(64, '0')) as `0x${string}`
    const memoDataBytes = new TextEncoder().encode(`gavel:settle:lot${lotId.toString()}`)
    const memoDataHex   = ('0x' + Array.from(memoDataBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`
    void withGas('settleViaMemo', { address: MEMO_ADDRESS, abi: MEMO_ABI, functionName: 'memo', args: [AUCTION_HOUSE_ADDRESS as `0x${string}`, settleCalldata, memoId, memoDataHex], chainId: CHAIN_ID }).then(settleViaMemoTx).catch(onGasError)
  }

  // ── Post-settle actions ────────────────────────────────────────────────────
  const { writeContract: recordSaleTx, data: recordSaleHash } = useWriteContract()
  const { isLoading: recordSaleLoading, isSuccess: recordSaleOk } = useWaitForTransactionReceipt({ hash: recordSaleHash })
  useEffect(() => { if (recordSaleOk) toast.success('Sale recorded to reputation registry') }, [recordSaleOk])

  const { writeContract: confirmDeliveryTx, data: cdHash } = useWriteContract()
  const { isLoading: cdLoading, isSuccess: cdOk } = useWaitForTransactionReceipt({ hash: cdHash })
  useEffect(() => { if (cdOk) { toast.success('Bond released to seller.'); void fetchLot() } }, [cdOk, fetchLot])

  const { writeContract: disputeTx, data: disputeHash } = useWriteContract()
  const { isLoading: disputeLoading, isSuccess: disputeOk } = useWaitForTransactionReceipt({ hash: disputeHash })
  useEffect(() => { if (disputeOk) { toast.success('Dispute raised.'); void fetchLot() } }, [disputeOk, fetchLot])

  const { writeContract: claimTx, data: claimHash } = useWriteContract()
  const { isLoading: claimLoading, isSuccess: claimOk } = useWaitForTransactionReceipt({ hash: claimHash })
  useEffect(() => { if (claimOk) toast.success('USDC claimed') }, [claimOk])

  // ── Derived ────────────────────────────────────────────────────────────────
  if (lotLoading) {
    return (
      <div className="py-20 flex flex-col gap-4 animate-pulse">
        <div className="h-6 w-1/3 rounded-btn bg-surface-2" />
        <div className="h-10 w-2/3 rounded-btn bg-surface-2" />
        <div className="md:grid md:grid-cols-12 md:gap-8 mt-6 gap-6 flex flex-col">
          <div className="md:col-span-7 space-y-4">
            <div className="h-64 rounded-panel bg-surface-2" />
          </div>
          <div className="md:col-span-5">
            <div className="h-96 rounded-panel bg-surface-2" />
          </div>
        </div>
      </div>
    )
  }

  const NULL_ADDR = '0x0000000000000000000000000000000000000000'
  if (!lot || lot.seller === NULL_ADDR) {
    return (
      <div className="py-32 text-center space-y-4">
        <Gavel size={40} weight="thin" className="text-ink-3 mx-auto" />
        <p className="text-ink-2">Lot #{id} not found.</p>
      </div>
    )
  }

  const isWinner      = !!address && lot.highestBidder.toLowerCase() === address.toLowerCase()
  const isSellerView  = !!address && lot.seller.toLowerCase() === address.toLowerCase()
  const claimableAmt  = (claimable as bigint | undefined) ?? 0n
  // Show the withdraw banner whenever this wallet has a balance, leading or not: money from
  // earlier outbid bids (or a sale) must never sit there unseen.
  const isOutbid      = !!address && claimableAmt > 0n
  const chainNowSec   = block?.blockTimestamp ? Number(block.blockTimestamp) : Math.floor(Date.now() / 1000)
  const bondDays      = lot.settledAt > 0n ? Math.max(0, 7 - Math.floor((chainNowSec - Number(lot.settledAt)) / 86400)) : 7
  const isBidBusy     = bidStep !== 'idle'
  const urgent        = isLive && secs < 10

  return (
    <div className="py-6">
      {/* Breadcrumb */}
      <p className="text-xs text-ink-3 font-mono mb-2">Lot #{id}</p>

      {/* Mobile-only: title + seller above the panel */}
      <div className="md:hidden mb-4">
        <h1 className="text-2xl font-semibold text-ink tracking-tight text-balance leading-tight">
          {title || `Lot #${id}`}
        </h1>
        <p className="text-sm text-ink-2 mt-1">
          Seller:{' '}
          <a href={addrUrl(lot.seller)} target="_blank" rel="noopener noreferrer"
            className="font-mono text-ink-2 hover:text-ink transition-colors">{shortAddr(lot.seller)}</a>
        </p>
      </div>

      {/* Grid: panel is order-1 on mobile (appears first), left col is order-2 */}
      <div className="md:grid md:grid-cols-12 md:gap-8 flex flex-col gap-6">

        {/* ── Right column (5 cols) — FIRST on mobile ─────────────────── */}
        <div className="md:col-span-5 order-1 md:order-2">
          <div className="md:sticky md:top-20 space-y-4">

            {/* ── AUCTION PANEL ────────────────────────────────────────── */}
            <div className={`rounded-panel border bg-surface p-6 space-y-5 ${
              extended ? 'animate-pulse-once' : 'border-line'
            } ${isLive ? 'shadow-clock' : ''}`}>

              {/* Live tag */}
              {isLive && (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-tag bg-accent/15 text-accent-text text-[10px] font-semibold uppercase tracking-widest">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                    Live
                  </span>
                  {lot.extensions > 0n && (
                    <span className="text-[10px] text-ink-3 font-mono">{lot.extensions.toString()} ext</span>
                  )}
                </div>
              )}

              {/* Clock */}
              {isLive && (
                <div className="relative">
                  <AnimatePresence>
                    {extended && (
                      <motion.span
                        key="ext-chip"
                        initial={{ opacity: 0, y: 4, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="absolute -top-6 left-0 text-xs font-semibold text-warn bg-warn/15 px-2 py-0.5 rounded-tag"
                      >
                        +10 s
                      </motion.span>
                    )}
                  </AnimatePresence>
                  <motion.p
                    key={Math.floor(secs / 1)}
                    className={`text-7xl md:text-8xl font-mono tabular-nums font-bold tracking-tight leading-none ${
                      extended ? 'text-warn' : urgent ? 'text-accent' : 'text-ink'
                    }`}
                  >
                    {/* Round UP: the clock must never read 0:00 while bids are still accepted. */}
                    {fmtDuration(Math.ceil(secs))}
                  </motion.p>
                  {urgent && secs > 0 && (
                    <p className="text-xs text-accent-text mt-1.5 flex items-center gap-1">
                      <Timer size={11} /> A bid now adds 10 seconds
                    </p>
                  )}
                </div>
              )}

              {/* Hammer state */}
              {(isEnded || isSettled) && (
                <div className="text-center py-2">
                  <motion.div
                    initial={{ y: -12, rotate: -20, opacity: 0 }}
                    animate={{ y: 0, rotate: 0, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 24 }}
                    className="inline-block mb-3"
                  >
                    <Gavel size={40} weight="bold" className="text-accent" />
                  </motion.div>
                  {isSettled && lot.highestBidder !== NULL_ADDR ? (
                    <div>
                      <p className="text-ink-2 text-sm">Sold for</p>
                      <p className="text-3xl font-mono tabular-nums font-bold text-ink">{fmtUsdc(lot.highestBid)}</p>
                      {hammerHash && (
                        <a href={txUrl(hammerHash)} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-accent-text mt-1 transition-colors">
                          Settlement tx <ArrowSquareOut size={10} />
                        </a>
                      )}
                    </div>
                  ) : isEnded ? (
                    <div>
                      <p className="text-ink-2 text-sm">Auction ended</p>
                      {lot.highestBidder !== NULL_ADDR && (
                        <>
                          <p className="text-ink-2 text-sm mt-2">Winning bid</p>
                          <p className="text-3xl font-mono tabular-nums font-bold text-ink">{fmtUsdc(lot.highestBid)}</p>
                          <p className="text-xs text-ink-3 mt-1">Settle to hand the lot to the winner and pay the seller.</p>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-ink-3">No bids. Lot returned to seller.</p>
                  )}
                </div>
              )}

              {/* Current bid: only while live. After the hammer the "Sold for" figure says it. */}
              {isLive && (
              <div>
                <p className="text-xs text-ink-3 mb-1">{lot.highestBid > 0n ? 'Current bid' : 'Reserve'}</p>
                <AnimatePresence mode="wait">
                  <motion.p
                    key={bidFlash ? 'flash' : 'stable'}
                    initial={bidFlash ? { opacity: 0, y: 8 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22 }}
                    className="text-5xl md:text-6xl font-mono tabular-nums font-bold text-ink leading-none"
                  >
                    {fmtUsdc(lot.highestBid > 0n ? lot.highestBid : lot.reserve)}
                  </motion.p>
                </AnimatePresence>
                {bidFlash && prevBid > 0n && (
                  <p className="text-xs text-ink-3 mt-1 font-mono">was {fmtUsdc(prevBid)}</p>
                )}
              </div>
              )}

              {/* Leader */}
              {lot.highestBidder !== NULL_ADDR && (
                <p className={`text-sm font-mono ${isWinner ? 'text-good font-semibold' : 'text-ink-2'}`}>
                  {isWinner
                    ? (isLive ? 'You are winning' : 'You won')
                    : (isLive ? shortAddr(lot.highestBidder) : `Won by ${shortAddr(lot.highestBidder)}`)}
                </p>
              )}

              {/* Step line: only show Reserve when there are bids (otherwise it's the big figure) */}
              <div className="flex gap-4 text-xs text-ink-3 font-mono">
                {lot.highestBid > 0n && <span>Reserve {fmtUsdc(lot.reserve)}</span>}
                <span>Min step {fmtUsdc(lot.minIncrement)}</span>
              </div>

              {/* Leading: no bid button (there is no proxy bidding, so raising your own
                  bid only costs you more). It comes back as soon as someone outbids you. */}
              {isLive && isWinner && bidStep === 'idle' && (
                <div className="rounded-btn bg-good/10 border border-good/30 px-4 py-3">
                  <p className="text-sm font-semibold text-good">You're the highest bidder.</p>
                  <p className="text-xs text-ink-2 mt-0.5">If someone outbids you, the Bid button comes back here.</p>
                </div>
              )}

              {/* Sellers cannot bid on their own lot; the contract rejects it too. */}
              {isLive && isSellerView && (
                <div className="rounded-btn bg-surface-2 border border-line px-4 py-3">
                  <p className="text-sm font-semibold text-ink">This is your lot.</p>
                  <p className="text-xs text-ink-2 mt-0.5">Sellers can't bid on their own auctions. Share the link to bring in bidders.</p>
                </div>
              )}

              {/* Bid controls */}
              {isLive && !isSellerView && !(isWinner && bidStep === 'idle') && (
                <div className="space-y-3 pt-1">
                  <button
                    onClick={handleBid}
                    disabled={isBidBusy}
                    className="w-full py-3.5 rounded-btn font-semibold text-base bg-accent text-accent-ink hover:opacity-90 active:translate-y-px disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                  >
                    {bidStep === 'approving'  && <><Spinner size={16} className="animate-spin" />Approving...</>}
                    {bidStep === 'bidding'    && <><Spinner size={16} className="animate-spin" />Confirm in wallet...</>}
                    {bidStep === 'confirming' && <><Spinner size={16} className="animate-spin" />Confirming...</>}
                    {bidStep === 'signing'    && <><Spinner size={16} className="animate-spin" />Sign in wallet...</>}
                    {bidStep === 'relaying'   && <><Spinner size={16} className="animate-spin" />Relaying...</>}
                    {bidStep === 'idle' && (
                      address
                        ? <>{gaslessMode && <Lightning size={15} weight="fill" />}{gaslessMode ? 'Gasless bid ' : 'Bid '}{fmtUsdc(nextBid)}</>
                        : 'Connect wallet to bid'
                    )}
                  </button>
                  {!!address && bidStep === 'idle' && (
                    <p className="text-xs text-ink-3 -mt-1">
                      Locks the full {fmtUsdc(nextBid)}. If you are outbid it comes back to you to claim.
                    </p>
                  )}

                  {/* Gasless toggle */}
                  {!!address && (
                    <button
                      onClick={() => setGaslessMode(g => !g)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-btn bg-surface-2 hover:bg-line transition-colors text-sm"
                      aria-pressed={gaslessMode}
                    >
                      <span className="flex items-center gap-2 text-ink-2">
                        <Lightning size={14} weight={gaslessMode ? 'fill' : 'regular'} className={gaslessMode ? 'text-warn' : ''} />
                        No gas needed
                      </span>
                      <span className={`relative w-9 h-5 rounded-full transition-colors ${gaslessMode ? 'bg-accent' : 'bg-line'}`}>
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-ink transition-all ${gaslessMode ? 'left-4' : 'left-0.5'}`} />
                      </span>
                    </button>
                  )}

                  {bidError && (
                    <p className="flex items-start gap-1.5 text-sm text-warn">
                      <Warning size={14} className="mt-0.5 shrink-0" />
                      {bidError}
                    </p>
                  )}
                </div>
              )}

              {/* Settle buttons (ended, not settled) */}
              {isEnded && (
                <div className="space-y-2 pt-1">
                  <button
                    onClick={handleSettleViaMemo}
                    className="w-full py-3.5 rounded-btn font-semibold bg-accent text-accent-ink hover:opacity-90 active:translate-y-px flex items-center justify-center gap-2"
                  >
                    <Gavel size={16} weight="bold" /> Settle + record memo
                  </button>
                  <button
                    onClick={() => void withGas('settle', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'settle', args: [lotId], chainId: CHAIN_ID }).then(settleTx).catch(onGasError)}
                    className="w-full py-2.5 rounded-btn text-sm font-medium border border-line text-ink-2 hover:border-ink-3 hover:text-ink active:translate-y-px transition-all flex items-center justify-center gap-2"
                  >
                    Settle (no memo)
                  </button>
                </div>
              )}
            </div>

            {/* Withdraw banner: outbid bids (and sale proceeds) wait here until claimed */}
            <AnimatePresence>
              {isOutbid && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="rounded-panel border border-accent/40 bg-accent/8 p-4 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      {isLive && !isWinner ? 'You were outbid.' : 'You have funds to withdraw.'}
                    </p>
                    <p className="font-mono tabular-nums font-bold text-xl text-ink">{fmtUsdc(claimableAmt)} ready to claim</p>
                    <p className="text-xs text-ink-3 mt-1">
                      Every bid you were outbid on comes back here, and sale proceeds too. This is your total across all auctions.
                    </p>
                  </div>
                  <button
                    onClick={() => void withGas('claim', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'claim', args: [], chainId: CHAIN_ID }).then(claimTx).catch(onGasError)}
                    disabled={claimLoading}
                    className="shrink-0 px-4 py-2.5 rounded-btn font-semibold text-sm bg-accent text-accent-ink hover:opacity-90 active:translate-y-px disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {claimLoading && <Spinner size={13} className="animate-spin" />}
                    Claim
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Post-settle: winner actions */}
            {isSettled && lot.highestBidder !== NULL_ADDR && (
              <div className="rounded-panel border border-line bg-surface p-5 space-y-3">
                {!lot.bondReleased && !lot.disputed && (
                  <>
                    <p className="text-sm font-semibold text-ink">Bond: {fmtUsdc(lot.bond)} held</p>
                    <p className="text-xs text-ink-3">
                      Releases when winner confirms delivery, or in {bondDays} day{bondDays !== 1 ? 's' : ''}.
                    </p>
                    {isWinner && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => void withGas('confirmDelivery', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'confirmDelivery', args: [lotId], chainId: CHAIN_ID }).then(confirmDeliveryTx).catch(onGasError)}
                          disabled={cdLoading}
                          className="flex-1 py-2.5 rounded-btn text-sm font-semibold bg-good text-bg hover:opacity-90 active:translate-y-px disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {cdLoading ? <Spinner size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                          Confirm delivery
                        </button>
                        <button
                          onClick={() => void withGas('dispute', { address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'dispute', args: [lotId], chainId: CHAIN_ID }).then(disputeTx).catch(onGasError)}
                          disabled={disputeLoading}
                          className="flex-1 py-2.5 rounded-btn text-sm font-semibold border border-warn text-warn hover:bg-warn/10 active:translate-y-px disabled:opacity-50 flex items-center justify-center gap-1.5"
                        >
                          {disputeLoading ? <Spinner size={13} className="animate-spin" /> : <ShieldWarning size={13} />}
                          Open dispute
                        </button>
                      </div>
                    )}
                  </>
                )}
                {lot.disputed && !lot.bondReleased && (
                  <p className="flex items-center gap-1.5 text-sm text-warn">
                    <ShieldWarning size={14} /> Dispute raised, awaiting resolution.
                  </p>
                )}
                {lot.bondReleased && (
                  <div className="space-y-2">
                    <p className="text-xs text-good flex items-center gap-1"><CheckCircle size={11} /> Bond released.</p>
                    <button
                      onClick={() => void withGas('recordSale', { address: REPUTATION_WRITER_ADDRESS, abi: REPUTATION_WRITER_ABI, functionName: 'recordSale', args: [lotId], chainId: CHAIN_ID }).then(recordSaleTx).catch(onGasError)}
                      disabled={recordSaleLoading}
                      className="w-full py-2.5 rounded-btn text-xs font-medium border border-line text-ink-2 hover:border-ink-3 hover:text-ink active:translate-y-px disabled:opacity-50 flex items-center justify-center gap-1"
                    >
                      {recordSaleLoading ? <Spinner size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                      Record to reputation registry
                    </button>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* ── Left column (7 cols) — SECOND on mobile ──────────────────── */}
        <div className="md:col-span-7 order-2 md:order-1 space-y-6">
          {/* Title + seller — desktop only; mobile version is above grid */}
          <div className="hidden md:block">
            <h1 className="text-3xl md:text-4xl font-semibold text-ink tracking-tight text-balance leading-tight">
              {title || `Lot #${id}`}
            </h1>
            <p className="text-sm text-ink-2 mt-2">
              Seller:{' '}
              <a href={addrUrl(lot.seller)} target="_blank" rel="noopener noreferrer"
                className="font-mono text-ink-2 hover:text-ink transition-colors">{shortAddr(lot.seller)}</a>
            </p>
          </div>

          {/* Lot image — real image from metadata, or composed placeholder */}
          <div className="aspect-[3/2] rounded-panel overflow-hidden bg-surface-2 flex items-center justify-center">
            {lotImage ? (
              <img
                src={lotImage}
                alt={title || `Lot #${id}`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 w-full h-full select-none">
                <Gavel size={48} weight="thin" className="text-ink-3" />
                <p className="text-ink-3 text-lg font-semibold text-center px-6 leading-snug">
                  {title || `Lot #${id}`}
                </p>
              </div>
            )}
          </div>

          {/* Bid history */}
          <div>
            <p className="text-sm font-semibold text-ink mb-3">Bid history</p>
            {bidLogs.length === 0
              ? <p className="text-sm text-ink-3 py-4 border-t border-line">No bids yet.</p>
              : <div className="border-t border-line">
                  {bidLogs.map((b, i) => (
                    <BidRow key={i} amount={b.amount} bidder={b.bidder} hash={b.hash} isGasless={b.isGasless} />
                  ))}
                </div>
            }
          </div>
        </div>

      </div>
    </div>
  )
}
