import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initStorage } from './core/storage'
import './styles/global.css'

/* 插件模式需在渲染前预载 chrome.storage 数据（Web 模式为同步空操作） */
initStorage().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
