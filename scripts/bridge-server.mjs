/**
 * 独立 MySQL 桥接器（Chrome 插件模式 / 无 Vite 场景使用）
 *
 * 与 bridge/bridge-core.mjs 共用实现：在独立 Node 进程上提供
 * WebSocket 端点 /__mysql_bridge，用 mysql2 真正执行 SQL。
 *
 * 使用：
 *   npm run bridge                 # 默认端口 5189
 *   npm run bridge -- 6000         # 指定端口
 *   MYSQL_BRIDGE_PORT=6000 npm run bridge
 *
 * 前端连接地址：ws://localhost:5189/__mysql_bridge
 * MySQL 目标白名单：环境变量 MYSQL_BRIDGE_ALLOW（逗号分隔，* 表示任意）
 */

import http from 'node:http'
import { WS_PATH, attachWebSocketServer, log, logAllowList } from '../bridge/bridge-core.mjs'

const argPort = Number(process.argv[2])
const PORT = Number(process.env.MYSQL_BRIDGE_PORT) || (Number.isFinite(argPort) && argPort > 0 ? argPort : 5189)

const server = http.createServer((req, res) => {
  // 健康检查：浏览器访问 http://127.0.0.1:<port>/ 可确认桥接器存活
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, path: WS_PATH, service: 'mysql-bridge' }))
})

attachWebSocketServer(server)

server.listen(PORT, () => {
  log(`独立桥接器已启动：ws://localhost:${PORT}${WS_PATH}`)
  log(`健康检查：http://127.0.0.1:${PORT}/`)
  logAllowList()
})

process.on('SIGINT', () => {
  log('收到退出信号，正在关闭…')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
})
