import auctionHouseArtifact from '../contracts/out/AuctionHouse.sol/AuctionHouse.json'
import reputationWriterArtifact from '../contracts/out/ReputationWriter.sol/ReputationWriter.json'
import { erc20Abi } from 'viem'

export const AUCTION_HOUSE_ABI = auctionHouseArtifact.abi
export const REPUTATION_WRITER_ABI = reputationWriterArtifact.abi
export const ERC20_ABI = erc20Abi

// Minimal ABI for ERC-8004 IdentityRegistry (register + ownerOf)
export const IDENTITY_REGISTRY_ABI = [
  { name: 'register',  type: 'function', inputs: [],                                         outputs: [{ name: 'agentId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'ownerOf',  type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }],      outputs: [{ name: '', type: 'address' }],         stateMutability: 'view' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'owner', type: 'address' }],       outputs: [{ name: '', type: 'uint256' }],          stateMutability: 'view' },
] as const

// Minimal Memo ABI (EOA-only; emit a Memo event alongside settle)
export const MEMO_ABI = [
  {
    name: 'memo',
    type: 'function',
    inputs: [
      { name: 'target',   type: 'address' },
      { name: 'data',     type: 'bytes'   },
      { name: 'memoId',   type: 'bytes32' },
      { name: 'memoData', type: 'bytes'   },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

export type LotTuple = {
  seller: `0x${string}`
  tokenId: bigint
  reserve: bigint
  minIncrement: bigint
  bond: bigint
  deadline: bigint
  highestBid: bigint
  highestBidder: `0x${string}`
  extensions: bigint
  settledAt: bigint
  settled: boolean
  cancelled: boolean
  bondReleased: boolean
  disputed: boolean
}
