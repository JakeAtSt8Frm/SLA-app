import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  /*
   * Relative base so the built bundle works from any path — a project page at
   * /SLA/, a user page at /, or opened straight off disk. Combined with the
   * HashRouter in main.tsx this means no server rewrite rules are needed.
   */
  base: './',

  build: {
    // Recharts is large and only the modal and history page need it, so keeping
    // it in its own chunk lets the first paint skip it.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          if (id.includes('react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
