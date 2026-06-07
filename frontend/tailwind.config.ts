import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        heading: ['var(--font-poppins)', 'Poppins', 'system-ui', 'sans-serif'],
        display: ['var(--font-cormorant)', 'Georgia', 'serif'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        gold: {
          DEFAULT: '#C9A24A',
          light: '#E0C27A',
          dark: '#B8963B',
        },
        charcoal: '#1F1F1F',
        'dark-bg': '#0A0A0A',
        'dark-surface': '#141414',
        chart: {
          navy: '#1F3A68',
          teal: '#2E8B7A',
          coral: '#C0654E',
          violet: '#6B5B95',
          sage: '#84A26B',
        },
        status: {
          pos: '#1F7A5A',
          neg: '#B23A48',
          warn: '#C8961A',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      backgroundImage: {
        'gold-gradient': 'linear-gradient(135deg, #E0C27A, #B8963B)',
      },
      boxShadow: {
        'gold-glow': '0 0 10px rgba(201,162,74,0.2)',
        'gold-glow-lg': '0 0 20px rgba(201,162,74,0.3)',
        'card': '0 1px 2px rgba(15,21,37,0.04), 0 2px 8px rgba(15,21,37,0.04)',
        'pop': '0 8px 28px rgba(15,21,37,0.10)',
        'cta': '0 1px 2px rgba(15,21,37,0.18)',
      },
    },
  },
  plugins: [],
}
export default config
