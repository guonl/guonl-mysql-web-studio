/* 桌面端专属 glue：原生菜单动作 → 应用行为（打开 SQL 文件 / 导出当前 SQL）。
 * 仅桌面环境生效（IS_DESKTOP），Web / 插件形态零影响。 */
import { IS_DESKTOP } from './storage'
import { useStore } from './store'
import { toast } from '../components/Toast'
import type { MenuAction } from '../adapters/ipc'

/** 应用启动时调用一次：订阅主进程菜单事件（幂等，非桌面环境为空操作） */
export function initDesktopMenuActions(): void {
  if (!IS_DESKTOP) return
  window.desktopBridge?.onMenuAction?.((action) => { void handleMenuAction(action) })
}

async function handleMenuAction(action: MenuAction): Promise<void> {
  const st = useStore.getState()
  switch (action.type) {
    /* 文件 → 打开 SQL 文件…：主进程弹系统对话框并读取内容后推送至此，新建标签页承载 */
    case 'open-sql-file': {
      const title = action.name.replace(/\.(sql|txt)$/i, '') || action.name
      st.newTab({ title, sql: action.content })
      toast.success(`已打开 ${action.name}（${action.content.length.toLocaleString()} 字符）`)
      break
    }
    /* 文件 → 导出当前 SQL…：取活动标签页 SQL，主进程弹系统保存对话框并写盘 */
    case 'export-current-sql': {
      const tab = st.tabs.find((t) => t.id === st.activeTabId)
      if (!tab) { toast.warn('没有可导出的标签页'); return }
      if (!tab.sql.trim()) { toast.warn('当前标签页内容为空'); return }
      const filename = `${tab.title.replace(/[\\/:*?"<>|]/g, '_')}.sql`
      const r = await window.desktopBridge?.invokeApp?.('saveTextFile', {
        defaultPath: filename,
        content: tab.sql,
      })
      if (!r?.ok) { toast.error(r?.error?.message ?? '导出失败'); return }
      const data = r.data as { canceled: boolean; path?: string } | undefined
      if (data && !data.canceled && data.path) toast.success(`已导出：${data.path}`)
      break
    }
  }
}
