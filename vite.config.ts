import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks: (id) => id.includes('@xyflow') || id.includes('d3-') ? 'flow' : id.includes('node_modules/react') ? 'react' : id.includes('node_modules/zod') ? 'zod' : undefined } } },
});
