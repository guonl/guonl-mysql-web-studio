import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mysqlBridge from './plugins/vite-plugin-mysql-bridge.mjs'

export default defineConfig(({ command }) => ({
  // 生产构建用相对路径：Electron 打包后经 file:// 加载 dist/index.html，
  // 默认的绝对路径 /assets/... 会指向磁盘根目录导致白屏（dev server 不受影响）
  base: command === 'build' ? './' : '/',
  plugins: [react(), mysqlBridge()],
  server: { port: 5188, host: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
}))
