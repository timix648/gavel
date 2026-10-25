/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist Sans', 'Geist', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'GeistMono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        btn:    '10px',
        input:  '10px',
        panel:  '16px',
        tag:    '6px',
      },
      colors: {
        bg:            ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--bg) / ${opacityValue})` : 'rgb(var(--bg))',
        surface:       ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--surface) / ${opacityValue})` : 'rgb(var(--surface))',
        'surface-2':   ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--surface-2) / ${opacityValue})` : 'rgb(var(--surface-2))',
        line:          ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--line) / ${opacityValue})` : 'rgb(var(--line))',
        ink:           ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--ink) / ${opacityValue})` : 'rgb(var(--ink))',
        'ink-2':       ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--ink-2) / ${opacityValue})` : 'rgb(var(--ink-2))',
        'ink-3':       ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--ink-3) / ${opacityValue})` : 'rgb(var(--ink-3))',
        accent:        ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--accent) / ${opacityValue})` : 'rgb(var(--accent))',
        'accent-text': ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--accent-text) / ${opacityValue})` : 'rgb(var(--accent-text))',
        'accent-ink':  ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--accent-ink) / ${opacityValue})` : 'rgb(var(--accent-ink))',
        good:          ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--good) / ${opacityValue})` : 'rgb(var(--good))',
        warn:          ({ opacityValue }) => opacityValue !== undefined ? `rgb(var(--warn) / ${opacityValue})` : 'rgb(var(--warn))',
      },
      animation: {
        'pulse-once': 'pulseOnce 600ms ease-out forwards',
        'slide-in':   'slideIn 180ms ease-out forwards',
        'strike':     'strike 400ms cubic-bezier(.34,1.56,.64,1) forwards',
      },
      keyframes: {
        pulseOnce: {
          '0%':   { borderColor: 'rgb(var(--warn))', boxShadow: '0 0 0 0 rgb(var(--warn) / .5)' },
          '50%':  { borderColor: 'rgb(var(--warn))', boxShadow: '0 0 0 6px rgb(var(--warn) / 0)' },
          '100%': { borderColor: 'rgb(var(--line))' },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        strike: {
          from: { transform: 'translateY(-12px) rotate(-20deg)', opacity: '0' },
          to:   { transform: 'translateY(0) rotate(0deg)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
