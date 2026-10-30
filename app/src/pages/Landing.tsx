/**
 * Landing page — /
 * Spec: DESIGN.md section 8. Real chain data only; no div-built fake screenshots.
 * Sections: Hero, Live Numbers, Why Arc, How a Lot Moves, No Gas Needed, Built in the Open, Final CTA, Footer.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { setNavDirection } from '../App'
import { usePublicClient } from 'wagmi'
import { motion } from 'framer-motion'
import {
  Lightning, ArrowRight, ArrowSquareOut,
  ArrowCircleRight,
} from '@phosphor-icons/react'
import {
  AUCTION_HOUSE_ADDRESS, CHAIN_ID,
  GITHUB_URL, NETWORK_LABEL,
} from '../chain'
import type { Abi } from 'viem'
import { AUCTION_HOUSE_ABI, type LotTuple } from '../abi'
import { useLatestBlock } from '../useBlock'
import { useLogStore } from '../useLogs'
import { BezelPanel, BezelPlaceholder } from '../components/AuctionPanel'
import LiveStatsStrip from '../components/LiveStatsStrip'
import { fmtUsdc, shortAddr } from '../utils'
import { fmtAssetLabel, setTokenMetaCache, getTokenMetaCache } from '../hooks/useTokenMeta'
import { LotKind } from '../abi'
import { StudioWatermark } from '../main'

const AH_ABI_TYPED = AUCTION_HOUSE_ABI as Abi

// ── Countdown hook (same pattern as AuctionRoom) ─────────────────────────────
function useCountdown(deadlineSec: number) {
  const block = useLatestBlock()
  const [secs, setSecs] = useState(0)
  const [extended, setExtended] = useState(false)
  const prevDL = useRef(deadlineSec)
  useEffect(() => {
    if (deadlineSec > prevDL.current) { setExtended(true); setTimeout(() => setExtended(false), 1500) }
    prevDL.current = deadlineSec
  }, [deadlineSec])
  useEffect(() => {
    if (!block) return
    const base = Number(block.blockTimestamp)
    const cap = Date.now() / 1000
    const t = setInterval(() => setSecs(Math.max(0, deadlineSec - (base + (Date.now() / 1000 - cap)))), 50)
    return () => clearInterval(t)
  }, [block, deadlineSec])
  return { secs, extended }
}

// ── FadeUp wrapper (motion, disabled under prefers-reduced-motion) ────────────
function FadeUp({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, delay, ease: [0.32, 0.72, 0, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

// ── Count-up hook ─────────────────────────────────────────────────────────────
// decimals: number of decimal places to maintain in the count-up value
function useCountUp(target: number, duration = 1200, decimals = 0) {
  const [val, setVal] = useState(0)
  const visible   = useRef(false)
  const raf       = useRef<number | null>(null)
  const ref       = useRef<HTMLDivElement>(null)
  // The latest target, so an animation started by the observer never uses a stale value.
  const targetRef = useRef(target)
  const shownRef  = useRef(0)
  // eslint-disable-next-line react/refs
  targetRef.current = target

  const animateTo = useCallback((to: number) => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    const from  = shownRef.current
    const start = Date.now()
    const mult  = Math.pow(10, decimals)
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / duration)
      const v = Math.round((from + p * (to - from)) * mult) / mult
      shownRef.current = v
      setVal(v)
      raf.current = p < 1 ? requestAnimationFrame(tick) : null
    }
    raf.current = requestAnimationFrame(tick)
  }, [duration, decimals])

  // Data that arrives after the stats are on screen animates from the shown value.
  useEffect(() => {
    if (visible.current) animateTo(target)
  }, [target, animateTo])

  // First time the stats come into view (including already in view on mount),
  // count up to whatever the latest target is.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || visible.current) return
      visible.current = true
      obs.disconnect()
      animateTo(targetRef.current)
    }, { threshold: 0.3 })
    obs.observe(el)
    return () => { obs.disconnect(); if (raf.current !== null) cancelAnimationFrame(raf.current) }
  }, [animateTo])

  return { val, ref }
}

// ── Section 3: Block-timeline race (spec 8.3.3b, Turn 17 keyframes) ──────────
//
// Story window: T-20 to T+9 = 29 story-seconds.
// p in [0,1]:  t = p * 29 - 20  (t is story-time in seconds, 0 = original close)
// toPct(t)  = (t + 20) / 29 * 100   (0% = T-20, ~69% = T=0, 100% = T+9)
//
// Keyframes (story-time → event):
//   T-20  p=0            both clocks 0:20, first tile in both lanes
//   T-10  p=10/29≈0.345  beat 1 "Ten seconds left."
//   T-4   p=16/29≈0.552  beat 2 "A bid is sent at 0:04." — dot leaves both lanes
//   T-3.5 p=16.5/29≈0.569 Arc bid accepted. deadline = T+6.5.
//                         Arc close line → toPct(6.5). Clock jumps 0:03→0:10. Warn flash.
//   T=0   p=20/29≈0.690  12-s close line flashes. Dot crosses it → "pending".
//   T+4   p=24/29≈0.828  12-s second tile appears. Dot drops in (ink-3). "Missed."
//   T+6.5 p=26.5/29≈0.914 Arc clock → 0:00. "Sold to the late bidder."
//   T+9   p=1.0           end of story → 2.5 s hold → loop
//
// Wall-time: 10 s story + 2.5 s hold.
const STORY_SECS = 29       // story window in story-seconds
const WALL_MS    = 10000    // wall-ms to play through full story
const HOLD_MS    = 2500     // hold final frame before loop

// p ↔ t helpers
function storyT(p: number)       { return p * STORY_SECS - 20 }
function toPct(storySec: number)  { return ((storySec + 20) / STORY_SECS) * 100 }

// Compact mono countdown display: shows "0:XX" style
function MiniClock({ secsLeft, flash = false }: { secsLeft: number; flash?: boolean }) {
  const m = Math.floor(secsLeft / 60)
  const s = Math.floor(secsLeft % 60)
  return (
    <span
      className={[
        'font-mono tabular-nums text-sm font-semibold transition-colors duration-150',
        flash ? 'text-warn' : secsLeft <= 10 && secsLeft > 0 ? 'text-accent-text' : 'text-ink-2',
      ].join(' ')}
    >
      {m}:{String(s).padStart(2, '0')}
    </span>
  )
}

// ── Pre-computed constants used every frame (outside component) ───────────────
const BID_SENT_P     = 16 / STORY_SECS        // p at T-4
const BID_ARRIVE_P   = 16.5 / STORY_SECS      // p at T-3.5 (Arc bid lands)
const SLOW_ARRIVE_P  = 24 / STORY_SECS        // p at T+4   (12-s block)
const SLOW_TILE_STEPS = [-20, -8, 4] as const
const ARC_TILE_STEPS: number[] = []
for (let ts = -20; ts <= 9; ts += 0.5) ARC_TILE_STEPS.push(ts)
const ARC_TILE_STEPS_LEN = ARC_TILE_STEPS.length

// Discrete state thresholds — React only re-renders when one of these crosses.
const FLAG_SLOW_ARRIVED   = 2
const FLAG_ARC_ARRIVED    = 8
const FLAG_SLOW_CLOSED    = 16
const FLAG_SLOW_MISSED    = 32
const FLAG_ARC_ACCEPTED   = 64
const FLAG_ARC_SOLD       = 128
const FLAG_BEAT1          = 256
const FLAG_BEAT2          = 512
const FLAG_SLOW_FLASH     = 1024
const FLAG_ARC_FLASH      = 2048
const FLAG_PLAYING        = 4096

function flagsFromP(p: number, slowFlash: boolean, arcFlash: boolean, playing: boolean): number {
  const t = storyT(p)
  let f = 0
  if (p >= SLOW_ARRIVE_P) f |= FLAG_SLOW_ARRIVED
  if (p >= BID_ARRIVE_P)  f |= FLAG_ARC_ARRIVED
  if (t >= 0)    f |= FLAG_SLOW_CLOSED
  if (t >= 4)    f |= FLAG_SLOW_MISSED
  if (t >= -3.5) f |= FLAG_ARC_ACCEPTED
  if (t >= 6.5)  f |= FLAG_ARC_SOLD
  if (t >= -10 && t < -4) f |= FLAG_BEAT1
  if (t >= -4)   f |= FLAG_BEAT2
  if (slowFlash) f |= FLAG_SLOW_FLASH
  if (arcFlash)  f |= FLAG_ARC_FLASH
  if (playing)   f |= FLAG_PLAYING
  return f
}

function BlockComparison() {
  const prefersReduced = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ── React state: only discrete flags and clock seconds ───────────────────
  const [flags, setFlags]     = useState(() => prefersReduced ? flagsFromP(1, false, false, false) : 0)
  const [slowSec, setSlowSec] = useState(prefersReduced ? 0 : 20)
  const [arcSec,  setArcSec]  = useState(prefersReduced ? 0 : 20)

  // ── Mutable animation state (refs, never cause re-renders) ───────────────
  const pRef           = useRef(prefersReduced ? 1 : 0)
  const startRef       = useRef(0)
  const pausedAtRef    = useRef(0)
  const rafRef         = useRef<number | null>(null)
  const holdTimer      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loopTimer      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const arcFlashT      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const slowFlashT     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const arcFlashRef    = useRef(false)
  const slowFlashRef   = useRef(false)
  const arcFlashFired  = useRef(false)
  const slowFlashFired = useRef(false)
  const inViewRef      = useRef(false)
  const sectionRef     = useRef<HTMLDivElement>(null)
  const mountedRef     = useRef(true)
  // Arc dot pop spring: track last-fired p so we don't re-trigger
  const arcPopFired    = useRef(false)

  // ── DOM refs for imperative updates ──────────────────────────────────────
  const slowDotRef      = useRef<HTMLDivElement>(null)
  const arcDotRef       = useRef<HTMLDivElement>(null)
  const slowPulseRef    = useRef<HTMLDivElement>(null)  // pulsing ring on slow dot
  const arcInBlockRef   = useRef<HTMLSpanElement>(null) // "in block" tag
  const slowMissedRef   = useRef<HTMLSpanElement>(null) // "missed" tag
  const arcCloseRef     = useRef<HTMLDivElement>(null)
  const arcTileRefs     = useRef<(HTMLDivElement | null)[]>([])
  const slow12CloseRef  = useRef<HTMLDivElement>(null)
  // Two playhead line refs — one per lane, both written to the same left % each frame
  const slowPlayheadRef = useRef<HTMLDivElement>(null)
  const arcPlayheadRef  = useRef<HTMLDivElement>(null)
  const slowTileRefs    = useRef<(HTMLDivElement | null)[]>([])

  // ── Imperative frame writer — called every RAF tick ───────────────────────
  // p in [0,1]; slowFlash = whether 12-s close line is currently flashing orange
  const writeFrame = useCallback((p: number, slowFlash: boolean) => {
    const t = storyT(p)

    // ── Playhead: sweeps left→right as p goes 0→1 ─────────────────────────
    // The "now" line is always visible once p > 0; hidden at p == 0.
    const phPct = `${toPct(t)}%`
    if (slowPlayheadRef.current) {
      slowPlayheadRef.current.style.left    = phPct
      slowPlayheadRef.current.style.opacity = p > 0 ? '1' : '0'
    }
    if (arcPlayheadRef.current) {
      arcPlayheadRef.current.style.left    = phPct
      arcPlayheadRef.current.style.opacity = p > 0 ? '1' : '0'
    }

    // ── Dots: appear at BID_SENT_P, ride playhead until they land ─────────
    if (p >= BID_SENT_P) {
      // Slow dot: rides playhead until it lands in the 12-s block at T+4
      const slowArrived = p >= SLOW_ARRIVE_P
      const slowX = slowArrived ? toPct(4) : toPct(t)  // ride playhead while pending
      if (slowDotRef.current) {
        slowDotRef.current.style.left    = `${slowX}%`
        slowDotRef.current.style.display = 'block'
        slowDotRef.current.style.backgroundColor = slowArrived
          ? 'rgb(var(--ink-3) / 0.5)' : 'rgb(var(--accent))'
        slowDotRef.current.style.borderColor = slowArrived
          ? 'rgb(var(--ink-3) / 0.3)' : 'rgb(var(--accent) / 0.5)'
      }
      // Pulse ring: visible while dot is pending AND past close line
      if (slowPulseRef.current) {
        const showPulse = !slowArrived && t >= 0
        slowPulseRef.current.style.left    = `${slowX}%`
        slowPulseRef.current.style.display = showPulse ? 'block' : 'none'
      }
      // "missed" tag
      if (slowMissedRef.current) {
        slowMissedRef.current.style.display = slowArrived ? 'block' : 'none'
        if (slowArrived) slowMissedRef.current.style.left = `${toPct(4) + 1}%`
      }

      // Arc dot: rides playhead until it lands in its block at T-3.5
      const arcArrived = p >= BID_ARRIVE_P
      const arcX = arcArrived ? toPct(-3.5) : toPct(t)
      if (arcDotRef.current) {
        arcDotRef.current.style.left    = `${arcX}%`
        arcDotRef.current.style.display = 'block'
        arcDotRef.current.style.backgroundColor = arcArrived
          ? 'rgb(var(--good))' : 'rgb(var(--accent))'
        arcDotRef.current.style.borderColor = arcArrived
          ? 'rgb(var(--good) / 0.4)' : 'rgb(var(--accent) / 0.5)'
      }
      // "in block" tag
      if (arcInBlockRef.current) {
        arcInBlockRef.current.style.display = arcArrived ? 'block' : 'none'
        if (arcArrived) arcInBlockRef.current.style.left = `${toPct(-3.5) + 1}%`
      }
    } else {
      if (slowDotRef.current)   slowDotRef.current.style.display   = 'none'
      if (arcDotRef.current)    arcDotRef.current.style.display    = 'none'
      if (slowPulseRef.current) slowPulseRef.current.style.display = 'none'
      if (arcInBlockRef.current) arcInBlockRef.current.style.display = 'none'
      if (slowMissedRef.current) slowMissedRef.current.style.display = 'none'
    }

    // ── Arc close line ────────────────────────────────────────────────────
    if (arcCloseRef.current) {
      const arcClosePct = t >= -3.5 ? toPct(6.5) : toPct(0)
      arcCloseRef.current.style.left       = `${arcClosePct}%`
      arcCloseRef.current.style.transition = p > 0 ? 'left 0.3s' : 'none'
    }

    // ── 12-s close line flash ─────────────────────────────────────────────
    if (slow12CloseRef.current) {
      slow12CloseRef.current.style.backgroundColor = slowFlash
        ? 'rgb(var(--warn))' : 'rgb(var(--ink-3) / 0.6)'
    }

    // ── Slow block tiles: fade + scaleX in over 150 ms ────────────────────
    for (let i = 0; i < SLOW_TILE_STEPS.length; i++) {
      const el = slowTileRefs.current[i]
      if (!el) continue
      const revealed = t >= SLOW_TILE_STEPS[i]
      el.style.opacity   = revealed ? '1' : '0'
      el.style.transform = revealed ? 'scaleX(1)' : 'scaleX(0)'
    }

    // ── Arc tile opacity: fade in over 150 ms as t advances ───────────────
    for (let i = 0; i < ARC_TILE_STEPS_LEN; i++) {
      const el = arcTileRefs.current[i]
      if (el) el.style.opacity = t >= ARC_TILE_STEPS[i] ? '1' : '0'
    }
  }, [])

  // ── Clear all timers ──────────────────────────────────────────────────────
  const clearAllTimers = useCallback(() => {
    if (rafRef.current != null)  { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (holdTimer.current)       { clearTimeout(holdTimer.current);      holdTimer.current = null }
    if (loopTimer.current)       { clearTimeout(loopTimer.current);      loopTimer.current = null }
    if (arcFlashT.current)       { clearTimeout(arcFlashT.current);      arcFlashT.current = null }
    if (slowFlashT.current)      { clearTimeout(slowFlashT.current);     slowFlashT.current = null }
  }, [])

  // ── Push React state on discrete threshold crossings ─────────────────────
  const pushDiscreteState = useCallback((p: number, slowFlash: boolean, arcFlash: boolean, playing: boolean) => {
    const t = storyT(p)
    const newFlags = flagsFromP(p, slowFlash, arcFlash, playing)
    setFlags(prev => prev !== newFlags ? newFlags : prev)
    const newSlowSec = Math.ceil(Math.max(0, -t))
    setSlowSec(prev => prev !== newSlowSec ? newSlowSec : prev)
    const newArcSec = Math.ceil(t < -3.5 ? Math.max(0, -t) : Math.max(0, 6.5 - t))
    setArcSec(prev => prev !== newArcSec ? newArcSec : prev)
  }, [])

  // ── Main animation loop ───────────────────────────────────────────────────
  const startFrom = useCallback((elapsed: number) => {
    if (prefersReduced || !mountedRef.current) return
    clearAllTimers()
    arcFlashFired.current  = false
    slowFlashFired.current = false
    arcFlashRef.current    = false
    slowFlashRef.current   = false
    arcPopFired.current    = false
    startRef.current = performance.now() - elapsed
    pushDiscreteState(pRef.current, false, false, true)

    const tick = (now: number) => {
      if (!mountedRef.current) return
      const newP = Math.min(1, (now - startRef.current) / WALL_MS)
      pRef.current = newP

      // Arc flash + dot pop at BID_ARRIVE_P
      if (!arcFlashFired.current && newP >= BID_ARRIVE_P) {
        arcFlashFired.current = true
        arcFlashRef.current   = true
        arcPopFired.current   = false  // allow pop spring to fire via React
        arcFlashT.current = setTimeout(() => {
          if (!mountedRef.current) return
          arcFlashRef.current = false
          pushDiscreteState(pRef.current, slowFlashRef.current, false, true)
        }, 700)
      }
      // 12-s close flash at T=0
      if (!slowFlashFired.current && storyT(newP) >= 0) {
        slowFlashFired.current = true
        slowFlashRef.current   = true
        slowFlashT.current = setTimeout(() => {
          if (!mountedRef.current) return
          slowFlashRef.current = false
          pushDiscreteState(pRef.current, false, arcFlashRef.current, true)
        }, 500)
      }

      writeFrame(newP, slowFlashRef.current)
      pushDiscreteState(newP, slowFlashRef.current, arcFlashRef.current, true)

      if (newP < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        pushDiscreteState(1, slowFlashRef.current, arcFlashRef.current, false)
        holdTimer.current = setTimeout(() => {
          if (!mountedRef.current || !inViewRef.current) return
          pRef.current = 0
          arcFlashRef.current  = false
          slowFlashRef.current = false
          writeFrame(0, false)
          pushDiscreteState(0, false, false, false)
          loopTimer.current = setTimeout(() => {
            if (mountedRef.current && inViewRef.current) startFrom(0)
          }, 120)
        }, HOLD_MS)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced, clearAllTimers, writeFrame, pushDiscreteState])

  // ── IntersectionObserver ──────────────────────────────────────────────────
  useEffect(() => {
    if (prefersReduced) { writeFrame(1, false); return }
    const el = sectionRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      const vis = entries[0].isIntersecting
      inViewRef.current = vis
      if (vis) {
        startFrom(pausedAtRef.current)
      } else {
        pausedAtRef.current = performance.now() - startRef.current
        clearAllTimers()
        pushDiscreteState(pRef.current, slowFlashRef.current, arcFlashRef.current, false)
      }
    }, { threshold: 0.5 })
    obs.observe(el)
    return () => obs.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced])

  // ── document.visibilitychange ─────────────────────────────────────────────
  useEffect(() => {
    if (prefersReduced) return
    const onVisChange = () => {
      if (document.hidden) {
        pausedAtRef.current = performance.now() - startRef.current
        clearAllTimers()
        pushDiscreteState(pRef.current, slowFlashRef.current, arcFlashRef.current, false)
      } else if (inViewRef.current) {
        startFrom(pausedAtRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVisChange)
    return () => document.removeEventListener('visibilitychange', onVisChange)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced])

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; clearAllTimers() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Watch-again ───────────────────────────────────────────────────────────
  const watchAgain = useCallback(() => {
    pausedAtRef.current = 0
    pRef.current = 0
    writeFrame(0, false)
    arcFlashRef.current  = false
    slowFlashRef.current = false
    startFrom(0)
  }, [startFrom, writeFrame])

  // ── Derive display values from flags ─────────────────────────────────────
  const playing     = !!(flags & FLAG_PLAYING)
  const beat        = (flags & FLAG_BEAT2) ? 2 : (flags & FLAG_BEAT1) ? 1 : 0
  const slowFlash   = !!(flags & FLAG_SLOW_FLASH)
  const arcFlash    = !!(flags & FLAG_ARC_FLASH)
  const slowClosed  = !!(flags & FLAG_SLOW_CLOSED)
  const slowMissed  = !!(flags & FLAG_SLOW_MISSED)
  const arcAccepted = !!(flags & FLAG_ARC_ACCEPTED)
  const arcSold     = !!(flags & FLAG_ARC_SOLD)
  const arcArrived  = !!(flags & FLAG_ARC_ARRIVED)

  const BEAT_CAPTIONS = ['', 'Ten seconds left.', 'A bid is sent at 0:04.']
  const closePct12    = toPct(0)

  return (
    <div ref={sectionRef} className="space-y-0">
      <p className="sr-only">
        Animation comparing block finality. On a 12-second-block chain, a bid placed at
        four seconds before close waits for the next block, which lands four seconds after
        the auction closed. The bid is missed. On Arc with sub-second blocks, the same bid
        lands in the next block (0.5 s later), the deadline resets to ten more seconds,
        and the auction continues until the new deadline.
      </p>

      <div aria-hidden="true" className="space-y-4">

        {/* Shared beat caption — fixed height, all variants always in DOM */}
        <div className="min-h-[1.125rem] flex items-center relative">
          {BEAT_CAPTIONS.map((text, i) => {
            const active = beat === i && i > 0
            return (
              <p key={i} className={[
                'text-xs text-ink-2 absolute inset-0',
                active ? 'opacity-100 transition-opacity duration-200' : 'opacity-0 duration-0',
              ].join(' ')} aria-hidden={!active}>{text}</p>
            )
          })}
        </div>

        {/* ── Lane 1: 12-second blocks ──────────────────────────────────────── */}
        <div>
          {/* Header */}
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-mono text-ink-3 tracking-wide">12-second blocks</span>
            <MiniClock secsLeft={slowSec} flash={slowFlash} />
          </div>

          {/* Track */}
          <div className="relative h-9 bg-surface-2 rounded-[6px] overflow-hidden">
            {/* Playhead — 2 px wide, colour uses rgb(…/alpha) syntax (CSS channels are space-separated) */}
            <div
              ref={slowPlayheadRef}
              className="absolute top-0 bottom-0 pointer-events-none z-20"
              style={{ left: '0%', opacity: 0, width: '2px', backgroundColor: 'rgb(var(--ink-2) / 0.7)' }}
            >
              {/* "now" label — rides with the playhead, clipped to track */}
              <span
                className="absolute -top-0 left-1 text-[10px] font-mono text-ink-3 leading-none select-none whitespace-nowrap"
                style={{ top: '3px' }}
              >now</span>
            </div>

            {/* Block tiles: 3 tiles, revealed by t threshold; fade + scaleX in 150 ms */}
            {SLOW_TILE_STEPS.map((storySec, i) => (
              <div
                key={storySec}
                ref={el => { slowTileRefs.current[i] = el }}
                style={{
                  left: `clamp(10px, ${toPct(storySec)}%, calc(100% - 10px))`,
                  opacity: prefersReduced ? 1 : 0,
                  transform: prefersReduced ? 'scaleX(1)' : 'scaleX(0)',
                  transition: 'opacity 150ms, transform 150ms',
                  transformOrigin: 'center',
                }}
                className="absolute top-1 bottom-1 w-[18px] -ml-[9px] rounded-[3px] bg-line border border-line/60"
              />
            ))}

            {/* Close line */}
            <div
              ref={slow12CloseRef}
              className="absolute top-0 bottom-0 w-px z-10"
              style={{ left: `${closePct12}%`, backgroundColor: 'rgb(var(--ink-3) / 0.6)' }}
            />

            {/* Bid dot — rides playhead, then drops into block */}
            <div
              ref={slowDotRef}
              className="absolute w-3 h-3 rounded-full border-2 z-30"
              style={{ display: 'none', top: '50%', marginTop: '-6px', marginLeft: '-6px',
                backgroundColor: 'rgb(var(--accent))', borderColor: 'rgb(var(--accent) / 0.5)',
                transition: 'background-color 200ms, border-color 200ms' }}
            />

            {/* Pulsing ring: shown while dot is pending past the close line */}
            <div
              ref={slowPulseRef}
              className="absolute w-5 h-5 rounded-full border-2 border-accent/50 animate-ping z-20"
              style={{ display: 'none', top: '50%', marginTop: '-10px', marginLeft: '-10px' }}
            />

            {/* "missed" tag */}
            <span
              ref={slowMissedRef}
              className="absolute text-[9px] font-mono text-ink-3 z-30 pointer-events-none select-none"
              style={{ display: 'none', top: '50%', marginTop: '-7px' }}
            >missed</span>
          </div>

          {/* Caption slot — one line high; two lines reserved on xs */}
          <div className="relative mt-1 min-h-[1.125rem] sm:min-h-[1.125rem]">
            <p className={[
              'text-xs text-ink-3 absolute inset-0',
              slowClosed && !slowMissed
                ? 'opacity-100 transition-opacity duration-200'
                : 'opacity-0 duration-0',
            ].join(' ')}>Closed. The bid is waiting for a block.</p>
            <p className={[
              'text-xs text-ink-3 absolute inset-0',
              slowMissed
                ? 'opacity-100 transition-opacity duration-200'
                : 'opacity-0 duration-0',
            ].join(' ')}>Missed. It landed 4 s after close.</p>
          </div>
        </div>

        {/* ── Lane 2: Arc, sub-second blocks ───────────────────────────────── */}
        <div>
          {/* Header */}
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-mono text-accent-text tracking-wide whitespace-nowrap">Arc, sub-second blocks</span>
            <span className="flex items-center gap-2">
              <span className={[
                'hidden sm:inline text-[10px] font-semibold font-mono text-warn bg-warn/15 px-1.5 py-0.5 rounded-[3px] whitespace-nowrap transition-opacity duration-200',
                arcAccepted && arcSec > 0 && arcSec <= 10 ? 'opacity-100' : 'opacity-0',
              ].join(' ')}>Back to 0:10</span>
              <MiniClock secsLeft={arcSec} flash={arcFlash} />
            </span>
          </div>

          {/* Track */}
          <div className="relative h-9 bg-surface-2 rounded-[6px] overflow-hidden">
            {/* Playhead — same left value as slow lane; 2 px, rgb(…/alpha) colour */}
            <div
              ref={arcPlayheadRef}
              className="absolute top-0 bottom-0 pointer-events-none z-20"
              style={{ left: '0%', opacity: 0, width: '2px', backgroundColor: 'rgb(var(--ink-2) / 0.7)' }}
            />

            {/* Dense Arc tiles: rendered once, opacity written imperatively */}
            {ARC_TILE_STEPS.map((ts, i) => (
              <div
                key={ts}
                ref={el => { arcTileRefs.current[i] = el }}
                style={{
                  left: `clamp(3px, ${toPct(ts)}%, calc(100% - 3px))`,
                  opacity: prefersReduced ? 1 : 0,
                  transition: 'opacity 150ms',
                }}
                className="absolute top-1.5 bottom-1.5 w-[3px] -ml-[1.5px] rounded-[1px] bg-ink-3/40"
              />
            ))}

            {/* Close line */}
            <div
              ref={arcCloseRef}
              className="absolute top-0 bottom-0 w-px bg-accent/70 z-10"
              style={{ left: `${toPct(0)}%` }}
            />

            {/* Arc dot — rides playhead, then snaps to block with a pop spring */}
            {/* The motion.div key changes when arcArrived flips, triggering the spring */}
            <motion.div
              key={arcArrived ? 'arc-landed' : 'arc-riding'}
              ref={arcDotRef}
              className="absolute w-3 h-3 rounded-full border-2 z-30"
              initial={arcArrived ? { scale: 1.35 } : { scale: 1 }}
              animate={{ scale: 1 }}
              transition={arcArrived
                ? { type: 'spring', stiffness: 500, damping: 20 }
                : { duration: 0 }}
              style={{ display: 'none', top: '50%', marginTop: '-6px', marginLeft: '-6px',
                backgroundColor: 'rgb(var(--accent))', borderColor: 'rgb(var(--accent) / 0.5)',
                transition: 'background-color 200ms, border-color 200ms' }}
            />

            {/* "in block" tag */}
            <span
              ref={arcInBlockRef}
              className="absolute text-[9px] font-mono text-good z-30 pointer-events-none select-none"
              style={{ display: 'none', top: '50%', marginTop: '-7px' }}
            >in block</span>
          </div>

          {/* Caption slot */}
          <div className="relative mt-1 min-h-[1.125rem] sm:min-h-[1.125rem]">
            <p className={[
              'text-xs text-good absolute inset-0',
              arcAccepted && !arcSold
                ? 'opacity-100 transition-opacity duration-200'
                : 'opacity-0 duration-0',
            ].join(' ')}>Accepted in 0.5 s. Clock back to 0:10.</p>
            <p className={[
              'text-xs text-good absolute inset-0',
              arcSold
                ? 'opacity-100 transition-opacity duration-200'
                : 'opacity-0 duration-0',
            ].join(' ')}>Sold to the late bidder.</p>
          </div>
        </div>

        {/* Watch again */}
        <div className="pt-0.5">
          <button
            onClick={watchAgain}
            className="text-xs font-medium text-ink-3 hover:text-ink-2 transition-colors underline underline-offset-2"
          >{playing ? 'Restart' : 'Watch again'}</button>
        </div>

      </div>
    </div>
  )
}

