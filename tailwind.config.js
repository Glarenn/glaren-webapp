/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: '#1E2229',
          card: '#262B35',
          input: '#1A1D24',
          primary: '#F27A1A',
          primaryHover: '#FF9838',
          border: '#38404B',
          textMain: '#FFFFFF',
          textMuted: '#A0AAB5',
          textPlaceholder: '#626D7A'
        }
      }
    },
  },
  plugins: [],
}