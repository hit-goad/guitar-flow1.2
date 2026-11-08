import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { alphaTab as alphaTabPlugin } from '@coderline/alphatab-vite/alphaTabVitePlugin';

// alphaTab 需要官方 Vite 插件来正确处理 Web Worker / AudioWorklet 与字体资源。
export default defineConfig({
  base: './',
  plugins: [react(), alphaTabPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    exclude: ['@coderline/alphatab'],
  },
  worker: {
    format: 'es',
  },
});