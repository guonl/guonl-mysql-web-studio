/**
 * Chrome 插件打包：vite build 之后执行
 * 把 extension/ 下的 manifest.json、sw.js 拷贝进 dist/，
 * dist/ 即为可直接「加载已解压的扩展程序」的插件目录。
 */

import { cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')
const ext = join(root, 'extension')

if (!existsSync(dist)) {
  console.error('[build-ext] dist/ 不存在，请先执行 npm run build')
  process.exit(1)
}

cpSync(ext, dist, { recursive: true })

const size = (p) => {
  let total = 0
  for (const name of readdirSync(p)) {
    const fp = join(p, name)
    total += statSync(fp).isDirectory() ? size(fp) : statSync(fp).size
  }
  return total
}

console.log('[build-ext] 已完成：extension/* → dist/')
console.log(`[build-ext] 插件目录 dist/（共 ${(size(dist) / 1024 / 1024).toFixed(2)} MB）`)
console.log('[build-ext] 安装：Chrome → 扩展程序 → 开发者模式 → 加载已解压的扩展程序 → 选择 dist/')
console.log('[build-ext] 使用前请先启动桥接器：npm run bridge')
