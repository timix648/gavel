/**
 * useTokenMeta — reads decimals(), symbol(), and optionally balanceOf() for an
 * ERC-20 token address. Results are cached module-level so repeated renders and
 * Lobby/Landing/AuctionRoom all share one set of RPC calls.
 *
 * Also exports:
 *  - fmtTokenAmount(raw, decimals, symbol) — formats a raw bigint as "17 EURC"
 *  - parseTokenAmount(str, decimals)        — parses "17" → BigInt(17_000_000) for 6-decimal token
 *  - fmtAssetLabel(kind, tokenId, amount, asset, decimals, symbol) — "17 EURC", "NFT #3", "5 × #0"
 *  - setTokenMetaCache / getTokenMetaCache  — shared cache for Lobby/Landing
 */
import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { parseUnits } from 'viem'
import { CHAIN_ID } from '../chain'
import { LotKind } from '../abi'

// ── Module-level cache (shared across components, never reset) ────────────────

interface TokenMeta { decimals: number; symbol: string }

const tokenMetaCache = new Map<string, TokenMeta>()

export function getTokenMetaCache(address: string): TokenMeta | undefined {
  return tokenMetaCache.get(address.toLowerCase())
}

export function setTokenMetaCache(address: string, decimals: number, symbol: string) {
  tokenMetaCache.set(address.toLowerCase(), { decimals, symbol })
}

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const DECIMALS_ABI = [{
  name: 'decimals', type: 'function',
  inputs: [], outputs: [{ name: '', type: 'uint8' }],
  stateMutability: 'view',
}] as const

const SYMBOL_ABI = [{
  name: 'symbol', type: 'function',
  inputs: [], outputs: [{ name: '', type: 'string' }],
  stateMutability: 'view',
}] as const

const BALANCE_ABI = [{
  name: 'balanceOf', type: 'function',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
}] as const

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseTokenMetaResult {
  decimals: number | undefined
  symbol:   string | undefined
  balance:  bigint | undefined
}

/**
 * Reads decimals and symbol for an ERC-20 address.
 * If `holder` is provided, also reads balanceOf(holder).
 * Pass `undefined` for the address to disable all reads.
 */
export function useTokenMeta(
  address: string | undefined,
  holder?: string  ,
): UseTokenMetaResult {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [decimals, setDecimals] = useState<number | undefined>(undefined)
  const [symbol,   setSymbol]   = useState<string | undefined>(undefined)
  const [balance,  setBalance]  = useState<bigint | undefined>(undefined)

  useEffect(() => {
    if (!address || !client) {
      setDecimals(undefined)
      setSymbol(undefined)
      setBalance(undefined)
      return
    }
    const key = address.toLowerCase()
    const cached = tokenMetaCache.get(key)
    if (cached) {
      setDecimals(cached.decimals)
      setSymbol(cached.symbol)
    } else {
      setDecimals(undefined)
      setSymbol(undefined)
    }
    // Always fetch balance if holder provided (can change)
    setBalance(undefined)

    let cancelled = false
    async function load() {
      if (!client) return
      try {
        let d: number
        let s: string
        if (cached) {
          d = cached.decimals
          s = cached.symbol
        } else {
          const [rawD, rawS] = await Promise.all([
            client.readContract({ address: address as `0x${string}`, abi: DECIMALS_ABI, functionName: 'decimals', args: [] }),
            client.readContract({ address: address as `0x${string}`, abi: SYMBOL_ABI,   functionName: 'symbol',   args: [] }),
          ])
          d = Number(rawD)
          s = rawS
          tokenMetaCache.set(key, { decimals: d, symbol: s })
        }
        if (!cancelled) { setDecimals(d); setSymbol(s) }
        if (holder && !cancelled) {
          const rawBal = await client.readContract({
            address: address as `0x${string}`,
            abi: BALANCE_ABI,
            functionName: 'balanceOf',
            args: [holder as `0x${string}`],
          })
          if (!cancelled) setBalance(rawBal)
        }
      } catch {
        // Silently fail — address may not be a valid ERC-20
      }
    }
    void load()
    return () => { cancelled = true }
  }, [address, holder, client])

  // Keep balance in sync when holder changes
  useEffect(() => {
    if (!address || !holder || !client) { setBalance(undefined); return }
    let cancelled = false
    async function fetchBal() {
      if (!client) return
      try {
        const rawBal = await client.readContract({
          address: address as `0x${string}`,
          abi: BALANCE_ABI,
          functionName: 'balanceOf',
          args: [holder as `0x${string}`],
        })
        if (!cancelled) setBalance(rawBal)
      } catch {}
    }
    void fetchBal()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holder])

  return { decimals, symbol, balance }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Format a raw bigint amount as "17 EURC" using the given decimals.
 * Falls back to the raw integer string if decimals is undefined.
 */
export function fmtTokenAmount(
  raw: bigint,
  decimals: number,
  symbol: string,
): string {
  const n = Number(raw) / 10 ** decimals
  const formatted = decimals === 0
    ? n.toFixed(0)
    : n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals })
  return `${formatted} ${symbol}`
}

/**
 * Parse a human-unit string ("17") into a raw bigint for a token with `decimals` decimal places.
 * Returns 0n on invalid input.
 */
export function parseTokenAmount(str: string, decimals: number): bigint {
  const trimmed = str.trim()
  if (!trimmed || isNaN(Number(trimmed)) || Number(trimmed) <= 0) return 0n
  try {
    return parseUnits(trimmed, decimals)
  } catch {
    return 0n
  }
}

/**
 * Build a human-readable asset label for a lot:
 *   ERC-721  → "NFT #3"
 *   ERC-1155 → "5 × #0"
 *   ERC-20   → "17 EURC" (or "<amount> tokens" if meta missing)
 *   OFFCHAIN → ""
 */
export function fmtAssetLabel(
  kind: LotKind | undefined,
  tokenId: bigint,
  lotAmount: bigint,
  _asset: string,
  decimals: number | undefined,
  symbol: string | undefined,
): string {
  if (kind === undefined || kind === LotKind.OFFCHAIN) return ''
  if (kind === LotKind.ERC721)  return `NFT #${tokenId.toString()}`
  if (kind === LotKind.ERC1155) return `${lotAmount.toString()} × #${tokenId.toString()}`
  // ERC-20
  if (decimals !== undefined && symbol) return fmtTokenAmount(lotAmount, decimals, symbol)
  if (lotAmount > 0n) return `${lotAmount.toString()} tokens`
  return ''
}
