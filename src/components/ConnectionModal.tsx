/* 连接配置弹窗：新增 / 编辑数据库连接 */
import { useMemo, useState } from 'react'
import { useStore } from '../core/store'
import type { ConnectionConfig, ConnectionType } from '../core/types'
import { uid } from '../core/utils'
import { defaultBridgeUrl, IS_EXTENSION } from '../core/storage'
import { Modal } from './Modal'
import { toast } from './Toast'
import { IconDb, IconPlug } from './icons'

interface Props {
  initial?: ConnectionConfig
  onClose: () => void
}

export function ConnectionModal({ initial, onClose }: Props) {
  const upsertConnection = useStore((s) => s.upsertConnection)
  const [type, setType] = useState<ConnectionType>(initial?.type ?? 'demo')
  const [name, setName] = useState(initial?.name ?? '')
  const [host, setHost] = useState(initial?.host ?? '127.0.0.1')
  const [port, setPort] = useState(String(initial?.port ?? 3306))
  const [user, setUser] = useState(initial?.user ?? 'root')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [remember, setRemember] = useState(initial?.rememberPassword ?? false)
  const [database, setDatabase] = useState(initial?.database ?? '')
  const [wsUrl, setWsUrl] = useState(initial?.wsUrl ?? '')
  const [err, setErr] = useState('')

  const isDemo = type === 'demo'
  const title = useMemo(() => (initial ? '编辑连接' : '新建连接'), [initial])

  const submit = () => {
    if (!name.trim()) { setErr('请填写连接名称'); return }
    if (!isDemo) {
      if (wsUrl.trim() && !/^wss?:\/\//i.test(wsUrl.trim())) { setErr('桥接地址必须以 ws:// 或 wss:// 开头，或留空自动生成'); return }
      if (!host.trim()) { setErr('请填写 MySQL 主机地址'); return }
      const p = Number(port)
      if (!Number.isInteger(p) || p < 1 || p > 65535) { setErr('端口无效'); return }
    }
    const cfg: ConnectionConfig = {
      id: initial?.id ?? uid('conn'),
      name: name.trim(),
      type,
      host: isDemo ? undefined : host.trim(),
      port: isDemo ? undefined : Number(port),
      user: isDemo ? undefined : user.trim(),
      password: isDemo ? undefined : password,
      database: database.trim() || undefined,
      wsUrl: isDemo ? undefined : wsUrl.trim() || undefined,
      rememberPassword: isDemo ? undefined : remember,
      createdAt: initial?.createdAt ?? Date.now(),
    }
    upsertConnection(cfg)
    toast.success(initial ? '连接配置已更新' : '连接已添加')
    onClose()
  }

  return (
    <Modal
      title={title}
      sub={IS_EXTENSION ? '连接配置仅保存在本机 chrome.storage，不会上传' : '连接配置仅保存在本浏览器 localStorage，不会上传'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存</button>
        </>
      }
    >
      <div className="form-grid">
        <div className="conn-type-cards">
          <div className={`type-card ${isDemo ? 'on' : ''}`} onClick={() => setType('demo')}>
            <div className="tc-title"><IconDb /> 演示数据库</div>
            <div className="tc-desc">内置迷你 SQL 引擎与示例数据，无需任何服务，开箱即用</div>
          </div>
          <div className={`type-card ${!isDemo ? 'on' : ''}`} onClick={() => setType('ws')}>
            <div className="tc-title"><IconPlug /> 真实 MySQL</div>
            <div className="tc-desc">
              {IS_EXTENSION
                ? '经独立桥接器（mysql2）连接真实 MySQL，使用前先运行 npm run bridge'
                : '经内置桥接器（mysql2）连接真实 MySQL，随 npm run dev 自动启动'}
            </div>
          </div>
        </div>

        <label className="lbl">连接名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：生产库 / 本地开发" autoFocus />

        {!isDemo && (
          <>
            <details className="adv-opt">
              <summary>高级选项（桥接地址通常无需修改）</summary>
              <div className="adv-body">
                <label className="lbl">桥接地址</label>
                <input className="input" value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder={`留空自动使用 ${defaultBridgeUrl()}`} />
                <div className="form-hint">
                  {IS_EXTENSION
                    ? <>插件模式下桥接器为独立进程，请先运行 <code>npm run bridge</code>（默认端口 5189）；仅当桥接器不在本机或改端口时才需要填写</>
                    : <>桥接器已内嵌在 dev server 中，随 <code>npm run dev</code> 自动启动；仅当页面与桥接不同源时才需要填写</>}
                </div>
              </div>
            </details>

            <label className="lbl">主机</label>
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />

            <label className="lbl">端口</label>
            <input className="input" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="3306" />

            <label className="lbl">用户名</label>
            <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="root" />

            <label className="lbl">密码</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空则无密码" />

            <div className="full checkbox-row" style={{ marginTop: -2 }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} id="chk-remember" />
              <label htmlFor="chk-remember">记住密码（明文保存在本机浏览器中；不勾选则刷新页面后需重新输入）</label>
            </div>
          </>
        )}

        <label className="lbl">默认数据库</label>
        <input className="input" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={isDemo ? '可选，例如 shop' : '可选，连接后自动 USE'} />

        {err && <div className="form-error full">{err}</div>}
      </div>
    </Modal>
  )
}
