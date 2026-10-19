import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initStorage } from './core/storage'
import { initDesktopMenuActions } from './core/desktop'
import './styles/global.css'

/* 插件模式需在渲染前预载 chrome.storage 数据（Web 模式为同步空操作） */
initStorage().then(() => {
  /* 桌面模式：接入原生菜单动作（打开 / 导出 SQL 文件）；其余形态为空操作 */
  initDesktopMenuActions()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
