/*
 *  ███████╗████████╗██╗   ██╗██████╗ ██╗ ██████╗
 *  ██╔════╝╚══██╔══╝██║   ██║██╔══██╗██║██╔═══██╗
 *  ███████╗   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ╚════██║   ██║   ██║   ██║██║  ██║██║██║   ██║
 *  ███████║   ██║   ╚██████╔╝██████╔╝██║╚██████╔╝
 *  ╚══════╝   ╚═╝    ╚═════╝ ╚═════╝ ╚═╝ ╚═════╝
 *
 *  Built with Arc Studio
 *  https://studio.arc.io
 */

import './tracing'
import './console-capture'
import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/geist-sans/700.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@rainbow-me/rainbowkit/styles.css'

import { StrictMode, useMemo, useSyncExternalStore } from 'react'
import { IconContext } from '@phosphor-icons/react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RainbowKitProvider,
  darkTheme,
  lightTheme,
} from '@rainbow-me/rainbowkit'
import { Toaster } from 'sonner'
import { config } from './config'
import { useTheme } from './useTheme'
import { CHAIN_ID } from './chain'
import App from './App'
import './index.css'

const queryClient = new QueryClient()

// Studio logo SVG
const StudioLogo = () => (
  <svg width="14" height="16" viewBox="0 0 20 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 21.5001C0.167192 16.2366 1.02308 11.3243 2.45378 7.50459C4.26573 2.66517 6.88869 0 9.83904 0C12.7894 0 15.412 2.66517 17.2243 7.50459C18.1669 10.0216 18.8605 13.0121 19.2713 16.2655C19.3081 16.556 19.3393 16.8513 19.3714 17.146C19.3819 17.1642 19.3881 17.1811 19.386 17.1949C19.386 17.1949 19.6275 18.7674 19.6788 21.5001H19.6515C19.2934 21.1937 15.0694 17.7329 8.06739 18.735C8.17304 17.4996 8.31833 16.2974 8.50603 15.1452C8.51562 15.0863 8.52671 15.0294 8.53649 14.9709C11.2828 14.8846 13.6866 15.2171 15.5299 15.6529C15.5231 15.6073 15.5173 15.5603 15.5103 15.5149C15.1314 13.0547 14.5724 10.8024 13.8517 8.87761C12.6732 5.73037 11.1354 3.77496 9.83904 3.77496C8.54269 3.77496 7.00493 5.73037 5.82649 8.87761C5.54123 9.63889 5.28154 10.4508 5.04866 11.3071C4.72126 12.507 4.44621 13.7934 4.22654 15.1451C3.90141 17.1412 3.69827 19.2821 3.62345 21.5001H0Z" fill="currentColor"/>
  </svg>
)

/** Studio watermark — inline footer link, uses design tokens, no inline styles */
export const StudioWatermark = () => (
  <a
    href="https://studio.arc.io/"
    target="_blank"
    rel="noopener noreferrer"
    className="inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-accent-text transition-colors"
  >
    <StudioLogo />
    Built with Arc Studio
  </a>
)

// ── Root: hooks for theme ─────────────────────────────────────────────────────
// The resolved theme lives in <html data-theme>. useTheme() keeps separate state per
// component, so Root watches the attribute itself: any toggle (or the OS, in System
// mode) re-themes the wallet modal immediately.
function subscribeTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => obs.disconnect()
}
const readIsDark = () => document.documentElement.getAttribute('data-theme') !== 'light'

function Root() {
  useTheme() // applies the stored choice on first mount
  const isDark = useSyncExternalStore(subscribeTheme, readIsDark, readIsDark)

  // RainbowKit theme bound to our CSS variables. Every colour, text included, points at
  // a token, so the modal always matches the page even if the base preset lags.
  const rbkTheme = useMemo(() => {
    const opts = { accentColor: 'rgb(var(--accent))', accentColorForeground: 'rgb(var(--accent-ink))', borderRadius: 'medium', fontStack: 'system' } as const
    const base = isDark ? darkTheme(opts) : lightTheme(opts)
    return {
      ...base,
      colors: {
        ...base.colors,
        modalBackground:     `rgb(var(--surface))`,
        modalBackdrop:       isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(22, 22, 20, 0.35)',
        modalBorder:         `rgb(var(--line))`,
        modalText:           `rgb(var(--ink))`,
        modalTextSecondary:  `rgb(var(--ink-2))`,
        modalTextDim:        `rgb(var(--ink-3))`,
        menuItemBackground:  `rgb(var(--surface-2))`,
        generalBorder:       `rgb(var(--line))`,
        generalBorderDim:    `rgb(var(--line))`,
        profileForeground:   `rgb(var(--surface))`,
        profileAction:       `rgb(var(--surface-2))`,
        profileActionHover:  `rgb(var(--line))`,
        actionButtonBorder:  `rgb(var(--line))`,
        actionButtonBorderMobile: `rgb(var(--line))`,
        actionButtonSecondaryBackground: `rgb(var(--surface-2))`,
        closeButton:         `rgb(var(--ink-2))`,
        closeButtonBackground: `rgb(var(--surface-2))`,
        connectButtonBackground: `rgb(var(--surface))`,
        connectButtonInnerBackground: `rgb(var(--surface-2))`,
        connectButtonText:   `rgb(var(--ink))`,
        selectedOptionBorder: `rgb(var(--accent))`,
        downloadBottomCardBackground: `rgb(var(--surface))`,
        downloadTopCardBackground: `rgb(var(--surface-2))`,
      },
      fonts: { body: '"Geist Sans", system-ui, sans-serif' },
      radii: {
        ...base.radii,
        modal: '16px',
        menuButton: '10px',
        connectButton: '10px',
        actionButton: '10px',
      },
    }
  }, [isDark])

  return (
    <RainbowKitProvider
      theme={rbkTheme}
      appInfo={{
        appName: 'Gavel',
        learnMoreUrl: 'https://github.com/timix648/gavel',
      }}
      modalSize="compact"
      initialChain={CHAIN_ID}
    >
      <App />
      <Toaster position="top-center" />
    </RainbowKitProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Global icon defaults: light weight, 20 px. Per-icon overrides still work. */}
    <IconContext.Provider value={{ weight: 'light', size: 20 }}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <Root />
        </QueryClientProvider>
      </WagmiProvider>
    </IconContext.Provider>
  </StrictMode>,
)
