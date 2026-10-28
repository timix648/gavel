/**
 * GavelMark — inline SVG brand mark.
 * Uses React.useId() so multiple marks on the same page each get a unique
 * mask id, preventing clashes when the DOM contains the SVG more than once.
 */
import { useId } from 'react'

interface GavelMarkProps {
  size?: number
  className?: string
}

export default function GavelMark({ size = 20, className = '' }: GavelMarkProps) {
  const uid = useId().replace(/:/g, '')
  const maskId = `gavel-cut-${uid}`

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId}>
          <rect width="64" height="64" fill="#fff" />
          <rect x="20.5" y="5" width="2.6" height="26" fill="#000" transform="rotate(45 32 32)" />
          <rect x="40.9" y="5" width="2.6" height="26" fill="#000" transform="rotate(45 32 32)" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`} fill="currentColor">
        <g transform="rotate(45 32 32)">
          <rect x="13" y="8" width="38" height="20" rx="5" />
          <rect x="27" y="27" width="10" height="5" rx="1.5" />
          <rect x="29" y="31" width="6" height="28" rx="3" />
        </g>
      </g>
      <path d="M44 55 A13 13 0 0 0 57 42" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  )
}
