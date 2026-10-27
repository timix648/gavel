/**
 * Landing page — /
 * Spec: DESIGN.md section 8. Real chain data only; no div-built fake screenshots.
 * Sections: Hero, Live Numbers, Why Arc, How a Lot Moves, No Gas Needed, Built in the Open, Final CTA, Footer.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { setNavDirection } from '../App'
import { usePublicClient } from 'wagmi'
import { motion, AnimatePresence } from 'framer-motion'
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
import { fmtUsdc, shortAddr } from '../utils'
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
  const visible = useRef(false)   // B9: track visibility separately from started
  const raf = useRef<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // B9: trigger a fresh count-up whenever target changes (and element is visible)
  useEffect(() => {
    if (!visible.current) return
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    const start = Date.now()
    const startVal = 0
    const mult = Math.pow(10, decimals)
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / duration)
      setVal(Math.round((startVal + p * (target - startVal)) * mult) / mult)
      if (p < 1) { raf.current = requestAnimationFrame(tick) } else { raf.current = null }
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current) }
  }, [target, duration, decimals])

  // Start on first intersection
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || visible.current) return
      visible.current = true
      obs.disconnect()
      const start = Date.now()
      const mult = Math.pow(10, decimals)
      const tick = () => {
        const p = Math.min(1, (Date.now() - start) / duration)
        setVal(Math.round(p * target * mult) / mult)
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, { threshold: 0.3 })
    obs.observe(el)
    return () => obs.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // run once; target changes handled above

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

function BlockComparison() {
  const prefersReduced = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // p: shared story progress 0..1 (immediately = 1 under reduced-motion)
  const [p, setP]               = useState(prefersReduced ? 1 : 0)
  const [playing, setPlaying]   = useState(false)
  const [hovered, setHovered]   = useState(false)
  const [arcFlash, setArcFlash] = useState(false)

  // Refs for the RAF loop and IntersectionObserver
  const rafRef      = useRef<number | null>(null)
  const startRef    = useRef<number>(0)
  const pausedAtRef = useRef<number>(0)
  const sectionRef  = useRef<HTMLDivElement>(null)
  const inViewRef   = useRef(false)
  const holdTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loopTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashFired  = useRef(false)

  const stopRAF = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (holdTimer.current)      { clearTimeout(holdTimer.current);      holdTimer.current = null }
    if (loopTimer.current)      { clearTimeout(loopTimer.current);      loopTimer.current = null }
  }, [])

  const startFrom = useCallback((elapsed: number) => {
    if (prefersReduced) return
    stopRAF()
    flashFired.current = false
    startRef.current = performance.now() - elapsed
    setPlaying(true)
    const tick = (now: number) => {
      const wallElapsed = now - startRef.current
      const newP = Math.min(1, wallElapsed / WALL_MS)
      setP(newP)
      // Arc flash fires once when Arc bid lands (T-3.5 = p=16.5/29)
      if (!flashFired.current && newP >= 16.5 / STORY_SECS) {
        flashFired.current = true
        setArcFlash(true)
        setTimeout(() => setArcFlash(false), 700)
      }
      if (newP < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        setPlaying(false)
        holdTimer.current = setTimeout(() => {
          if (inViewRef.current) {
            setP(0)
            flashFired.current = false
            loopTimer.current = setTimeout(() => {
              if (inViewRef.current) startFrom(0)
            }, 120)
          }
        }, HOLD_MS)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [prefersReduced, stopRAF])

  const pause = useCallback(() => {
    if (!playing) return
    pausedAtRef.current = performance.now() - startRef.current
    stopRAF()
    setPlaying(false)
  }, [playing, stopRAF])

  const resume = useCallback(() => {
    if (prefersReduced || !inViewRef.current) return
    startFrom(pausedAtRef.current)
  }, [prefersReduced, startFrom])

  // Autoplay: fire when >= 50% in view, pause when out
  useEffect(() => {
    if (prefersReduced) return
    const el = sectionRef.current
    if (!el) return
    const obs = new IntersectionObserver(entries => {
      const vis = entries[0].isIntersecting
      inViewRef.current = vis
      if (vis && !hovered) startFrom(pausedAtRef.current)
      else if (!vis) {
        pausedAtRef.current = performance.now() - startRef.current
        stopRAF()
        setPlaying(false)
      }
    }, { threshold: 0.5 })
    obs.observe(el)
    return () => obs.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefersReduced])

  // Pause/resume on hover or focus
  useEffect(() => {
    if (hovered) pause()
    else if (inViewRef.current) resume()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered])

  const watchAgain = useCallback(() => {
    pausedAtRef.current = 0
    setP(0)
    flashFired.current = false
    startFrom(0)
  }, [startFrom])

  // ── All derived values from p ─────────────────────────────────────────────
  const t = storyT(p)   // story-time: -20..+9

  // ── 12-second lane clock ──────────────────────────────────────────────────
  // Counts down from 20 to 0 at T=0, then holds at 0.
  const slowSecsLeft = Math.max(0, -t)

  // ── Arc lane clock ────────────────────────────────────────────────────────
  // T-20 → T-3.5: counts 20 → 3.5 (i.e. max(0, -t))
  // T-3.5: bid accepted, deadline becomes T+6.5.  clock jumps to 10 and counts down.
  // T+6.5 → T+9: holds at 0.
  const arcSecsLeft = t < -3.5
    ? Math.max(0, -t)                  // 20 → 3.5 (then jump)
    : Math.max(0, 6.5 - t)            // 10 → 0, holds at 0

  // ── Beat captions (shared) ────────────────────────────────────────────────
  // beat 0: t < -10
  // beat 1: T-10 .. T-4   "Ten seconds left."
  // beat 2: T-4  .. T=0   "A bid is sent at 0:04."
  // (per-lane captions fire at their own thresholds below)
  const beat = t >= -4 ? 2 : t >= -10 ? 1 : 0
  const BEAT_CAPTIONS = ['', 'Ten seconds left.', 'A bid is sent at 0:04.']

  // ── Per-lane outcome captions ─────────────────────────────────────────────
  // 12-s: "Closed." at T=0; "Missed." at T+4
  const slowClosed  = t >= 0
  const slowMissed  = t >= 4
  // Arc: "Accepted." at T-3.5; "Sold." at T+6.5
  const arcAccepted = t >= -3.5
  const arcSold     = t >= 6.5

  // ── 12-s lane block tiles ─────────────────────────────────────────────────
  // Blocks every 12 s: T-20, T-8, then T+4, which is after the close line
  const slowTiles: { storySec: number }[] = [
    { storySec: -20 },
    { storySec:  -8 },
    { storySec:   4 },
  ]
  const closePct12 = toPct(0)   // 12-s close line: fixed at T=0

  // ── Arc lane block tiles ──────────────────────────────────────────────────
  // Dense tiles every 0.5 s from T-20 to T+9
  const arcTileSteps: number[] = []
  for (let ts = -20; ts <= 9; ts += 0.5) arcTileSteps.push(ts)

  // Arc close line: fixed at T=0 until T-3.5, then jumps to T+6.5 (deadline = T+6.5)
  const arcClosePct = t >= -3.5 ? toPct(6.5) : toPct(0)

  // ── Bid dot positions ─────────────────────────────────────────────────────
  // Both dots leave from toPct(-4) at T-4.
  const bidSentP  = 16 / STORY_SECS   // p at T-4
  const bidPct    = toPct(-4)

  // 12-s dot: travels from T-4 to T+4 (next block), arriving at p=24/29.
  // After arrival it stays at toPct(4) and turns ink-3.
  const slowBidVisible  = p >= bidSentP
  const slowBidArrived  = p >= 24 / STORY_SECS
  const slowBidX = (() => {
    if (!slowBidVisible) return bidPct
    if (slowBidArrived)  return toPct(4)
    return bidPct + ((p - bidSentP) / (24 / STORY_SECS - bidSentP)) * (toPct(4) - bidPct)
  })()

  // Arc dot: travels from T-4 to T-3.5 (0.5-s block), arriving at p=16.5/29.
  // Dot becomes --good on arrival.
  const arcBidArriveP  = 16.5 / STORY_SECS
  const arcBidVisible  = p >= bidSentP
  const arcBidArrived  = p >= arcBidArriveP
  const arcBidX = (() => {
    if (!arcBidVisible) return bidPct
    if (arcBidArrived)  return toPct(-3.5)
    return bidPct + ((p - bidSentP) / (arcBidArriveP - bidSentP)) * (toPct(-3.5) - bidPct)
  })()

  // ── 12-s close line flash (fires once at T=0) ──────────────────────────────
  const [slowFlash, setSlowFlash] = useState(false)
  const slowFlashFired = useRef(false)
  useEffect(() => {
    if (slowFlashFired.current) return
    if (t >= 0) {
      slowFlashFired.current = true
      setSlowFlash(true)
      setTimeout(() => setSlowFlash(false), 500)
    }
  }, [t])
  // Reset slow flash tracking when animation loops (p resets to 0)
  useEffect(() => {
    if (p === 0) { slowFlashFired.current = false; setSlowFlash(false) }
  }, [p])

  return (
    <div
      ref={sectionRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className="space-y-0"
    >
      {/* Accessible summary */}
      <p className="sr-only">
        Animation comparing block finality. On a 12-second-block chain, a bid placed at
        four seconds before close waits for the next block, which lands four seconds after
        the auction closed. The bid is missed. On Arc with sub-second blocks, the same bid
        lands in the next block (0.5 s later), the deadline resets to ten more seconds,
        and the auction continues until the new deadline.
      </p>

      <div aria-hidden="true" className="space-y-6">

        {/* Shared beat caption */}
        <div className="h-5 flex items-center">
          <AnimatePresence mode="wait">
            {beat > 0 && (
              <motion.p
                key={beat}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.25 }}
                className="text-xs text-ink-2"
              >
                {BEAT_CAPTIONS[beat]}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {/* ── Lane 1: 12-second blocks ──────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-ink-3 tracking-wide">12-second blocks</span>
            <MiniClock secsLeft={Math.ceil(slowSecsLeft)} flash={slowFlash} />
          </div>

          <div className="relative h-10 bg-surface-2 rounded-[6px] overflow-hidden">
            {/* Block tiles */}
            {slowTiles.map(({ storySec }) => t >= storySec && (
              <motion.div
                key={storySec}
                initial={{ scaleY: 0, opacity: 0.4 }}
                animate={{ scaleY: 1, opacity: 1 }}
                transition={{ duration: 0.15 }}
                className="absolute top-1 bottom-1 w-[18px] -ml-[9px] rounded-[3px] bg-line border border-line/60"
                style={{ left: `clamp(10px, ${toPct(storySec)}%, calc(100% - 10px))` }}
              />
            ))}

            {/* Close line (fixed) */}
            <div
              className={[
                'absolute top-0 bottom-0 w-px transition-colors duration-300',
                slowFlash ? 'bg-warn' : 'bg-ink-3/60',
              ].join(' ')}
              style={{ left: `${closePct12}%` }}
            />

            {/* Bid dot */}
            {slowBidVisible && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className={[
                  'absolute top-1/2 -translate-y-1/2 w-3 h-3 -ml-1.5 rounded-full border-2 transition-colors duration-200',
                  slowBidArrived ? 'bg-surface border-ink-3' : 'bg-accent border-accent/40',
                ].join(' ')}
                style={{ left: `${slowBidX}%` }}
              />
            )}

            {/* "pending" label: dot is past close but not yet in a block */}
            {slowBidVisible && !slowBidArrived && slowClosed && (
              <span
                className="absolute top-1/2 -translate-y-1/2 text-[10px] font-mono text-ink-3 pointer-events-none select-none ml-2"
                style={{ left: `${slowBidX}%` }}
              >
                pending
              </span>
            )}
          </div>

          {/* Per-lane captions under the 12-s track */}
          <div className="h-8 flex flex-col justify-center gap-0.5">
            <AnimatePresence mode="wait" initial={false}>
              {slowClosed && !slowMissed && (
                <motion.p
                  key="slow-closed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="text-xs text-ink-3"
                >
                  Closed. The bid is still waiting for a block.
                </motion.p>
              )}
              {slowMissed && (
                <motion.p
                  key="slow-missed"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="text-xs text-ink-3"
                >
                  Missed. It landed 4 s late.
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ── Lane 2: Arc, sub-second blocks ───────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono text-accent-text tracking-wide whitespace-nowrap">Arc, sub-second blocks</span>
            {/* "Back to 0:10" sits beside the clock it explains, never on the track,
                so it cannot cover the bid dot or the close line. Hidden on phones,
                where the caption below already says it and the header has no room. */}
            <span className="flex items-center gap-2">
              <AnimatePresence>
                {arcAccepted && t < 1 && (
                  <motion.span
                    key="ext"
                    initial={{ opacity: 0, x: 6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, transition: { duration: 0.3 } }}
                    className="hidden sm:inline text-[10px] font-semibold font-mono text-warn bg-warn/15 px-1.5 py-0.5 rounded-[3px] whitespace-nowrap"
                  >
                    Back to 0:10
                  </motion.span>
                )}
              </AnimatePresence>
              <MiniClock secsLeft={Math.ceil(arcSecsLeft)} flash={arcFlash} />
            </span>
          </div>

          <div className="relative h-10 bg-surface-2 rounded-[6px] overflow-hidden">
            {/* Dense block tiles */}
            {arcTileSteps.map((ts) => t >= ts && (
              <div
                key={ts}
                className="absolute top-1.5 bottom-1.5 w-[3px] -ml-[1.5px] rounded-[1px] bg-ink-3/40"
                style={{ left: `clamp(3px, ${toPct(ts)}%, calc(100% - 3px))` }}
              />
            ))}

            {/* Close line — jumps to T+6.5 when Arc bid accepted */}
            <div
              className={`absolute top-0 bottom-0 w-px bg-accent/70 ${p > 0 ? 'transition-all duration-300' : ''}`}
              style={{ left: `${arcClosePct}%` }}
            />


            {/* Bid dot */}
            {arcBidVisible && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className={[
                  'absolute top-1/2 -translate-y-1/2 w-3 h-3 -ml-1.5 rounded-full border-2 transition-colors duration-200',
                  arcBidArrived ? 'bg-good border-good/40' : 'bg-accent border-accent/40',
                ].join(' ')}
                style={{ left: `${arcBidX}%` }}
              />
            )}
          </div>

          {/* Per-lane captions under Arc track */}
          <div className="h-8 flex flex-col justify-center gap-0.5">
            <AnimatePresence mode="wait" initial={false}>
              {arcAccepted && !arcSold && (
                <motion.p
                  key="arc-accepted"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="text-xs text-good"
                >
                  Accepted in 0.5 s. Clock back to 0:10.
                </motion.p>
              )}
              {arcSold && (
                <motion.p
                  key="arc-sold"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="text-xs text-good"
                >
                  Sold to the late bidder.
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Watch again */}
        <div className="pt-1">
          <button
            onClick={watchAgain}
            className="text-xs font-medium text-ink-3 hover:text-ink-2 transition-colors underline underline-offset-2"
          >
            {playing ? 'Restart' : 'Watch again'}
          </button>
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
  const bidLogs     = logs.filter(l => l.name === 'Bid' || l.name === 'RelayedBid')
  const relayedLogs = logs.filter(l => l.name === 'RelayedBid')
  const hammerLogs  = logs.filter(l => l.name === 'Hammer')
  const distinctBidders = new Set(bidLogs.map(l => l.args.bidder as string)).size
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
