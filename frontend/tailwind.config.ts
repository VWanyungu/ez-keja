import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// Tokens come from the Figma "Foundations & Components" page; values live in src/index.css.
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: 'hsl(var(--card))',
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        subtle: 'hsl(var(--subtle-foreground))',
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          dark: 'hsl(var(--primary-dark))',
        },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        tint: 'hsl(var(--tint))',
        warning: { DEFAULT: 'hsl(var(--warning))', foreground: 'hsl(var(--warning-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 4px)', sm: 'calc(var(--radius) - 6px)' },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        // CTA and search button: drop shadow plus a soft teal ring (Figma "Button" effect).
        cta: '0 8px 16px -6px rgba(15, 92, 82, 0.28), 0 0 0 3px rgba(15, 92, 82, 0.22)',
        panel: '0 10px 28px -10px rgba(13, 31, 28, 0.07)',
      },
    },
  },
  plugins: [animate],
};

export default config;
