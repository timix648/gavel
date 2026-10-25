// End-to-end smoke test against the running local relayer + keeper on Arc testnet.
// Test tooling only (not part of the app). Keys come from --env-file, never printed.
//   bun --env-file=../local-services/.env.testnet e2e-local.ts
import {
  createPublicClient, createWalletClient, http, parseAbi, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, encodeFunctionData, type Hex, type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC = 'https://rpc.testnet.arc.io'
const CHAIN_ID = 5042002
const AH = '0x4ca018cd8d40159183d32c35b2072e90ef3903a6' as Address
const USDC = '0x3600000000000000000000000000000000000000' as Address
const RELAYER_URL = 'http://localhost:3001/bid'
const chain = {
  id: CHAIN_ID, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const

const AH_ABI = parseAbi([
  'function lots(uint256) view returns (address seller, uint256 tokenId, uint256 reserve, uint256 minIncrement, uint256 bond, uint256 deadline, uint256 highestBid, address highestBidder, uint256 extensions, uint256 settledAt, bool settled, bool cancelled, bool bondReleased, bool disputed)',
  'function nextLotId() view returns (uint256)',
  'function bid(uint256 lotId, uint256 amount)',
  'function settle(uint256 lotId)',
  'function claim()',
  'function claimable(address) view returns (uint256)',
  'function confirmDelivery(uint256 lotId)',
])
const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 6, retryDelay: 1500 }) })
const A = privateKeyToAccount(process.env.BIDDER_A_PRIVATE_KEY as Hex)
const B = privateKeyToAccount(process.env.BIDDER_B_PRIVATE_KEY as Hex)
const RELAYER = process.env.RELAYER_ADDRESS as Address
const wallet = (acct: typeof A) => createWalletClient({ account: acct, chain, transport: http(RPC, { retryCount: 6, retryDelay: 2000 }) })
const fee = { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 0n } // Arc drops txs below 20 gwei

const rows: { step: string; hash: string; from: string }[] = []
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(2)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const now = async () => (await pub.getBlock()).timestamp

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(acct: typeof A, step: string, to: Address, abi: readonly unknown[], fn: string, args: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await wallet(acct).writeContract({ address: to, abi, functionName: fn, args, ...fee } as any)
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${step} reverted: ${hash}`)
  rows.push({ step, hash, from: r.from })
  console.log(`  ok  ${step.padEnd(34)} ${hash}`)
  return r
}
const lot = async (id: bigint) => {
  const l = await pub.readContract({ address: AH, abi: AH_ABI, functionName: 'lots', args: [id] })
  return { seller: l[0], reserve: l[2], step: l[3], deadline: l[5], high: l[6], leader: l[7], ext: l[8], settled: l[10], bondReleased: l[12] }
}
const next = (l: Awaited<ReturnType<typeof lot>>) => (l.high === 0n ? l.reserve : l.high + l.step)

// 1. Find a live house lot with at least 70 s left (the keeper relists every 120 s).
console.log('1. waiting for a fresh house lot')
let id = -1n
for (let tries = 0; tries < 40 && id < 0n; tries++) {
  const n = await pub.readContract({ address: AH, abi: AH_ABI, functionName: 'nextLotId' })
  const t = await now()
  for (let i = n - 1n; i >= 0n && i >= n - 3n; i--) {
    const l = await lot(i)
    if (!l.settled && l.deadline > t + 70n && l.high === 0n) { id = i; break }
  }
  if (id < 0n) await sleep(5000)
}
if (id < 0n) throw new Error('no fresh live lot found - is the keeper running?')
console.log(`   using lot #${id}`)

// 2. Bidder A: approve once, bid the reserve with gas.
console.log('2. bidder A bids with gas')
for (const acct of [A]) {
  const al = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [acct.address, AH] })
  if (al < 5_000_000n) await send(acct, `approve (${acct.address.slice(0, 8)})`, USDC, ERC20, 'approve', [AH, 50_000_000n])
}
let L = await lot(id)
await send(A, `A bids ${usd(next(L))} (gas)`, AH, AH_ABI, 'bid', [id, next(L)])

// 3. Bidder B: ONE signature, relayed. B never sends a transaction.
console.log('3. bidder B bids gasless through the local relayer')
L = await lot(id)
const amount = next(L)
const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 120)
const nonce = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256, uint256, uint256, bytes32'),
  [AH, BigInt(CHAIN_ID), id, amount, salt]))
