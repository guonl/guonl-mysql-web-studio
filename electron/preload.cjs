/**
 * 桌面 preload（sandbox 环境必须为 CJS，故保持 .cjs 不参与构建）。
 * 仅暴露受控入口：渲染进程没有任何 Node 能力，
 * SQL 只能通过主进程 mysql-service 执行（contextIsolation 隔离）。
 * - invoke：MySQL RPC（mysql:op → mysql-service）
 * - invokeApp：应用级 RPC（app:op → 系统对话框 / 文件导出等白名单操作）
 * - onMenuAction：订阅原生菜单动作（主进程 menu:action 事件），返回退订函数
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', {
  invoke: (op, args) => ipcRenderer.invoke('mysql:op', { op, args }),
  invokeApp: (op, args) => ipcRenderer.invoke('app:op', { op, args }),
  onMenuAction: (cb) => {
    const handler = (_evt, payload) => cb(payload)
    ipcRenderer.on('menu:action', handler)
    return () => ipcRenderer.removeListener('menu:action', handler)
  },
})
