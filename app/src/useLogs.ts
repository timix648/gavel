/**
 * useLogs — React hooks over the shared logStore.
 *
 * All log fetching goes through logStore.ts (one address-only getLogs per
 * 100 000-block chunk with rate-limit backoff + range-size halving).
 * Filtering by lotId is done locally — no extra RPC calls per component.
 */
import { useState, useEffect, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { CHAIN_ID } from './chain'
import {
  scanLogs, subscribe, getLogs, getHighWater, getError, getPausedUntil, isScanning,
  type DecodedLog,
} from './logStore'

// Re-export DecodedLog as AnyLog for backward compat with Proof.tsx / AuctionRoom.
export type AnyLog = DecodedLog
export type { DecodedLog }

// ── useLogStore ───────────────────────────────────────────────────────────────
/**
 * Triggers the shared scan and re-renders subscribers when new logs arrive.
 * Returns the full decoded log list plus scan metadata.
 */
export function useLogStore() {
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [logs, setLogs]           = useState<DecodedLog[]>(getLogs)
  const [highWater, setHW]        = useState<bigint>(getHighWater)
  const [scanning, setScanning]   = useState(isScanning)
  const [progress, setProgress]   = useState<{ current: bigint; head: bigint } | undefined>()
  const [error, setError]         = useState<string | null>(getError)
  const [pausedUntil, setPausedUntil] = useState<number>(getPausedUntil)
  // Prevent launching two scans from different component instances simultaneously.
  const launchedRef = useRef(false)

  useEffect(() => {
    if (!client || launchedRef.current) return
    launchedRef.current = true

    const unsub = subscribe((_, hw) => {
      setLogs([...getLogs()])
      setHW(hw)
      setScanning(isScanning())
      setError(getError())
      setPausedUntil(getPausedUntil())
    })

    // Fire initial scan (no-ops if already scanning or highWater === head).
    setScanning(true)
    void scanLogs(client, (cur, head) => {
      setProgress({ current: cur, head })
      setError(getError())
      setPausedUntil(getPausedUntil())
    }).then(() => {
      setLogs([...getLogs()])
      setHW(getHighWater())
      setScanning(false)
      setError(getError())
      setPausedUntil(0)
    })

    return unsub
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  return { logs, highWater, scanning, progress, error, pausedUntil }
}

// ── useBlockWatcher ───────────────────────────────────────────────────────────
/**
 * Re-triggers the scan on each new block so incremental updates arrive.
 * Lightweight — scanLogs no-ops if already scanning or highWater === head.
 */
export function useBlockWatcher() {
  const client = usePublicClient({ chainId: CHAIN_ID })
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (!client) return
    const unsub = client.watchBlockNumber({
      onBlockNumber: () => {
        void scanLogs(client)
      },
    })
    return unsub
  }, [client])
}

// ── useEventLogs (lotId-filtered) ─────────────────────────────────────────────
/**
 * Returns logs for a specific event name, optionally filtered by lotId.
 * Does NOT trigger its own scan — relies on useLogStore being mounted
 * somewhere in the tree (Proof or App root).
 */
export interface UseLogsResult {
  logs: AnyLog[]
  loading: boolean
  progress: { current: bigint; head: bigint } | undefined
}

export function useEventLogs(eventName: string, lotId?: bigint): UseLogsResult {
  const { logs: allLogs, scanning, progress } = useLogStore()

  const filtered = allLogs.filter(l => {
    if (l.name !== eventName) return false
    if (lotId !== undefined) {
      const id = l.args.lotId
      if (typeof id === 'bigint') return id === lotId
      if (typeof id === 'string' || typeof id === 'number') return BigInt(id) === lotId
      return false
    }
    return true
  })

  return { logs: filtered, loading: scanning, progress }
}

export function useListedLogs()           { return useEventLogs('Listed') }
export function useBidLogs(lotId: bigint) { return useEventLogs('Bid', lotId) }