const sig = await B.signTypedData({
  domain: { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC },
  types: { ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] },
  primaryType: 'ReceiveWithAuthorization',
  message: { from: B.address, to: AH, value: amount, validAfter: 0n, validBefore, nonce },
})
const bNonceBefore = await pub.getTransactionCount({ address: B.address })
const resp = await fetch(RELAYER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  lotId: Number(id), amount: amount.toString(), from: B.address, validAfter: '0', validBefore: validBefore.toString(), salt,
  sig: { v: parseInt(sig.slice(130, 132), 16), r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}` },
}) })
const data = await resp.json() as { txHash?: Hex; error?: string }
if (!resp.ok || !data.txHash) throw new Error(`relayer: ${data.error ?? resp.status}`)
const rr = await pub.waitForTransactionReceipt({ hash: data.txHash })
rows.push({ step: `B bids ${usd(amount)} (gasless)`, hash: data.txHash, from: rr.from })
console.log(`  ok  ${('B bids ' + usd(amount) + ' (gasless)').padEnd(34)} ${data.txHash}`)
console.log(`      tx.from=${rr.from}  relayer=${RELAYER}  match=${rr.from.toLowerCase() === RELAYER.toLowerCase()}`)
console.log(`      B sent ${(await pub.getTransactionCount({ address: B.address })) - bNonceBefore} transactions itself (want 0)`)

// 4. Bidder A bids again inside the final 10 s -> Extended.
console.log('4. bidder A waits for the final 10 seconds')
L = await lot(id)
// Pre-build and sign the tx before the window opens, so only broadcast latency remains
// (on a slow connection the RPC round-trips alone took over 7 s in the first run).
const lateAmount = next(L)
const lateReq = await wallet(A).prepareTransactionRequest({
  to: AH, data: encodeFunctionData({ abi: AH_ABI, functionName: 'bid', args: [id, lateAmount] }),
  gas: 300_000n, ...fee,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lateRaw = await wallet(A).signTransaction(lateReq as any)
// Use CHAIN time: this PC's clock was measured 11 s behind Arc, which made run 2 late.
const b0 = await pub.getBlock()
const skew = Number(b0.timestamp) - Date.now() / 1000
const chainNow = () => Date.now() / 1000 + skew
console.log(`      clock skew vs chain: ${skew.toFixed(1)} s`)
while (chainNow() < Number(L.deadline) - 8) await sleep(200)
const before = L.deadline
const lateHash = await pub.sendRawTransaction({ serializedTransaction: lateRaw })
const lateR = await pub.waitForTransactionReceipt({ hash: lateHash })
if (lateR.status !== 'success') throw new Error(`late bid reverted: ${lateHash}`)
rows.push({ step: `A bids ${usd(lateAmount)} in last 10 s`, hash: lateHash, from: lateR.from })
console.log(`  ok  ${('A bids ' + usd(lateAmount) + ' in last 10 s').padEnd(34)} ${lateHash}`)
L = await lot(id)
console.log(`      deadline ${before} -> ${L.deadline}, extensions=${L.ext}`)

// 5. After the deadline: settle (or let the keeper do it), B claims, A confirms delivery.
console.log('5. hammer, claim, confirm delivery')
while ((await now()) <= L.deadline) await sleep(1500)
await sleep(3000)
L = await lot(id)
if (!L.settled) await send(A, 'settle', AH, AH_ABI, 'settle', [id])
else console.log('      keeper already settled the lot')
const bClaim = await pub.readContract({ address: AH, abi: AH_ABI, functionName: 'claimable', args: [B.address] })
if (bClaim > 0n) await send(B, `B claims ${usd(bClaim)} refund`, AH, AH_ABI, 'claim', [])
L = await lot(id)
if (L.leader.toLowerCase() === A.address.toLowerCase()) await send(A, 'A confirms delivery', AH, AH_ABI, 'confirmDelivery', [id])

L = await lot(id)
console.log('\nFinal lot state:', { lot: Number(id), leader: L.leader, winningBid: usd(L.high), extensions: Number(L.ext), settled: L.settled, bondReleased: L.bondReleased })
console.log('Relayer stats:', await (await fetch('http://localhost:3001/stats')).json())
console.log('\n| Step | From | Tx |\n|---|---|---|')
for (const r of rows) console.log(`| ${r.step} | ${r.from} | ${r.hash} |`)
