import auctionHouseArtifact from '../contracts/out/AuctionHouse.sol/AuctionHouse.json'
import reputationWriterArtifact from '../contracts/out/ReputationWriter.sol/ReputationWriter.json'
import { erc20Abi, erc721Abi } from 'viem'

export const AUCTION_HOUSE_ABI = auctionHouseArtifact.abi
export const REPUTATION_WRITER_ABI = reputationWriterArtifact.abi
export const ERC20_ABI = erc20Abi
export const ERC721_ABI = erc721Abi

// Minimal ABI for ERC-8004 IdentityRegistry (register + ownerOf)
export const IDENTITY_REGISTRY_ABI = [
  { name: 'register',  type: 'function', inputs: [],                                         outputs: [{ name: 'agentId', type: 'uint256' }], stateMutability: 'nonpayable' },
  { name: 'ownerOf',  type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }],      outputs: [{ name: '', type: 'address' }],         stateMutability: 'view' },
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'owner', type: 'address' }],       outputs: [{ name: '', type: 'uint256' }],          stateMutability: 'view' },
] as const

// Minimal ERC-1155 ABI
export const ERC1155_ABI = [
  { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'balanceOf',         type: 'function', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }],     outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'isApprovedForAll',  type: 'function', inputs: [{ name: 'account', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'view' },
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

/** Lot struct as returned by AuctionHouse.lots(). Field order matches the Solidity struct. */
export type LotTuple = {
  seller: `0x${string}`
  tokenId: bigint       // GavelLot ERC-721 tokenId (OFFCHAIN) or ERC-721/ERC-1155 token id
  reserve: bigint
  minIncrement: bigint
  bond: bigint          // OFFCHAIN only; 0 for ERC721/ERC1155/ERC20
  deadline: bigint
  highestBid: bigint
  highestBidder: `0x${string}`
  extensions: bigint
  settledAt: bigint
  settled: boolean
  cancelled: boolean
  bondReleased: boolean // OFFCHAIN: bond released; non-OFFCHAIN: always true
  disputed: boolean     // OFFCHAIN only
}

/** Lot kind enum values matching AuctionHouse.Kind */
export enum LotKind { OFFCHAIN = 0, ERC721 = 1, ERC1155 = 2, ERC20 = 3 }

/** Escrow state enum values matching AuctionHouse.EscrowState */
export enum EscrowState { NONE = 0, HELD = 1, DISPUTED = 2, CLOSED = 3 }

export const LOT_KIND_LABEL: Record<LotKind, string> = {
  [LotKind.OFFCHAIN]: 'Off-chain',
  [LotKind.ERC721]:   'ERC-721',
  [LotKind.ERC1155]:  'ERC-1155',
  [LotKind.ERC20]:    'ERC-20',
}
