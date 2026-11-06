import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { rollupOptions: { output: { manualChunks: (id) => id.includes('@xyflow') || /d3-(zoom|drag|selection|transition|dispatch|ease|timer)/.test(id) ? 'flow' : id.includes('node_modules/react') ? 'react' : id.includes('node_modules/zod') ? 'zod' : undefined } } },
});
