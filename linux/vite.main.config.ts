import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    lib: {
      entry: 'src/main/main.ts',
      formats: ['es'],
      fileName: () => 'main.js'
    },
    rollupOptions: {
      external: [
        'electron',
        'electron-squirrel-startup',
        'node-record-lpcm16',
        'vosk',
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`)
      ]
    }
  }
});
