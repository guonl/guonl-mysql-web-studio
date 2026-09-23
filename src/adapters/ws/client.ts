/* 浏览器端桥接客户端 —— 与内嵌 Vite 桥接器通信（WS 传 JSON，SQL 由桥接端的 mysql2 执行） */

import type { ColumnMeta, ExecResult } from '../../core/types'

export interface MysqlConnectOpts {
  host: string
  port: number
  user: string
  password: string
  database?: string
}

interface ErrInfo { code: number | string; message: string; fatal?: boolean }

const CONNECT_TIMEOUT = 15_000
const QUERY_TIMEOUT = 60_000
const WS_OPEN_TIMEOUT = 10_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class MysqlClient {
  serverVersion = ''
  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private onUnexpectedClose: (() => void) | null = null

  /** 建立 WS 会话并完成数据库连接认证 */
  async connect(wsUrl: string, opts: MysqlConnectOpts): Promise<{ serverVersion: string }> {
    const base = wsUrl.replace(/\/+$/, '')
    const ws = new WebSocket(base)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket 桥接连接超时，请确认已运行 npm run dev')), WS_OPEN_TIMEOUT)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket 桥接连接失败，请确认已运行 npm run dev 且桥接地址正确'))
      }
    })

    ws.onmessage = (ev) => this.handleMessage(String(ev.data))
    ws.onclose = () => {
      // 会话中断：让所有在途请求失败
      const err = new Error('与桥接器的会话已断开（数据库连接可能中断），请重新连接')
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err) }
      this.pending.clear()
      this.onUnexpectedClose?.()
    }

    const res = await this.call<{ serverVersion: string }>('connect', opts, CONNECT_TIMEOUT, '连接')
    this.serverVersion = res.serverVersion
    return { serverVersion: this.serverVersion }
  }

  /** 断开意外关闭时的回调（由适配器设置，用于刷新 UI 状态） */
  setOnUnexpectedClose(fn: () => void) {
    this.onUnexpectedClose = fn
  }

  async query(sql: string): Promise<ExecResult> {
    const d = await this.call<{
      columns: ColumnMeta[]; rows: unknown[][]; rowCount: number; affected: number; info: string
    }>('query', { sql }, QUERY_TIMEOUT, '查询')
    return { ...d, serverVersion: this.serverVersion }
  }

  close() {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    try { this.send({ id: 0, op: 'close' }) } catch { /* noop */ }
    try { ws.close() } catch { /* noop */ }
  }

  // ---------- 内部 ----------

  private call<T>(op: string, args: unknown, timeoutMs: number, label: string): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('桥接会话未就绪，请重新连接'))
    }
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)}s），数据库可能无响应`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      this.send({ id, op, args })
    })
  }

  private send(obj: unknown) {
    this.ws?.send(JSON.stringify(obj))
  }

  private handleMessage(text: string) {
    let msg: { id: number; ok: boolean; data?: unknown; error?: ErrInfo }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) {
      p.resolve(msg.data)
    } else {
      const e = msg.error ?? { code: 0, message: '未知错误' }
      const err = new Error(e.message)
      Object.assign(err, { code: e.code, fatal: e.fatal })
      p.reject(err)
    }
  }
}
