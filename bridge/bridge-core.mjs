/**
 * MySQL 桥接核心（Web 与 Chrome 插件两种模式共用的实现）
 *
 * 浏览器安全模型禁止网页直连 TCP，本模块在 Node 侧用 mysql2 真正执行 SQL，
 * 通过 WebSocket 传输 JSON 结果。协议：{id, op, args} 请求 / {id, ok, data|error} 响应。
 *
 * 两个入口复用本模块：
 * - plugins/vite-plugin-mysql-bridge.mjs：挂到 Vite dev server（Web 开发模式）
 * - scripts/bridge-server.mjs：独立 Node 进程（Chrome 插件模式 / 生产部署）
 *
 * 安全：默认仅允许本机访问的 MySQL 目标不做限制；如需白名单可设环境变量
 * MYSQL_BRIDGE_ALLOW（逗号分隔主机，或 * 表示任意）。
 */

import { WebSocketServer } from 'ws'
import mysql from 'mysql2/promise'

export const WS_PATH = '/__mysql_bridge'

export function log(...args) {
  console.log(new Date().toLocaleTimeString(), '[mysql-bridge]', ...args)
}

/** 目标主机白名单（空 = 不限制） */
const allowList = (process.env.MYSQL_BRIDGE_ALLOW || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
const allowAll = allowList.includes('*')

function hostAllowed(host) {
  if (allowAll || allowList.length === 0) return true
  return allowList.some((h) => (h === 'localhost' ? '127.0.0.1' : h) === (host === 'localhost' ? '127.0.0.1' : host))
}

export function logAllowList() {
  if (allowList.length > 0 && !allowAll) log(`目标白名单: ${allowList.join(', ')}`)
}

const qesc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "''")

/** mysql2 字段 → 内部列元数据（含用于查注释的原始表/列名） */
function toColumnMeta(f) {
  const NOT_NULL = 1, PRI_KEY = 2, UNIQUE_KEY = 4, MULTIPLE_KEY = 8
  const flags = f.flags || 0
  const key = (flags & PRI_KEY) ? 'PRI' : (flags & UNIQUE_KEY) ? 'UNI' : (flags & MULTIPLE_KEY) ? 'MUL' : ''
  return {
    name: f.name,
    orgName: f.orgName || f.name,
    table: f.orgTable || f.table || '',
    schema: f.schema || '',
    type: String(f.type || ''),
    nullable: !(flags & NOT_NULL),
    key,
  }
}

