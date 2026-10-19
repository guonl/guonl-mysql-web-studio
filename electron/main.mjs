/**
 * 桌面客户端主进程（Electron）
 *
 * - dev：加载 Vite dev server（npm run dev:desktop 注入 VITE_DEV_SERVER_URL）
 * - prod：加载 vite build 产物 dist/index.html（npm run start:desktop）
 * 安全：contextIsolation + sandbox，渲染进程零 Node 能力；仅开放 mysql:op / app:op
 *      两个 IPC 通道（app:op 为系统对话框 / 文件导出等白名单操作）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, Menu, dialog, shell, screen } from 'electron'
import { handleMysqlOp, closeAllConns } from './mysql-service.mjs'
import { initAutoUpdater, checkForUpdatesManually } from './updater.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_URL = process.env.VITE_DEV_SERVER_URL || ''
const REPO_URL = 'https://github.com/guonl/guonl-mysql-web-studio'

// userData 目录可用环境变量覆盖（默认在系统应用数据目录；沙箱/便携场景可用）
if (process.env.MWS_USER_DATA) app.setPath('userData', process.env.MWS_USER_DATA)

/* ---------------- 错误日志：落 userData/logs/main.log，超 2MB 轮换一代 ---------------- */
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'main.log')

function logLine(level, msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'main.old.log'))
      }
    } catch { /* 文件尚不存在即无需轮换 */ }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${msg}\n`, 'utf8')
  } catch { /* 日志失败不影响运行 */ }
}

process.on('uncaughtException', (e) => logLine('FATAL', `uncaughtException: ${e?.stack || e}`))
process.on('unhandledRejection', (e) => logLine('ERROR', `unhandledRejection: ${e?.stack || e}`))
app.on('child-process-gone', (_e, details) => logLine('ERROR', `child-process-gone: ${details?.type} ${details?.reason}`))
app.on('render-process-gone', (_e, _wc, details) => logLine('ERROR', `render-process-gone: ${details?.reason}`))
app.on('quit', () => logLine('INFO', 'app quit'))

logLine('INFO', `app start · Electron ${process.versions.electron} · Node ${process.versions.node} · dev=${!!DEV_URL}`)

/* ---------------- 窗口状态记忆：userData/window-state.json ---------------- */
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const width = Number(s?.width)
    const height = Number(s?.height)
    if (!(width >= 500 && height >= 400)) return null
    const out = { width: Math.round(width), height: Math.round(height), maximized: !!s.maximized }
    const x = Number(s.x)
    const y = Number(s.y)
    /* 位置必须落在某个显示器的可见范围内，否则忽略（防止换屏 / 断接外接屏后窗口跑到屏幕外） */
    if (Number.isFinite(x) && Number.isFinite(y) && screen.getAllDisplays().some((d) =>
      x >= d.workArea.x && x < d.workArea.x + d.workArea.width &&
      y >= d.workArea.y && y < d.workArea.y + d.workArea.height)) {
      out.x = Math.round(x)
      out.y = Math.round(y)
    }
    return out
  } catch { return null }
}

function saveWindowState(win) {
  try {
    /* getNormalBounds：最大化时也取「正常态」尺寸，还原时先普通尺寸再最大化 */
    const bounds = win.getNormalBounds()
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...bounds, maximized: win.isMaximized() }), 'utf8')
  } catch (e) {
    logLine('WARN', `saveWindowState: ${e?.message || e}`)
  }
}

/* ---------------- 原生菜单 ---------------- */
function sendToWindow(action) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu:action', action)
}

/** 文件 → 打开 SQL 文件…：系统对话框选文件并读取，内容推给渲染端新建标签页 */
async function openSqlFileViaDialog() {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开 SQL 文件',
    filters: [{ name: 'SQL 脚本', extensions: ['sql', 'txt'] }, { name: '所有文件', extensions: ['*'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return
  const file = filePaths[0]
  try {
    const st = await fs.promises.stat(file)
    if (st.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，请先拆分再打开')
    const content = await fs.promises.readFile(file, 'utf8')
    sendToWindow({ type: 'open-sql-file', name: path.basename(file), content })
  } catch (e) {
    dialog.showErrorBox('打开 SQL 文件失败', e?.message || String(e))
    logLine('ERROR', `openSqlFile: ${e?.message || e}`)
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    /* macOS 应用菜单（关于 / 服务 / 隐藏 / 退出）；win/linux 由「文件」菜单承担 */
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '打开 SQL 文件…', accelerator: 'CmdOrCtrl+O', click: () => void openSqlFileViaDialog() },
        { label: '导出当前 SQL…', accelerator: 'Shift+CmdOrCtrl+S', click: () => sendToWindow({ type: 'export-current-sql' }) },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? [{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [{ role: 'about', label: '关于 MySQL Web Studio' }, { type: 'separator' }]),
        { label: '检查更新…', click: () => void checkForUpdatesManually() },
        { type: 'separator' },
        { label: '源码仓库', click: () => void shell.openExternal(REPO_URL).catch(() => undefined) },
        { label: '打开日志目录', click: () => { fs.mkdirSync(LOG_DIR, { recursive: true }); void shell.openPath(LOG_DIR) } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ---------------- app:op：应用级白名单操作（系统对话框 / 文件写盘） ---------------- */
async function handleAppOp(op, args) {
  if (op === 'saveTextFile') {
    const content = typeof args?.content === 'string' ? args.content : ''
    const defaultPath = typeof args?.defaultPath === 'string' && args.defaultPath.trim()
      ? args.defaultPath.trim()
      : undefined
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出 SQL 文件',
      defaultPath,
      filters: [{ name: 'SQL 脚本', extensions: ['sql'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (canceled || !filePath) return { canceled: true }
    await fs.promises.writeFile(filePath, content, 'utf8')
    logLine('INFO', `saveTextFile: ${filePath} (${content.length} chars)`)
    return { canceled: false, path: filePath }
  }
  /* 批量导出文本文件到用户选择的目录（脚本导出等）：一次选目录，冲突自动加序号 */
  if (op === 'exportTextFilesToDir') {
    const files = Array.isArray(args?.files)
      ? args.files.filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
      : []
    if (!files.length) return { canceled: true }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择导出目录',
      buttonLabel: '导出到此处',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (canceled || !filePaths[0]) return { canceled: true }
    const dir = filePaths[0]
    const written = []
    for (const f of files) {
      /* basename 兜底防路径穿越；重名自动追加序号 */
      const base = path.basename(f.name)
      const ext = path.extname(base)
      const stem = ext ? base.slice(0, -ext.length) : base
      let target = path.join(dir, base)
      let i = 2
      while (fs.existsSync(target)) {
        target = path.join(dir, `${stem}-${i}${ext}`)
        i += 1
      }
      await fs.promises.writeFile(target, f.content, 'utf8')
      written.push(path.basename(target))
    }
    logLine('INFO', `exportTextFilesToDir: ${dir} (${written.length} files)`)
    return { canceled: false, dir, written }
  }
  throw new Error(`未支持的操作：${op}`)
}

/* ---------------- 主窗口 ---------------- */
function createWindow() {
  const saved = loadWindowState()
  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x != null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 620,
    title: 'MySQL Web Studio',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  /* 外链一律走系统浏览器：新窗口（target=_blank）与站内跳转均拦截 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url).catch((e) => logLine('WARN', `openExternal: ${e?.message || e}`))
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file:')
    if (!allowed) {
      e.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url).catch(() => undefined)
    }
  })

  /* AI CORS 白名单：模型端点由用户自由配置（OpenAI 兼容），无法穷举域名。
     对本窗口发出的 http(s) 请求统一补齐缺失的 CORS 头——AI fetch/SSE 均为非凭据请求，
     ACAO=* 即可通过；预检（OPTIONS）回显浏览器请求的头部清单，避免通配符不覆盖 Authorization。 */
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (!/^https?:/i.test(details.url)) return callback({})
    const headers = { ...details.responseHeaders }
    const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name)
    if (!has('access-control-allow-origin')) headers['Access-Control-Allow-Origin'] = ['*']
    if (details.method === 'OPTIONS') {
      if (!has('access-control-allow-methods')) {
        headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS']
      }
      if (!has('access-control-allow-headers')) {
        const rk = Object.keys(details.requestHeaders).find((k) => k.toLowerCase() === 'access-control-request-headers')
        headers['Access-Control-Allow-Headers'] = [rk ? String(details.requestHeaders[rk]) : 'Content-Type, Authorization']
      }
      if (!has('access-control-max-age')) headers['Access-Control-Max-Age'] = ['600']
    }
    callback({ responseHeaders: headers })
  })

  /* 关闭时记忆窗口状态 */
  win.on('close', () => saveWindowState(win))

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(() => {
  ipcMain.handle('mysql:op', async (_evt, { op, args } = {}) => {
    try {
      return { ok: true, data: await handleMysqlOp(op, args) }
    } catch (e) {
      const err = e || {}
      return {
        ok: false,
        error: {
          code: err.errno ?? err.code ?? 0,
          message: err.message || String(e),
          fatal: !!err.fatal,
        },
      }
    }
  })
  ipcMain.handle('app:op', async (_evt, { op, args } = {}) => {
    try {
      return { ok: true, data: await handleAppOp(op, args) }
    } catch (e) {
      return { ok: false, error: { code: 0, message: e?.message || String(e) } }
    }
  })
  buildMenu()
  createWindow()
  initAutoUpdater({ log: logLine })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  try { closeAllConns() } catch { /* noop */ }
})
