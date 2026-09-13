import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  base: './', // GitHub Pages ve Netlify için rölatif path (veya '/repo-adi/' şeklinde değiştirilebilir)
  build: {
    outDir: 'dist',
  },
  server: {
    watch: {
      ignored: ['**/docs/**', '**/*.xlsx', '**/*.csv']
    }
  }
})
