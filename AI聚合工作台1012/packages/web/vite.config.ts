import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
/** 共享包入口（前后端唯一真源的类型与常量） */
const sharedEntry = path.resolve(here, '../shared/src/index.ts');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 精确指向文件而不是目录，避免不同解析器对"目录 index"处理的差异
      '@shared': sharedEntry,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 允许读取 monorepo 内的共享源码
    fs: { allow: [path.resolve(here, '../..')] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
