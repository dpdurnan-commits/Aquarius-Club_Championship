import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server (this Vite instance) and the API/SSE backend run on separate
// ports during local development, whereas in production the backend serves the
// built frontend from a single origin. The frontend always calls same-origin
// relative paths (`/api/...`, including the `/api/events` SSE stream), so we
// proxy those to the backend in dev. That keeps the client code identical
// across dev and prod. The backend dev port defaults to 3001 but honors a
// `SERVER_PORT` env var so it can be overridden alongside the server's `PORT`.
const backendPort = Number.parseInt(process.env.SERVER_PORT ?? '', 10) || 3001;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        // Server-Sent Events are a long-lived streaming response; disabling
        // buffering keeps `/api/events` flowing through the proxy in real time.
        ws: true,
      },
    },
  },
});
