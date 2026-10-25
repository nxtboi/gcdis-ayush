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
        // Home page "bold bento" palette (components/home-bento)
        bento: {
          ink: '#111111',
          paper: '#F2F2EC',
          lime: '#C6F432',
          orange: '#FF5C35',
          panel: '#1C1C1C',
          line: '#333333',
          muted: '#52525B'
        },
        nidar: {
          green: '#22C55E',
          greenDark: '#16A34A',
          greenLight: '#DCFCE7',
          sidebar: '#111625',
          sidebarHover: '#1E2538',
          card: '#FFFFFF',
          textMuted: '#64748B'
        }
      },
      keyframes: {
        ticker: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' }
        }
      },
      animation: {
        ticker: 'ticker 45s linear infinite'
      },
      fontFamily: {
        impact: ['Impact', 'Arial Black', 'sans-serif'],
        sans: ['var(--font-sans)', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
};
