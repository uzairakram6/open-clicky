import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.html')
    }
  }
});