// ── Section 4: Lot flow steps ─────────────────────────────────────────────────
// Each step has a real value shown in the node instead of a decorative icon.
const LOT_STEPS = [
  { value: '0.10',  unit: 'USDC', title: 'List',             body: 'Seller deposits a USDC bond and sets a reserve price and duration.' },
  { value: '0.15',  unit: 'USDC', title: 'Bid',              body: 'Bidders pay in USDC, directly or gasless via a single EIP-3009 signature.' },
  { value: '0:04',  unit: '',     title: 'Last ten seconds', body: 'Any bid with ten seconds or less to go extends the clock by ten seconds, up to 30 times.' },
  { value: '0.20',  unit: 'USDC', title: 'Sold',             body: 'One transaction swaps USDC and transfers the lot token atomically.' },
]

function LotFlow() {
  const lineRef = useRef<HTMLDivElement>(null)
  const [lineH, setLineH] = useState(0)

  useEffect(() => {
    const el = lineRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return
      const target = el.scrollHeight
      const start = Date.now()
      const dur = 900
      const tick = () => {
        const p = Math.min(1, (Date.now() - start) / dur)
        setLineH(Math.round(p * target))
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      obs.disconnect()
    }, { threshold: 0.2 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div className="md:hidden relative pl-8" ref={lineRef}>
      <div
        className="absolute left-3 top-0 w-px bg-line"
        style={{ height: `${lineH}px` }}
      />
      <div className="space-y-8">
        {LOT_STEPS.map(({ value, unit, title, body }, i) => (
          <div key={i} className="relative flex gap-4">
            {/* Node: real value in Geist Mono */}
            <div className="absolute -left-[21px] min-w-[42px] h-6 rounded-full bg-surface border border-line flex items-center justify-center shrink-0 px-1.5">
              <span className="font-mono text-[10px] text-accent-text leading-none whitespace-nowrap">
                {value}{unit ? <span className="text-ink-3 ml-0.5">{unit}</span> : null}
              </span>
            </div>
            <div className="space-y-1">
              <p className="font-semibold text-ink text-sm">{title}</p>
              <p className="text-sm text-ink-2">{body}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function LotFlowDesktop() {
  const [lineW, setLineW] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return
      const target = el.scrollWidth - 32
      const start = Date.now()
      const dur = 900
      const tick = () => {
        const p = Math.min(1, (Date.now() - start) / dur)
        setLineW(Math.round(p * target))
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      obs.disconnect()
    }, { threshold: 0.2 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return (
    <div ref={containerRef} className="relative">
      {/* Horizontal hairline */}
      <svg className="absolute top-5 left-0 w-full h-px pointer-events-none" preserveAspectRatio="none">
        <line x1="16" y1="0" x2={lineW} y2="0" stroke="rgb(var(--line))" strokeWidth="1" />
      </svg>
      <div className="grid grid-cols-4 gap-6">
        {LOT_STEPS.map(({ value, unit, title, body }, i) => (
          <div key={i} className="space-y-3 pt-2">
            {/* Node: real value in Geist Mono */}
            <div className="h-10 w-fit min-w-[56px] px-3 rounded-full bg-surface border border-line flex items-center justify-center">
              <span className="font-mono text-xs text-accent-text leading-none whitespace-nowrap">
                {value}{unit ? <span className="text-ink-3 ml-0.5">{unit}</span> : null}
              </span>
            </div>
            <p className="font-semibold text-ink">{title}</p>
            <p className="text-sm text-ink-2">{body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Market events mini feed ───────────────────────────────────────────────────
const MARKET_EVENTS = new Set([
  'Listed','Bid','RelayedBid','Outbid','Extended','Hammer','Unsold',
  'Claimed','BondHeld','BondReleased','Disputed','DisputeResolved','SaleRecorded',
])

// ── Main Landing component ────────────────────────────────────────────────────
export default function Landing() {
  const { pathname: fromPath } = useLocation()
  const block  = useLatestBlock()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const { logs } = useLogStore()

  // ── Featured lot (ends soonest) ────────────────────────────────────────────────────────────
  const [houseLot, setHouseLot] = useState<{ id: bigint; lot: LotTuple } | null>(null)
  const [houseLotLabel, setHouseLotLabel] = useState('')
  const [houseLotNftImage,  setHouseLotNftImage]  = useState<string | undefined>(undefined)
  const [houseLotImage,     setHouseLotImage]     = useState<string | undefined>(undefined)
  const [houseLotTokenAddr, setHouseLotTokenAddr] = useState<string | undefined>(undefined)
  const [houseLotTokenSym,  setHouseLotTokenSym]  = useState<string | undefined>(undefined)
  const [lastHouse, setLastHouse] = useState<{ id: bigint; bid: bigint } | null>(null)
  const lastRunRef  = useRef(0)
  const inFlightRef = useRef(false)

  const nowSec = Number(block?.blockTimestamp ?? 0n) || (Date.now() / 1000)

  const findHouseLot = useCallback(async () => {
    // At most one scan every 4 s, one at a time; a failed scan keeps the last result.
    if (!client || inFlightRef.current || Date.now() - lastRunRef.current < 4000) return
    inFlightRef.current = true
    lastRunRef.current = Date.now()
    try {
      const count = Number(await client.readContract({
        address: AUCTION_HOUSE_ADDRESS, abi: AUCTION_HOUSE_ABI, functionName: 'nextLotId', args: [],
      }))
      if (count === 0) return
      // Scan newest 24 lots
      const start = Math.max(0, count - 24)
      const ids = Array.from({ length: count - start }, (_, i) => BigInt(start + i))
      const results = await client.multicall({
        contracts: ids.map(id => ({
          address: AUCTION_HOUSE_ADDRESS as `0x${string}`,
          abi: AH_ABI_TYPED,
          functionName: 'lots' as const,
          args: [id] as [bigint],
        })),
        allowFailure: true,
      })
      let foundLive: { id: bigint; lot: LotTuple } | null = null
      let foundLast: { id: bigint; bid: bigint } | null = null
      for (let i = results.length - 1; i >= 0; i--) {
        const r = results[i]
        if (r.status !== 'success') continue
        const raw = r.result as readonly [`0x${string}`,bigint,bigint,bigint,bigint,bigint,bigint,`0x${string}`,bigint,bigint,boolean,boolean,boolean,boolean]
        const lot: LotTuple = {
          seller: raw[0], tokenId: raw[1], reserve: raw[2], minIncrement: raw[3],
          bond: raw[4], deadline: raw[5], highestBid: raw[6], highestBidder: raw[7],
          extensions: raw[8], settledAt: raw[9], settled: raw[10], cancelled: raw[11],
          bondReleased: raw[12], disputed: raw[13],
        }
        // Feature the live lot that ends soonest, whoever listed it.
        const isLive = !lot.settled && !lot.cancelled && Number(lot.deadline) > nowSec
        if (isLive && (!foundLive || lot.deadline < foundLive.lot.deadline)) foundLive = { id: ids[i], lot }
        if (!foundLast && lot.settled && lot.highestBid > 0n) foundLast = { id: ids[i], bid: lot.highestBid }
      }
      setHouseLot(foundLive)
      if (foundLast) setLastHouse(foundLast)
      // Fetch asset label for the featured lot (if on-chain kind)
      if (foundLive) {
        try {
          const [kindRes, assetRes, amountRes, gavelLotAddr] = await Promise.all([
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AH_ABI_TYPED, functionName: 'lotKind', args: [foundLive.id] }),
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AH_ABI_TYPED, functionName: 'lotAsset', args: [foundLive.id] }),
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AH_ABI_TYPED, functionName: 'lotAmount', args: [foundLive.id] }),
            client.readContract({ address: AUCTION_HOUSE_ADDRESS, abi: AH_ABI_TYPED, functionName: 'gavelLot', args: [] }).catch(() => null),
          ])
          const kind = Number(kindRes) as LotKind
          const asset = assetRes as string
          const amount = amountRes as bigint
          // Seller-uploaded image from GavelLot tokenURI (OFFCHAIN lots)
          if (kind === LotKind.OFFCHAIN && gavelLotAddr) {
            const TOKEN_URI_ABI_LAND = [{ name: 'tokenURI', type: 'function', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' }] as const
            try {
              const uri = await client.readContract({ address: gavelLotAddr as `0x${string}`, abi: TOKEN_URI_ABI_LAND, functionName: 'tokenURI', args: [foundLive.lot.tokenId] })
              if (uri?.startsWith('data:application/json')) {
                const json = JSON.parse(atob(uri.split(',')[1])) as { image?: string }
                const img = json.image?.trim() ?? ''
                if (img.startsWith('https://') || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(img)) setHouseLotImage(img)
                else setHouseLotImage(undefined)
              }
            } catch { setHouseLotImage(undefined) }
          } else {
            setHouseLotImage(undefined)
          }
          if (kind === LotKind.ERC20 && asset) { setHouseLotTokenAddr(asset) } else { setHouseLotTokenAddr(undefined) }
          if (kind === LotKind.ERC20 && asset && !getTokenMetaCache(asset)) {
            const [dRes, sRes] = await Promise.all([
              client.readContract({ address: asset as `0x${string}`, abi: [{ name: 'decimals', type: 'function', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' }] as const, functionName: 'decimals', args: [] }),
              client.readContract({ address: asset as `0x${string}`, abi: [{ name: 'symbol', type: 'function', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' }] as const, functionName: 'symbol', args: [] }),
            ])
            setTokenMetaCache(asset, Number(dRes), sRes)
          }
          const meta = getTokenMetaCache(asset)
          setHouseLotTokenSym(meta?.symbol)
          setHouseLotLabel(fmtAssetLabel(kind, foundLive.lot.tokenId, amount, asset, meta?.decimals, meta?.symbol))
          // Fetch NFT image for ERC-721/ERC-1155
          if (kind === LotKind.ERC721 || kind === LotKind.ERC1155) {
            const kindParam = kind === LotKind.ERC721 ? '721' : '1155'
            fetch(`/api/nft-meta?kind=${kindParam}&asset=${encodeURIComponent(asset)}&id=${foundLive.lot.tokenId.toString()}`)
              .then(r => r.ok ? r.json() as Promise<{image: string|null}> : {image: null})
              .then(d => setHouseLotNftImage(d.image ?? undefined))
              .catch(() => {})
          } else {
            setHouseLotNftImage(undefined)
          }
        } catch {}
      } else {
        setHouseLotLabel('')
        setHouseLotNftImage(undefined)
        setHouseLotImage(undefined)
      }
    } catch {
      lastRunRef.current = Date.now() + 4000 // rate limited: wait ~8 s before the next try
    } finally {
      inFlightRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, nowSec])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void findHouseLot() }, [findHouseLot, block?.blockNumber])

  const { secs, extended } = useCountdown(houseLot ? Number(houseLot.lot.deadline) : 0)

  // ── Log store stats ──────────────────────────────────────────────────────
  const marketLogs  = logs.filter(l => MARKET_EVENTS.has(l.name))
  // Every gasless bid emits both Bid and RelayedBid, so count bids from Bid only.
  const bidLogs     = logs.filter(l => l.name === 'Bid')
  const relayedLogs = logs.filter(l => l.name === 'RelayedBid')
  const hammerLogs  = logs.filter(l => l.name === 'Hammer')
  const distinctBidders = new Set(bidLogs.map(l => String(l.args.bidder).toLowerCase())).size
  const totalBidVol = bidLogs.reduce((s, l) => s + (l.args.amount as bigint ?? 0n), 0n)

  const latestRelayed = relayedLogs[relayedLogs.length - 1]
  const last5Market   = marketLogs.slice(-5).reverse()

  // ── Section 2 count-up figures ───────────────────────────────────────────
  // Volume: totalBidVol is in 6-decimal USDC units; display with 2 dp
  const volTarget = Number(totalBidVol) / 1_000_000
  const { val: volVal,     ref: volRef     } = useCountUp(volTarget, 1200, 2)
  const { val: bidsVal,    ref: bidsRef    } = useCountUp(bidLogs.length)
  const { val: bidderVal,  ref: bidderRef  } = useCountUp(distinctBidders)
  const { val: settledVal, ref: settledRef } = useCountUp(hammerLogs.length)

  const houseLotTarget = houseLot
    ? `/lot/${houseLot.id}`
    : '/lots'

  return (
    <div className="text-ink overflow-x-hidden">

      {/* ── Live mainnet stats strip (hidden until logs loaded) ─────────── */}
      <LiveStatsStrip />

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §1  HERO                                                           */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section className="min-h-[calc(100dvh-64px)] flex items-center py-16 md:py-0">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12 w-full">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-12 items-center">

            {/* Left — copy */}
            <div className="md:col-span-6 space-y-6 order-2 md:order-1">
              {/* Eyebrow — ONE on the whole page */}
              <FadeUp delay={0}>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-tag bg-accent/15 text-accent-text text-xs font-semibold uppercase tracking-widest">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  Live on {NETWORK_LABEL}
                </span>
              </FadeUp>

              <FadeUp delay={0.05}>
                <h1 className="text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05] text-balance">
                  The auction ends when the bidding does.
                </h1>
              </FadeUp>

              <FadeUp delay={0.1}>
                <p className="text-ink-2 text-lg max-w-[50ch] leading-relaxed">
                  Every bid is a USDC transaction. A late bid adds ten seconds. The lot and the payment swap in one step.
                </p>
              </FadeUp>

              <FadeUp delay={0.15}>
                <div className="flex items-center gap-4 flex-wrap">
                  {/* Button-in-button CTA */}
                  <Link
                    to={houseLotTarget}
                    viewTransition
                    onClick={() => setNavDirection(houseLotTarget, fromPath)}
                    className="group flex items-center gap-0 rounded-btn font-semibold bg-accent text-accent-ink hover:opacity-90 active:translate-y-px transition-all text-sm pl-5 pr-1.5 py-1.5"
                  >
                    {houseLot ? 'Bid on a live lot' : 'Browse lots'}
                    <span className="ml-3 w-8 h-8 rounded-[8px] bg-accent-ink/15 flex items-center justify-center group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">
                      <ArrowCircleRight size={16} weight="bold" className="text-accent-ink" />
                    </span>
                  </Link>
                  <Link
                    to="/proof"
                    className="text-sm text-ink-2 hover:text-ink transition-colors underline underline-offset-2"
                  >
                    See every transaction
                  </Link>
                </div>
              </FadeUp>
            </div>

            {/* Right — live auction panel */}
            <div className="md:col-span-6 order-1 md:order-2">
              <FadeUp delay={0.08}>
                {houseLot ? (
                  <BezelPanel
                    lotId={houseLot.id}
                    lot={houseLot.lot}
                    secs={secs}
                    extended={extended}
                    assetLabel={houseLotLabel || undefined}
                    lotImage={houseLotImage}
                    nftImage={houseLotNftImage}
                    tokenIconAddress={houseLotTokenAddr}
                    tokenIconSymbol={houseLotTokenSym}
                  />
                ) : (
                  <BezelPlaceholder
                    lastLotId={lastHouse?.id}
                    lastBid={lastHouse?.bid}
                  />
                )}
              </FadeUp>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §2  LIVE NUMBERS                                                   */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section className="py-24 md:py-32 border-t border-line">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12">
          <FadeUp>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-0 md:divide-x divide-line">
              {[
                { ref: volRef,     val: volVal,     suffix: ' USDC', label: 'Bid volume', decimals: 2 },
                { ref: bidsRef,    val: bidsVal,    suffix: '',      label: 'Bids placed',       decimals: 0 },
                { ref: bidderRef,  val: bidderVal,  suffix: '',      label: 'Distinct bidders',  decimals: 0 },
                { ref: settledRef, val: settledVal, suffix: '',      label: 'Lots settled',      decimals: 0 },
              ].map(({ ref, val, suffix, label, decimals }) => (
                <div key={label} ref={ref} className="md:px-10 first:pl-0 last:pr-0 space-y-1">
                  <p className="font-mono tabular-nums text-4xl md:text-5xl font-bold text-ink tracking-tight">
                    {val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}
                  </p>
                  <p className="text-sm text-ink-3">{label}</p>
                </div>
              ))}
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §3  WHY ARC                                                        */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section className="py-24 md:py-32 border-t border-line">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-12 items-start">
            <div className="md:col-span-5 space-y-4">
              <FadeUp>
                <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-balance leading-tight">
                  Ten seconds only means something on a fast chain.
                </h2>
              </FadeUp>
              <FadeUp delay={0.05}>
                <p className="text-ink-2 leading-relaxed">
                  On a chain with 12-second blocks, a bid at T-4 s arrives after the close. On Arc, sub-second finality means every late bid lands and extends the clock as intended.
                </p>
              </FadeUp>
            </div>
            <div className="md:col-span-7">
              <FadeUp delay={0.08}>
                <div className="rounded-panel border border-line bg-surface p-6 md:p-8">
                  <BlockComparison />
                </div>
              </FadeUp>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §4  HOW A LOT MOVES                                                */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section id="how-it-works" className="py-24 md:py-32 border-t border-line">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12 space-y-10">
          <FadeUp>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">How a lot moves</h2>
          </FadeUp>
          <FadeUp delay={0.05}>
            <div className="hidden md:block">
              <LotFlowDesktop />
            </div>
            <LotFlow />
          </FadeUp>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §5  NO GAS NEEDED                                                  */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section className="py-24 md:py-32 border-t border-line">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-12 items-center">

            {/* Left — live relayed bid */}
            <div className="md:col-span-7">
              <FadeUp>
                {latestRelayed ? (
                  <div className="rounded-panel border border-line bg-surface p-6 md:p-8 space-y-3">
                    <div className="flex items-center gap-2 mb-4">
                      <Lightning size={14} weight="fill" className="text-warn" />
                      <span className="text-xs font-semibold text-ink-3 uppercase tracking-widest">Latest gasless bid</span>
                    </div>
                    <p className="font-mono tabular-nums text-4xl md:text-5xl font-bold text-ink">
                      {fmtUsdc(latestRelayed.args.amount as bigint)}
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-ink-2 text-sm">{shortAddr(latestRelayed.args.bidder as string)}</span>
                      <span className="text-xs text-ink-3">signed, not sent</span>
                    </div>
                    <a
                      href={`https://explorer.arc.io/tx/${latestRelayed.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-accent-text transition-colors"
                    >
                      View tx <ArrowSquareOut size={11} />
                    </a>
                  </div>
                ) : (
                  <div className="rounded-panel border border-line bg-surface p-8 space-y-3">
                    <Lightning size={32} weight="thin" className="text-ink-3" />
                    <p className="text-ink-3 text-sm">No gasless bids yet.</p>
                  </div>
                )}
              </FadeUp>
            </div>

            {/* Right — copy */}
            <div className="md:col-span-5 space-y-4">
              <FadeUp delay={0.05}>
                <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-balance leading-tight">
                  Bid with one signature.
                </h2>
              </FadeUp>
              <FadeUp delay={0.1}>
                <p className="text-ink-2 leading-relaxed">
                  Sign once with EIP-3009. The relayer pays gas and submits. Your USDC only moves if the bid is accepted on-chain.
                </p>
              </FadeUp>
              <FadeUp delay={0.12}>
                <p className="text-sm text-ink-3 font-mono tabular-nums">
                  {relayedLogs.length.toLocaleString()} relayed bids so far
                </p>
              </FadeUp>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §6  BUILT IN THE OPEN (bento 2+1)                                 */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section className="py-24 md:py-32 border-t border-line">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12">
          <FadeUp>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

              {/* Big cell — on-chain event feed */}
              <div className="md:col-span-2 rounded-panel border border-line bg-surface p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-ink">Every event is on chain</p>
                  <Link to="/proof" className="text-xs text-accent-text hover:underline flex items-center gap-1">
                    View proof <ArrowRight size={11} />
                  </Link>
                </div>
                <div className="divide-y divide-line">
                  {last5Market.length === 0 && (
                    <p className="text-sm text-ink-3 py-4">Scanning chain events...</p>
                  )}
                  {last5Market.map((l, i) => (
                    <div key={i} className="flex items-center justify-between py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-accent-text bg-accent/10 px-1.5 py-0.5 rounded-tag">{l.name}</span>
                        <span className="text-xs font-mono text-ink-2">
                          {typeof l.args.lotId === 'bigint' ? `lot #${l.args.lotId}` : ''}
                        </span>
                      </div>
                      {typeof l.args.amount === 'bigint' && l.args.amount > 0n && (
                        <span className="font-mono tabular-nums text-xs text-ink">{fmtUsdc(l.args.amount)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right column: two stacked cells */}
              <div className="flex flex-col gap-4">
                <a
                  href="https://studio.arc.io"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-panel border border-accent/30 bg-accent/5 p-6 flex flex-col justify-between gap-4 hover:border-accent/60 transition-colors group flex-1"
                >
                  <div>
                    <p className="font-semibold text-ink">Built in Arc Studio</p>
                    <p className="text-sm text-ink-2 mt-1">Contracts, tests, gasless relayer and this app, built and tested in Arc Studio.</p>
                  </div>
                  <ArrowSquareOut size={14} className="text-accent-text group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                </a>

                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-panel border border-line bg-surface-2 p-6 flex flex-col justify-between gap-4 hover:bg-surface transition-colors group flex-1"
                >
                  <div>
                    <p className="font-semibold text-ink">Open source</p>
                    <p className="text-sm text-ink-2 mt-1">Contract, tests, and frontend on GitHub.</p>
                  </div>
                  <ArrowSquareOut size={14} className="text-ink-3 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                </a>
              </div>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §7  FINAL CTA                                                      */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <section className="py-24 md:py-32 border-t border-line">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12 text-center space-y-6">
          <FadeUp>
            <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
              Bring a lot. Or win one.
            </h2>
          </FadeUp>
          <FadeUp delay={0.05}>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <Link
                to="/lots"
                viewTransition
                onClick={() => setNavDirection('/lots', fromPath)}
                className="group flex items-center gap-0 rounded-btn font-semibold bg-accent text-accent-ink hover:opacity-90 active:translate-y-px transition-all text-sm pl-5 pr-1.5 py-1.5"
              >
                Open app
                <span className="ml-3 w-8 h-8 rounded-[8px] bg-accent-ink/15 flex items-center justify-center group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">
                  <ArrowCircleRight size={16} weight="bold" className="text-accent-ink" />
                </span>
              </Link>
              <Link
                to="/create"
                className="text-sm text-ink-2 hover:text-ink transition-colors underline underline-offset-2"
              >
                Create a lot
              </Link>
            </div>
          </FadeUp>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* §8  FOOTER                                                         */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      <footer className="border-t border-line py-6">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-3">
          <Link to="/proof" className="hover:text-ink transition-colors">
            On-chain proof
          </Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-ink transition-colors flex items-center gap-1">
            <ArrowSquareOut size={11} /> GitHub
          </a>
          <a href="https://studio.arc.io" target="_blank" rel="noopener noreferrer" className="hover:text-ink transition-colors">
            Arc Studio
          </a>
          <span>Built on {NETWORK_LABEL}</span>
          <StudioWatermark />
        </div>
      </footer>

    </div>
  )
}
