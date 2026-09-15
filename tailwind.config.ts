import type { Config } from 'tailwindcss';

// Tailwind is used alongside MUI for utility classes; MUI owns the components.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        diffAdd: '#1f8a3b',
        diffDel: '#b3261e',
        diffBgAdd: '#e8f5ec',
        diffBgDel: '#fbe9e7'
      }
    }
  },
  plugins: []
} satisfies Config;
