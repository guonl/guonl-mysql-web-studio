/**
 * 桌面客户端开发编排：起 Vite dev server → 等端口就绪 → 启动 Electron。
 * 用法：npm run dev:desktop
 * Electron 侧无需构建（main.mjs / mysql-service.mjs 直接以 ESM 运行，
 * preload.cjs 为 sandbox 要求的 CJS），改完重启本命令即可。
 */
import { spawn } from 'node:child_process'

const PORT = Number(process.env.PORT || 5188)
const DEV_URL = `http://localhost:${PORT}`
const withShell = process.platform === 'win32'

// --strictPort：端口被占时直接失败，避免 vite 静默换端口导致 Electron 连错服务器
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'inherit', shell: withShell })

async function waitForServer(url, timeoutMs = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* 未就绪，继续等 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Vite dev server 在 ${Math.round(timeoutMs / 1000)}s 内未就绪：${url}`)
}

let electron
try {
  await waitForServer(DEV_URL)
  electron = spawn('npx', ['electron', '.'], {
    stdio: 'inherit',
    shell: withShell,
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
  })
} catch (e) {
  console.error('[desktop]', e instanceof Error ? e.message : e)
  vite.kill('SIGTERM')
  process.exit(1)
}

const shutdown = (code) => {
  vite.kill('SIGTERM')
  try { electron?.kill('SIGTERM') } catch { /* noop */ }
  process.exit(code ?? 0)
}
electron.on('exit', shutdown)
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
