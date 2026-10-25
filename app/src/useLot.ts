/**
 * useLot — read a single lot from the AuctionHouse public lots() getter.
 * Refreshes on every block.
 */
import { useReadContract } from 'wagmi'
import { keepPreviousData } from '@tanstack/react-query'
import { AUCTION_HOUSE_ADDRESS, CHAIN_ID } from './chain'
import { AUCTION_HOUSE_ABI, LotTuple } from './abi'
import { useLatestBlock } from './useBlock'

export function useLot(lotId: bigint | undefined) {
  const block = useLatestBlock()

  const result = useReadContract({
    address: AUCTION_HOUSE_ADDRESS,
    abi: AUCTION_HOUSE_ABI,
    functionName: 'lots',
    args: lotId !== undefined ? [lotId] : undefined,
    chainId: CHAIN_ID,
    // blockNumber forces a fresh read on each new block
    blockNumber: block?.blockNumber,
    query: { enabled: lotId !== undefined, placeholderData: keepPreviousData },
  })

  // Map tuple array to named struct
  const raw = result.data as [
    `0x${string}`, bigint, bigint, bigint, bigint,
    bigint, bigint, `0x${string}`, bigint, bigint,
    boolean, boolean, boolean, boolean
  ] | undefined

  const lot: LotTuple | undefined = raw ? {
    seller: raw[0],
    tokenId: raw[1],
    reserve: raw[2],
    minIncrement: raw[3],
    bond: raw[4],
    deadline: raw[5],
    highestBid: raw[6],
    highestBidder: raw[7],
    extensions: raw[8],
    settledAt: raw[9],
    settled: raw[10],
    cancelled: raw[11],
    bondReleased: raw[12],
    disputed: raw[13],
  } : undefined

  return { lot, isLoading: result.isLoading, refetch: result.refetch }
}
