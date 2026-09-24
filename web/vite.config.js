import { defineConfig } from 'vite';
import { resolve } from 'path';
import { variablesConfig } from './scripts/variables-config.mjs';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/hawaii-appleseed-dashboard/' : '/',
  root: '.',
  publicDir: 'public',
  // /config/variables.json is built from src/config/variables.json, which
  // this also checks (a broken entry fails the build).
  plugins: [variablesConfig()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        factsheet: resolve(__dirname, 'factsheet.html'),
        analysis: resolve(__dirname, 'data-analysis.html'),
      },
    },
  },
  server: {
    port: 5173,
    open: true,
    host: '0.0.0.0',
  },
}));
