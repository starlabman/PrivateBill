import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  resolve: {
    // Prefer frontend .ts/.tsx over sibling Node .mjs files in src/
    extensions: ['.tsx', '.ts', '.jsx', '.mts', '.js', '.mjs', '.json'],
  },
  server: { proxy: { '/api': 'http://localhost:8787' } },
  plugins: [react()],
})
