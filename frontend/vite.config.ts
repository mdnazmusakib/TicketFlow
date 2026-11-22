import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin /api in development so httpOnly auth cookies work without third-party cookie rules.
      proxy: {
        '/api': { target: env.VITE_DEV_API_PROXY ?? 'http://localhost:4000', changeOrigin: true },
      },
    },
    build: {
      sourcemap: mode !== 'production',
      rolldownOptions: {
        // Third-party code in separate long-cached chunks (each under the 500 kB warning).
        output: {
          advancedChunks: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
              { name: 'router', test: /node_modules[\\/](react-router|@remix-run|cookie-es)[\\/]/ },
              { name: 'vendor', test: /node_modules/ },
            ],
          },
        },
      },
    },
  };
});
