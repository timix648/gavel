/**
 * Gas for every transaction the app sends, computed live from the chain.
 *
 * Some wallets (seen with OKX on Arc testnet) cannot estimate fees on Arc and then
 * disable Confirm ("Network fee: --"). So the app estimates itself, just before
 * sending, and hands the wallet a complete request:
 *   - gas limit: eth_estimateGas for this exact call, +30% margin
 *   - fees: the network's EIP-1559 estimate (viem estimateFeesPerGas: latest
 *     baseFeePerGas + eth_maxPriorityFeePerGas), never below Arc's 20 gwei floor
 *     (transactions under the floor are dropped silently)
 * If the call would revert, estimation throws with the revert reason and nothing is
 * sent, so the user sees why before signing. FALLBACK_GAS is used only when the RPC
 * itself cannot answer (rate limit / network), never instead of a revert.
 */
import { useCallback } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import type { Abi, Address } from 'viem'
import { CHAIN_ID } from './chain'

const GWEI = 1_000_000_000n
const ARC_MIN_FEE = 20n * GWEI

/** Last resort only, ~1.6-2x gasUsed measured on Arc testnet (24 Oct 2026). */
const FALLBACK_GAS = {
  approve:          80_000n,
  bid:             250_000n,
  list:            650_000n,
  settle:          250_000n,
  settleViaMemo:   320_000n,
  claim:           120_000n,
  confirmDelivery: 100_000n,
  dispute:         120_000n,
  resolveDispute:  120_000n,
  resolveDisputeTimeout: 120_000n,
  recordSale:      200_000n,
  register:        300_000n,
  linkSeller:      150_000n,
  // v7
  'approve-erc721':   80_000n,
  'approve-erc1155':  80_000n,
  'approve-asset':    80_000n,
  claimLotAsset:    200_000n,
  releaseEscrow:    120_000n,
  refundBuyer:      120_000n,
  // v8
  submitEvidence:   100_000n,
} as const
export type TxKind = keyof typeof FALLBACK_GAS

interface ContractCall {
  address: Address
  abi: Abi | readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}

function isRpcUnavailable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase()
  return /429|rate limit|-32005|fetch failed|network|timeout|http request failed/.test(msg)
    && !/revert/.test(msg)
}

/** Returns withGas(kind, call): the call plus live gas limit and fees. */
export function useWithGas() {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const { address: account } = useAccount()

  return useCallback(async <const T extends ContractCall>(
    kind: TxKind, call: T,
  ): Promise<T & { gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> => {
    if (!client) return call

    let gas: bigint
    try {
      const est = await client.estimateContractGas({ ...(call as ContractCall), account })
      gas = (est * 13n) / 10n
    } catch (err) {
      if (!isRpcUnavailable(err)) throw err // a real revert: surface it, send nothing
      gas = FALLBACK_GAS[kind]
    }

    // Standard EIP-1559 fee estimate from the network (viem: latest block baseFeePerGas
    // + eth_maxPriorityFeePerGas, with viem's default base-fee headroom).
    let maxFeePerGas = 2n * ARC_MIN_FEE
    let maxPriorityFeePerGas = 1n * GWEI
    try {
      const fees = await client.estimateFeesPerGas()
      maxFeePerGas = fees.maxFeePerGas
      maxPriorityFeePerGas = fees.maxPriorityFeePerGas
    } catch {
      // RPC unavailable: keep the safe defaults above (2x the Arc floor)
    }
    // Arc drops transactions below its 20 gwei floor, so never go under it.
    if (maxFeePerGas < ARC_MIN_FEE + maxPriorityFeePerGas) maxFeePerGas = ARC_MIN_FEE + maxPriorityFeePerGas

    return { ...call, gas, maxFeePerGas, maxPriorityFeePerGas }
  }, [client, account])
}
