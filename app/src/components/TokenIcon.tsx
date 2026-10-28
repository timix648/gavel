/**
 * TokenIcon — round token logo.
 *
 * Known Arc mainnet tokens use bundled SVG files from /tokens/.
 * Any other address gets a letter-badge whose colour is derived from the address.
 */

// Known token map: lowercase address → logo path
const KNOWN: Record<string, string> = {
  '0x3600000000000000000000000000000000000000': '/tokens/usdc.svg',  // USDC (native on Arc)
  '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1': '/tokens/eurc.svg',  // EURC
}

// Generate a hue (0-360) from an address so unknown tokens get a stable colour
function addrHue(address: string): number {
  const hex = address.replace('0x', '').toLowerCase()
  let h = 0
  for (let i = 0; i < Math.min(8, hex.length); i++) h = (h * 31 + parseInt(hex[i], 16)) & 0xffffff
  return h % 360
}

// 1-2 uppercase letters for the badge
function badge(symbol: string | undefined, address: string): string {
  if (symbol && symbol.length > 0) return symbol.slice(0, 2).toUpperCase()
  // Fall back to last 2 hex chars of address
  const clean = address.replace('0x', '')
  return clean.slice(-2).toUpperCase()
}

interface Props {
  address: string
  symbol?: string
  size?: number   // px; default 20
  className?: string
}

export default function TokenIcon({ address, symbol, size = 20, className = '' }: Props) {
  const key = address.toLowerCase()
  const logoSrc = KNOWN[key]

  const style: React.CSSProperties = { width: size, height: size, minWidth: size }

  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt={symbol ?? address}
        style={style}
        className={`rounded-full object-contain ${className}`}
        loading="lazy"
      />
    )
  }

  // Letter badge with address-derived hue
  const hue = addrHue(address)
  const bg  = `hsl(${hue} 55% 52%)`
  const fg  = 'white'
  const fontSize = Math.max(7, Math.round(size * 0.38))

  return (
    <span
      aria-label={symbol ?? address}
      style={{ ...style, background: bg, color: fg, fontSize, lineHeight: `${size}px` }}
      className={`rounded-full flex items-center justify-center font-semibold select-none shrink-0 ${className}`}
    >
      {badge(symbol, address)}
    </span>
  )
}
