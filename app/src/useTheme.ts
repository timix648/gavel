/**
 * Three-way theme: 'system' | 'light' | 'dark'
 * Stored in localStorage under 'gavel-theme'.
 * 'system' (default) follows prefers-color-scheme live.
 * Sets data-theme on <html> so CSS tokens switch instantly.
 */
import { useState, useEffect, useCallback } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem('gavel-theme')
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage blocked */ }
  return 'system'
}

function writeStored(t: ThemeChoice) {
  try { localStorage.setItem('gavel-theme', t) } catch { /* noop */ }
}

/** Apply the resolved theme (light or dark) to <html data-theme>. */
function applyResolved(choice: ThemeChoice) {
  const el = document.documentElement
  if (choice === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    el.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
  } else {
    el.setAttribute('data-theme', choice)
  }
}

export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored)

  // Apply on mount and whenever choice changes
  useEffect(() => {
    applyResolved(choice)
  }, [choice])

  // Live-follow system preference when choice === 'system'
  useEffect(() => {
    if (choice !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyResolved('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [choice])

  const setTheme = useCallback((t: ThemeChoice) => {
    writeStored(t)
    setChoiceState(t)
  }, [])

  return { choice, setTheme }
}
