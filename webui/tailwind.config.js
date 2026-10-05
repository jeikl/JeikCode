/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#3b82f6',
          hover: '#2563eb',
          dark: '#1d4ed8',
        },
        surface: {
          DEFAULT: '#131314',
          container: '#1e1f20',
          elevated: '#282a2c',
        },
      },
    },
  },
  plugins: [],
};
