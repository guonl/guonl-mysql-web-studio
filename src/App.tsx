/* 应用入口：Topbar + Sidebar + Workbench + StatusBar + 全局宿主 */
import { useEffect } from 'react'
import { useStore } from './core/store'
import { IS_EXTENSION } from './core/storage'
import { Sidebar } from './components/Sidebar'
import { Workbench } from './components/Workbench'
import { ToastHost } from './components/Toast'
import { ContextMenuHost, openContextMenu, CtxItem } from './components/ContextMenu'
import { ModalHost } from './components/ModalHost'
import { IconDb, IconGithub, IconPalette } from './components/icons'
import { THEMES } from './core/types'
import type { ThemeId, ThemeMeta } from './core/types'

/* 源码仓库地址 */
const REPO_URL = 'https://github.com/guonl/guonl-mysql-web-studio'

/* 主题色卡（菜单 icon）：左侧大块背景色，右侧上下两小块强调色/关键字色 */
function ThemeSwatch({ t }: { t: ThemeMeta }) {
  return (
    <span style={{ display: 'flex', width: 16, height: 16, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(130,140,160,0.5)', flexShrink: 0 }}>
      <span style={{ width: 7, background: t.swatch[0] }} />
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span style={{ flex: 1, background: t.swatch[1] }} />
        <span style={{ flex: 1, background: t.swatch[2] }} />
      </span>
    </span>
  )
}

/* 主题选择菜单：暗色组在前、亮色组在后，当前主题标 ✓ */
function buildThemeMenu(current: ThemeId): CtxItem[] {
  const item = (t: ThemeMeta): CtxItem => ({
    label: t.id === current ? `${t.name} ✓` : t.name,
    icon: <ThemeSwatch t={t} />,
    onClick: () => useStore.getState().setPrefs({ theme: t.id }),
  })
  return [
    ...THEMES.filter((t) => t.mode === 'dark').map(item),
    { sep: true },
    ...THEMES.filter((t) => t.mode === 'light').map(item),
  ]
}

export function App() {
  const prefs = useStore((s) => s.prefs)
  const runtime = useStore((s) => s.runtime)
  const connections = useStore((s) => s.connections)
  const tabs = useStore((s) => s.tabs)

  /* 主题同步到 <html data-theme data-mode>（CSS 按 data-theme 匹配变量组，data-mode 供极少数明暗特判使用） */
  useEffect(() => {
    const meta = THEMES.find((t) => t.id === prefs.theme) ?? THEMES[0]
    const root = document.documentElement
    root.dataset.theme = meta.id
    root.dataset.mode = meta.mode
  }, [prefs.theme])

  /* 历史锁：兜底拦截触控板双指滑动的后退/前进（Safari 不支持 overscroll-behavior 禁用）。
     手势触发的 popstate 会被立即推回当前地址，始终是同文档切换，页面不刷新、WS 连接不断 */
  useEffect(() => {
    const lock = () => history.pushState(null, '', location.href)
    lock()
    window.addEventListener('popstate', lock)
    return () => window.removeEventListener('popstate', lock)
  }, [])

  /* 侧栏宽度拖拽 */
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = useStore.getState().prefs.sidebarWidth
    const move = (ev: MouseEvent) => {
      const w = Math.max(200, Math.min(520, startW + (ev.clientX - startX)))
      useStore.getState().setPrefs({ sidebarWidth: w })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
  }

  const connectedCount = Object.values(runtime).filter((r) => r.status === 'connected').length
  const currentConn = connections.find((c) => c.id === tabs.find((t) => t.id === useStore.getState().activeTabId)?.connId)
  const currentRt = currentConn ? runtime[currentConn.id] : undefined

  return (
    <div className="app">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="brand">
          <IconDb />
          MySQL Web Studio <span className="ver">v1.0</span>
        </div>
        <div className="topbar-spacer" />
        <a
          className="topbar-link"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          title={`作者 guonl · 源码地址：${REPO_URL.replace('https://', '')}`}
        >
          <IconGithub />
          guonl
        </a>
        <label className="checkbox-row" style={{ fontSize: 12 }} title="单次查询最多返回的行数，超出将被截断">
          行数上限
          <select
            className="select" style={{ height: 26, fontSize: 12 }}
            value={prefs.maxRows}
            onChange={(e) => useStore.getState().setPrefs({ maxRows: Number(e.target.value) })}
          >
            {[200, 1000, 5000, 20000].map((n) => (
              <option key={n} value={n}>{n.toLocaleString()}</option>
            ))}
          </select>
        </label>
        <button
          className="btn sm icon" title="主题配色"
          onClick={(e) => openContextMenu(e, buildThemeMenu(prefs.theme))}
        >
          <IconPalette />
        </button>
      </header>

      {/* 主体 */}
      <div className="main">
        <div style={{ width: prefs.sidebarCollapsed ? 30 : prefs.sidebarWidth, flexShrink: 0, display: 'flex', minHeight: 0 }}>
          <Sidebar />
        </div>
        {!prefs.sidebarCollapsed && <div className="sidebar-resizer" onMouseDown={onResizeStart} />}
        <Workbench />
      </div>

      {/* 状态栏 */}
      <footer className="statusbar">
        <span className="item">
          连接 <b>{connectedCount}</b>/{connections.length}
        </span>
        <span className="sep" />
        {currentConn ? (
          <span className="item">
            {currentConn.name}
            {currentRt?.serverVersion ? <b> · MySQL {currentRt.serverVersion}</b> : null}
            {currentRt?.status === 'connected'
              ? <span className="status-dot connected" style={{ marginLeft: 2 }} />
              : currentRt?.status === 'error'
                ? <span className="status-dot error" style={{ marginLeft: 2 }} title={currentRt.error} />
                : null}
          </span>
        ) : (
          <span className="item" style={{ color: 'var(--text-3)' }}>未选择连接</span>
        )}
        <span className="sep" />
        <span className="item">标签页 <b>{tabs.length}</b></span>
        <span className="spacer" />
        <span className="item" style={{ color: 'var(--text-3)' }}>
          © {new Date().getFullYear()} guonl. 保留所有权利.
        </span>
        <span className="sep" />
        <span className="item" style={{ color: 'var(--text-3)' }}>
          所有数据仅保存在本机（{IS_EXTENSION ? 'chrome.storage' : 'localStorage'}），不经过任何服务器
        </span>
      </footer>

      {/* 全局宿主 */}
      <ToastHost />
      <ContextMenuHost />
      <ModalHost />
    </div>
  )
}
