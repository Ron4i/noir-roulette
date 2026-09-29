import { defineConfig } from 'vite';

const SERVER_PORT = process.env.SERVER_PORT || process.env.PORT || 3001;
const API_TARGET = `http://localhost:${SERVER_PORT}`;

/**
 * Корень клиента — client/, там же лежат index.html и исходники модулей.
 * В dev Vite поднимает его сам и проксирует /api и /ws на игровой сервер.
 * В build собирает client/ в dist/, который потом отдаёт сам Express.
 */
export default defineConfig({
  root: 'client',
  base: '/',
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
