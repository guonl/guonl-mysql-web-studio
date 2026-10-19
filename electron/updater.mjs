/**
 * 自动更新（electron-updater）
 *
 * - 仅打包版本启用；开发模式直接跳过（日志留痕）
 * - 启动 10s 后静默检查一次；发现新版本自动后台下载，完成后弹窗询问重启安装，
 *   选「稍后」则在退出应用时自动安装（autoInstallOnAppQuit）
 * - 帮助菜单「检查更新…」手动触发：结果（最新 / 有新版 / 失败）用原生对话框反馈
 * - 更新源：构建时由 electron-builder 依据 publish 配置写入 app-update.yml（默认 GitHub
 *   Releases）；运行时可用环境变量 MWS_UPDATE_URL 覆盖为 generic 静态源（自建服务器）
 */
import { app, BrowserWindow, dialog } from 'electron'

const UPDATE_CHECK_DELAY_MS = 10_000

let log = () => {}
let manual = false // 本次检查是否由菜单手动触发（决定是否弹窗反馈结果）
let checking = false
let updaterPromise = null // electron-updater 模块加载 + 事件接线（幂等）

function focusedWin() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function showInfo(opts) {
  const win = focusedWin()
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
}

async function loadAutoUpdater() {
  const mod = await import('electron-updater')
  const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!autoUpdater) throw new Error('electron-updater 模块加载异常')
  return autoUpdater
}

function ensureUpdater() {
  if (!updaterPromise) {
    updaterPromise = (async () => {
      const autoUpdater = await loadAutoUpdater()
      autoUpdater.logger = {
        info: (m) => log('INFO', `[updater] ${m}`),
        warn: (m) => log('WARN', `[updater] ${m}`),
        error: (m) => log('ERROR', `[updater] ${m}`),
      }
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      if (process.env.MWS_UPDATE_URL) {
        autoUpdater.setFeedURL({ provider: 'generic', url: process.env.MWS_UPDATE_URL })
        log('INFO', `[updater] 更新源已覆盖为 ${process.env.MWS_UPDATE_URL}`)
      }
      wireEvents(autoUpdater)
      return autoUpdater
    })()
  }
  return updaterPromise
}

function wireEvents(autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    checking = true
    log('INFO', '[updater] 正在检查更新…')
  })

  autoUpdater.on('update-available', (info) => {
    log('INFO', `[updater] 发现新版本 ${info?.version}（当前 v${app.getVersion()}），开始后台下载`)
    if (manual) {
      manual = false
      void showInfo({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 v${info?.version}（当前 v${app.getVersion()}）`,
        detail: '正在后台下载，完成后会提示安装。',
      })
    }
  })

  autoUpdater.on('update-not-available', (info) => {
    checking = false
    log('INFO', `[updater] 已是最新版本 v${info?.version}`)
    if (manual) {
      manual = false
      void showInfo({ type: 'info', title: '检查更新', message: `已是最新版本 v${info?.version}` })
    }
  })

  autoUpdater.on('download-progress', (p) => {
    if (manual) log('INFO', `[updater] 下载进度 ${Math.round(p?.percent ?? 0)}%`)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    checking = false
    log('INFO', `[updater] 新版本 ${info?.version} 下载完成`)
    try {
      const { response } = await showInfo({
        type: 'info',
        title: '更新已就绪',
        message: `新版本 v${info?.version} 已下载完成`,
        detail: '是否立即重启并安装？选择「稍后」将在退出应用时自动安装。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) autoUpdater.quitAndInstall()
    } catch { /* 窗口已销毁等场景，忽略 */ }
  })

  autoUpdater.on('error', (e) => {
    checking = false
    log('WARN', `[updater] ${e?.message || e}`)
    if (manual) {
      manual = false
      void dialog.showErrorBox('检查更新失败', e?.message || String(e))
    }
  })
}

async function check(autoUpdater, isManual) {
  if (checking) {
    if (isManual) {
      void showInfo({
        type: 'info',
        title: '检查更新',
        message: '更新检查 / 下载正在进行中，请稍候…',
      })
    }
    return
  }
  manual = isManual
  checking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    checking = false
    log('WARN', `[updater] 检查失败: ${e?.message || e}`)
    if (isManual) {
      manual = false
      dialog.showErrorBox('检查更新失败', e?.message || String(e))
    }
  }
}

/** 应用启动时调用：开发模式跳过；打包版本接线并延时静默检查一次 */
export function initAutoUpdater(options = {}) {
  log = options.log ?? log
  if (!app.isPackaged) {
    log('INFO', '自动更新已跳过（开发模式）')
    return
  }
  void ensureUpdater()
    .then((autoUpdater) => {
      setTimeout(() => { void check(autoUpdater, false) }, UPDATE_CHECK_DELAY_MS)
    })
    .catch((e) => log('ERROR', `[updater] 初始化失败: ${e?.message || e}`))
}

/** 帮助菜单「检查更新…」入口：结果以原生对话框反馈 */
export async function checkForUpdatesManually() {
  if (!app.isPackaged) {
    await showInfo({
      type: 'info',
      title: '检查更新',
      message: '当前为开发模式，更新检查仅在打包版本中可用。',
    })
    return
  }
  try {
    const autoUpdater = await ensureUpdater()
    await check(autoUpdater, true)
  } catch (e) {
    dialog.showErrorBox('检查更新失败', e?.message || String(e))
  }
}
