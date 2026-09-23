/**
 * 内嵌 MySQL 桥接插件（Vite dev server 的一部分）
 *
 * 原理：浏览器安全模型禁止网页直连 TCP，本插件在 Vite dev server 上挂一个
 * WebSocket 端点 /__mysql_bridge，用 Node 生态标准库 mysql2 真正执行 SQL，
 * 通过 WebSocket 传输 JSON 结果。协议、认证、分包、超时全部由 mysql2 处理。
 *
 * 使用：npm run dev 一条命令即自动生效，无需单独启动任何进程。
 * 桥接地址与页面同源同端口：ws://<dev主机>/__mysql_bridge
 *
 * 桥接实现位于 bridge/bridge-core.mjs（与独立桥接器 scripts/bridge-server.mjs 共用）。
 */

import { WS_PATH, attachWebSocketServer, log, logAllowList } from '../bridge/bridge-core.mjs'

/** @returns {import('vite').Plugin} */
export default function mysqlBridgePlugin() {
  return {
    name: 'mysql-web-studio-bridge',
    apply: 'serve',
    configureServer(server) {
      // 非桥接路径的 upgrade（HMR 等）不做处理，由 Vite 自身的监听器接管
      attachWebSocketServer(server.httpServer)

      log(`已内嵌启动，桥接地址 ws://<dev主机>${WS_PATH}（与页面同端口）`)
      logAllowList()
    },
  }
}
