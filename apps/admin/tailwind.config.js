/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px'
      }
    },
    extend: {
      colors: {
        border: '#E2E8F0',
        input: '#E2E8F0',
        ring: '#22C55E',
        background: '#FAFAFA',
        foreground: '#0F172A',
        // "Bold bento" accents shared with the public home page (apps/web/src/components/home-bento/tokens.ts)
        bento: {
          ink: '#111111',
          lime: '#C6F432',
          limeDim: '#A3CC1F',
          orange: '#FF5C35'
        },
        nidar: {
          green: '#22C55E',
          greenDark: '#15803D',
          greenLight: '#DCFCE7',
          sidebar: '#111625',
          sidebarHover: '#1E2538',
          card: '#FFFFFF',
          textMuted: '#64748B'
        }
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
};
