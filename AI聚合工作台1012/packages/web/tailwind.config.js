/**
 * Tailwind 配置。
 * 说明：三家的品牌色主要靠 CSS 变量 + .pv-<provider> 工具类实现（见 styles/index.css），
 * 这里的 colors 只用于少量需要直接引用的场景。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#080b12',
          800: '#0d1220',
          700: '#131a2b',
          600: '#1b2337',
        },
        ds: '#4f6ef7',
        ds2: '#7c3aed',
        db: '#0ea5e9',
        db2: '#14b8a6',
        km: '#64748b',
        km2: '#8b5cf6',
      },
      borderRadius: {
        // 需求：圆角 12px
        xl: '12px',
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Microsoft YaHei',
          'PingFang SC',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'Consolas', 'Menlo', 'monospace'],
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        sheen: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fadeIn .22s ease-out both',
        blink: 'blink 1s step-end infinite',
        sheen: 'sheen 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
