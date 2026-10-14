import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  // glTF models and HDR environment maps bundle as URL assets (Vite's built-in
  // asset list does not include them)
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.hdr'],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
})
