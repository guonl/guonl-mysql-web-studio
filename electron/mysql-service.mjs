/**
 * 桌面客户端 MySQL 服务（Electron 主进程）
 *
 * 渲染进程经 preload 暴露的 desktopBridge.invoke(op, args) 调到这里；
 * 连接与 SQL 执行逻辑直接复用 bridge-core（与 WS 桥同一套 mysql2 实现）。
 * 桌面形态下用户完全拥有应用，无需 WS 桥的主机白名单限制。
 * 协议与 WS 桥对齐：op ∈ connect / query / close。
 */
import { createMysqlConn, execQueryOnConn, isDeadConnError } from '../bridge/bridge-core.mjs'

/** connId -> { conn, serverVersion, opts } */
const conns = new Map()

/** 只读语句：重连后可透明重试；写语句无法确认是否已执行过，只重连并提示用户重发 */
function isReadOnlySql(sql) {
  return /^\s*(SELECT|SHOW|DESC|DESCRIBE|EXPLAIN|WITH)\b/i.test(sql)
}

async function opConnect({ connId, host = '127.0.0.1', port = 3306, user = 'root', password = '', database } = {}) {
  if (!connId) throw Object.assign(new Error('缺少 connId'), { code: 0 })
  await opClose({ connId }) // 幂等：重连前先清理旧连接
  const opts = { host, port, user, password, database }
  const { conn, serverVersion } = await createMysqlConn(opts)
  conns.set(connId, { conn, serverVersion, opts })
  return { serverVersion }
}

async function opQuery({ connId, sql, schema } = {}) {
  const rec = conns.get(connId)
  if (!rec) throw Object.assign(new Error('尚未连接数据库，请重新连接'), { code: 0 })
  const text = String(sql ?? '')
  if (!text.trim()) throw Object.assign(new Error('SQL 为空'), { code: 0 })
  const run = async () => {
    if (schema) await rec.conn.query(`USE \`${String(schema).replace(/`/g, '``')}\``)
    return await execQueryOnConn(rec.conn, text)
  }
  try {
    return await run()
  } catch (e) {
    /* 空闲后被服务器/NAT 掐断的半开连接会报 read ETIMEDOUT 等死连接错误：
       自动重建连接，只读语句透明重试一次；写语句不重试，提示用户重新执行 */
    if (!isDeadConnError(e) || !rec.opts) throw e
    console.log('[mysql-service] 连接已失效，自动重连…')
    try { rec.conn.destroy() } catch { /* noop */ }
    const created = await createMysqlConn(rec.opts)
    rec.conn = created.conn
    rec.serverVersion = created.serverVersion
    if (isReadOnlySql(text)) {
      return await run()
    }
    throw Object.assign(new Error('连接已失效，已自动重连成功；写操作无法确认此前是否已执行，请重新执行本条 SQL'), { code: 0 })
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
