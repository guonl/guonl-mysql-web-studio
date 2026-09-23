import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mysqlBridge from './plugins/vite-plugin-mysql-bridge.mjs'

export default defineConfig({
  plugins: [react(), mysqlBridge()],
  server: { port: 5188, host: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
})
