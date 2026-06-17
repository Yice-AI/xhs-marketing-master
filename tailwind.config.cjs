module.exports = {
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './contexts/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
    './styles/**/*.css',
    './utils/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        xhs: {
          red: '#ff2442',
          dark: '#e01b36',
          surface: '#08050a',
          panel: '#0f0a15',
          card: '#140f1d',
        },
        primary: '#ff2442',
        'background-dark': '#0f1115',
        'surface-dark': '#18181b',
      },
      fontFamily: {
        sans: ['Spline Sans', 'Noto Sans SC', 'sans-serif'],
      },
      aspectRatio: {
        iphone: '9 / 19.5',
      },
    },
  },
  plugins: [],
};
