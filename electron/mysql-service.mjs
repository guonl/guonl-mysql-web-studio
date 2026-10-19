/**
 * 桌面客户端 MySQL 服务（Electron 主进程）
 *
 * 渲染进程经 preload 暴露的 desktopBridge.invoke(op, args) 调到这里；
 * 连接与 SQL 执行逻辑直接复用 bridge-core（与 WS 桥同一套 mysql2 实现）。
 * 桌面形态下用户完全拥有应用，无需 WS 桥的主机白名单限制。
 * 协议与 WS 桥对齐：op ∈ connect / query / close。
 */
import { createMysqlConn, execQueryOnConn } from '../bridge/bridge-core.mjs'

/** connId -> { conn, serverVersion } */
const conns = new Map()

async function opConnect({ connId, host = '127.0.0.1', port = 3306, user = 'root', password = '', database } = {}) {
  if (!connId) throw Object.assign(new Error('缺少 connId'), { code: 0 })
  await opClose({ connId }) // 幂等：重连前先清理旧连接
  const { conn, serverVersion } = await createMysqlConn({ host, port, user, password, database })
  conns.set(connId, { conn, serverVersion })
  return { serverVersion }
}

async function opQuery({ connId, sql, schema } = {}) {
  const rec = conns.get(connId)
  if (!rec) throw Object.assign(new Error('尚未连接数据库，请重新连接'), { code: 0 })
  const text = String(sql ?? '')
  if (!text.trim()) throw Object.assign(new Error('SQL 为空'), { code: 0 })
  try {
    if (schema) await rec.conn.query(`USE \`${String(schema).replace(/`/g, '``')}\``)
    return await execQueryOnConn(rec.conn, text)
  } catch (e) {
    // 连接级致命错误：销毁连接并移除，下次操作会得到明确的「请重新连接」提示
    if (e?.fatal) {
      try { rec.conn.destroy() } catch { /* noop */ }
      conns.delete(connId)
    }
    throw e
  }
}

async function opClose({ connId } = {}) {
  const rec = conns.get(connId)
  if (!rec) return {}
  conns.delete(connId)
  try { await rec.conn.end() } catch { try { rec.conn.destroy() } catch { /* noop */ } }
  return {}
}

/** 退出前释放全部数据库连接 */
export function closeAllConns() {
  for (const id of [...conns.keys()]) void opClose({ connId: id })
}

/** 渲染进程 RPC 入口（由 electron/main.mjs 注册到 ipcMain.handle） */
export async function handleMysqlOp(op, args) {
  switch (op) {
    case 'connect': return opConnect(args)
    case 'query': return opQuery(args)
    case 'close': return opClose(args)
    default: throw Object.assign(new Error(`未知操作 ${op}`), { code: 0 })
  }
}
