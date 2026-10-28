import { Link, useLocation, Outlet } from 'react-router-dom'
import { setNavDirection } from '../App'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useBalance } from 'wagmi'
import { Gavel, Plus, User, Scales, Monitor, Sun, Moon, House } from '@phosphor-icons/react'
import GavelMark from './GavelMark'
import { CHAIN_ID, NETWORK_LABEL } from '../chain'
import { useTheme, ThemeChoice } from '../useTheme'
import { formatUnits } from 'viem'

// Network switching lives in WalletButton: it only appears once a wallet is connected
// on the wrong chain, and wagmi's switchChain adds Arc to the wallet if it is unknown.

// ── Theme segmented control ───────────────────────────────────────────────────
const THEME_OPTIONS: { value: ThemeChoice; Icon: typeof Monitor; label: string }[] = [
  { value: 'system', Icon: Monitor, label: 'System' },
  { value: 'light',  Icon: Sun,     label: 'Light'  },
  { value: 'dark',   Icon: Moon,    label: 'Dark'   },
]

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { choice, setTheme } = useTheme()
  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex items-center rounded-btn border border-line bg-surface-2 p-0.5 gap-0.5"
    >
      {THEME_OPTIONS.map(({ value, Icon, label }) => {
        const active = choice === value
        return (
          <button
            key={value}
            onClick={() => setTheme(value)}
            aria-label={label}
            aria-pressed={active}
            className={`flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-[8px] text-xs font-medium transition-colors min-h-[28px] min-w-[28px] ${
              active ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            <Icon size={14} weight={active ? 'bold' : 'regular'} />
            <span className={compact ? 'sr-only' : 'hidden sm:inline'}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Wallet button ─────────────────────────────────────────────────────────────
function WalletButton() {
  const { address, chainId } = useAccount()
  const { data: bal } = useBalance({ address, chainId: CHAIN_ID, query: { enabled: !!address } })

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, openAccountModal, openChainModal, mounted }) => {
        if (!mounted) return <span className="w-28 h-8 rounded-btn bg-surface-2 animate-pulse" />

        if (!account || !chain) {
          return (
            <button
              onClick={openConnectModal}
              className="px-4 py-2 rounded-btn text-sm font-semibold bg-surface border border-line text-ink hover:bg-surface-2 transition-colors"
            >
              Connect wallet
            </button>
          )
        }

        if (chain.unsupported || chainId !== CHAIN_ID) {
          return (
            <button
              onClick={openChainModal}
              className="px-4 py-2 rounded-btn text-sm font-semibold border border-warn/60 text-warn hover:bg-warn/10 transition-colors"
            >
              Switch to {NETWORK_LABEL}
            </button>
          )
        }

        const balStr = bal ? `${parseFloat(formatUnits(bal.value, bal.decimals)).toFixed(2)} USDC` : ''

        return (
          <button
            onClick={openAccountModal}
            className="flex items-center gap-2 px-3 py-1.5 rounded-btn text-sm font-medium bg-surface border border-line hover:bg-surface-2 transition-colors"
          >
            <span className="font-mono text-xs tabular-nums text-ink-2">
              {account.address.slice(0, 6)}…{account.address.slice(-4)}
            </span>
            {balStr && (
              <span className="font-mono tabular-nums text-xs text-ink">{balStr}</span>
            )}
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}

// ── App nav links ─────────────────────────────────────────────────────────────
const APP_NAV = [
  { to: '/lots',   label: 'Lots',   Icon: House  },
  { to: '/create', label: 'Create', Icon: Plus   },
  { to: '/me',     label: 'Me',     Icon: User   },
  { to: '/proof',  label: 'Proof',  Icon: Scales },
] as const

// ── App Layout (with wallet button) ──────────────────────────────────────────
export default function Layout() {
  const loc = useLocation()
  const active = (path: string) =>
    loc.pathname === path || (path !== '/lots' && loc.pathname.startsWith(path))
  const fromPath = loc.pathname

  return (
    <div className="min-h-dvh flex flex-col bg-bg text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-btn focus:bg-surface focus:text-ink focus:border focus:border-line text-sm"
      >
        Skip to content
      </a>

      {/* Desktop top nav */}
      <header className="hidden md:block sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="max-w-[1360px] mx-auto px-8 xl:px-12 h-16 flex items-center justify-between">
          <Link
            to="/"
            viewTransition
            onClick={() => setNavDirection('/', fromPath)}
            className="flex items-center gap-2 font-semibold text-ink hover:text-accent-text transition-colors"
          >
            <GavelMark size={20} className="text-accent" />
            <span className="text-lg tracking-tight">Gavel</span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Main navigation">
            {APP_NAV.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`relative px-4 py-2 text-sm font-medium rounded-btn transition-colors ${
                  active(to) ? 'text-ink' : 'text-ink-2 hover:text-ink hover:bg-surface-2'
                }`}
              >
                {label}
                {active(to) && (
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-4 h-[2px] rounded-full bg-accent" />
                )}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            <WalletButton />
          </div>
        </div>
      </header>

      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="px-4 h-14 flex items-center justify-between">
          <Link
            to="/"
            viewTransition
            onClick={() => setNavDirection('/', fromPath)}
            className="flex items-center gap-2 font-semibold text-ink"
          >
            <GavelMark size={18} className="text-accent" />
            <span className="tracking-tight">Gavel</span>
          </Link>
          <WalletButton />
        </div>
      </header>

      {/* Page content */}
      <main id="main" className="flex-1 max-w-[1360px] mx-auto w-full px-4 md:px-8 xl:px-12 pb-20 md:pb-10">
        <Outlet />
      </main>

      {/* Mobile bottom tab bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-bg/95 backdrop-blur-md"
        aria-label="Tab navigation"
      >
        <div className="flex justify-around h-14">
          {APP_NAV.map(({ to, label, Icon }) => {
            const on = active(to)
            return (
              <Link
                key={to}
                to={to}
                className={`flex flex-col items-center justify-center gap-0.5 flex-1 text-[10px] font-medium transition-colors min-h-[44px] ${
                  on ? 'text-accent' : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                <Icon size={20} weight={on ? 'bold' : 'regular'} />
                {label}
              </Link>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

// ── Landing Layout (no wallet button) ────────────────────────────────────────
export function LandingLayout() {
  const loc = useLocation()
  const fromPath = loc.pathname
  return (
    <div className="min-h-dvh flex flex-col bg-bg text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-btn focus:bg-surface focus:text-ink focus:border focus:border-line text-sm"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="max-w-[1360px] mx-auto px-4 md:px-8 xl:px-12 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 font-semibold text-ink hover:text-accent-text transition-colors">
            <GavelMark size={20} className="text-accent" />
            <span className="text-lg tracking-tight">Gavel</span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            <a
              href="#how-it-works"
              className="px-4 py-2 text-sm font-medium rounded-btn text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors"
            >
              How it works
            </a>
            <Link
              to="/proof"
              className="px-4 py-2 text-sm font-medium rounded-btn text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors"
            >
              Proof
            </Link>
          </nav>

          <div className="flex items-center gap-3">
            <ThemeToggle compact />
            <Link
              to="/lots"
              viewTransition
              onClick={() => setNavDirection('/lots', fromPath)}
              className="px-4 py-2 rounded-btn text-sm font-semibold bg-accent text-accent-ink hover:opacity-90 active:translate-y-px transition-all"
            >
              Open app
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}

/** 404 page */
export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-center gap-6">
      <Gavel size={48} weight="thin" className="text-ink-3" />
      <div>
        <p className="text-5xl font-bold text-ink tabular-nums">404</p>
        <p className="text-ink-2 mt-2">This lot does not exist.</p>
      </div>
      <Link
        to="/lots"
        className="px-5 py-2.5 rounded-btn bg-surface-2 text-ink text-sm font-medium hover:bg-surface transition-colors border border-line"
      >
        Back to lots
      </Link>
    </div>
  )
}