/** 批量补齐字段注释（information_schema.COLUMNS.COLUMN_COMMENT） */
async function enrichComments(conn, cols) {
  const tableKeys = new Set()
  for (const c of cols) {
    if (c.schema && c.table && c.orgName) tableKeys.add(`${c.schema}\u0000${c.table}`)
  }
  if (!tableKeys.size) return
  const pairs = [...tableKeys].map((k) => {
    const [s, t] = k.split('\u0000')
    return `('${qesc(s)}', '${qesc(t)}')`
  })
  const [crows] = await conn.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE (TABLE_SCHEMA, TABLE_NAME) IN (${pairs.join(', ')})`,
  )
  const cmap = new Map()
  for (const r of crows) cmap.set(`${r[0]}\u0000${r[1]}\u0000${r[2]}`, String(r[3] ?? ''))
  for (const c of cols) {
    if (c.schema && c.table && c.orgName) {
      c.comment = cmap.get(`${c.schema}\u0000${c.table}\u0000${c.orgName}`) || ''
    }
  }
}

/** 内部列元数据 → 发往前端的精简结构 */
function toWireColumn(c) {
  return {
    name: c.name,
    /* 原始列名（SELECT id AS uid 时 orgName=id），按主键生成 UPDATE 必须用它 */
    orgName: c.orgName || c.name,
    type: c.type,
    nullable: c.nullable,
    key: c.key,
    comment: c.comment || '',
    /* 结果集编辑需要定位来源表（按主键生成 UPDATE） */
    table: c.table || '',
    schema: c.schema || '',
  }
}

/** 单个 WS 会话 = 一条 mysql2 连接（作为 ws 的 connection 处理器使用） */
export async function handleSession(ws) {
  /** @type {import('mysql2/promise').Connection | null} */
  let conn = null
  let serverVersion = ''
  let closed = false

  const send = (obj) => {
    if (!closed && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  }

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send({ id: 0, ok: false, error: { code: 0, message: '无效的 JSON 消息' } })
      return
    }
    const { id, op, args } = msg || {}
    try {
      if (op === 'connect') {
        const { host = '127.0.0.1', port = 3306, user = 'root', password = '', database } = args || {}
        if (!hostAllowed(host)) {
          throw Object.assign(new Error(`目标 ${host} 不在 MYSQL_BRIDGE_ALLOW 白名单中`), { code: 0 })
        }
        log(`连接 ${user}@${host}:${port}${database ? '/' + database : ''}`)
        conn = await mysql.createConnection({
          host, port: Number(port), user, password,
          database: database || undefined,
          connectTimeout: 10_000,
          charset: 'utf8mb4',
          dateStrings: true, // 日期按字符串返回，避免时区歧义
          rowsAsArray: true, // 与前端 ExecResult.rows: unknown[][] 对齐
        })
        const [vrows] = await conn.query('SELECT VERSION()')
        serverVersion = Array.isArray(vrows?.[0]) ? String(vrows[0][0]) : ''
        log(`已连接 ${host}:${port}（server ${serverVersion}）`)
        send({ id, ok: true, data: { serverVersion } })
        return
      }

      if (op === 'query') {
        if (!conn) throw Object.assign(new Error('尚未连接数据库'), { code: 0 })
        const sql = String(args?.sql ?? '')
        if (!sql.trim()) throw Object.assign(new Error('SQL 为空'), { code: 0 })
        const [rows, fields] = await conn.query(sql)
        const isResultSet = Array.isArray(rows) && Array.isArray(fields)
        let columns = []
        if (isResultSet) {
          columns = (fields || []).map(toColumnMeta)
          try { await enrichComments(conn, columns) } catch { /* 注释获取失败不影响结果展示 */ }
          columns = columns.map(toWireColumn)
        }
        send({
          id,
          ok: true,
          data: isResultSet
            ? {
                columns,
                rows: rows || [],
                rowCount: (rows || []).length,
                affected: 0,
                info: '',
              }
            : { columns: [], rows: [], rowCount: 0, affected: Number(rows?.affectedRows ?? 0), info: String(rows?.info ?? '') },
        })
        return
      }

      if (op === 'close') {
        teardown()
        return
      }

      send({ id, ok: false, error: { code: 0, message: `未知操作 ${op}` } })
    } catch (e) {
      const err = e || {}
      // mysql2 连接级致命错误：断开底层连接，前端需重连
      if (err.fatal && conn) {
        try { conn.destroy() } catch { /* noop */ }
        conn = null
      }
      send({
        id,
        ok: false,
        error: {
          code: err.errno ?? err.code ?? 0,
          message: err.message || String(e),
          fatal: !!err.fatal,
        },
      })
    }
  })

  function teardown() {
    if (closed) return
    closed = true
    if (conn) {
      try { conn.destroy() } catch { /* noop */ }
      conn = null
    }
    try { ws.close() } catch { /* noop */ }
  }

  ws.on('close', () => {
    log('会话关闭')
    teardown()
  })
  ws.on('error', () => teardown())
}

/** 通用升级分发：在给定 http server 上挂 WS 端点（其余 upgrade 请求原样交回） */
export function attachWebSocketServer(httpServer, { path = WS_PATH, onPath } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  wss.on('connection', handleSession)
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== path) {
      onPath?.(req, socket, head) // 非 WS_PATH 的 upgrade（如 HMR）交还给调用方
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  return wss
}
