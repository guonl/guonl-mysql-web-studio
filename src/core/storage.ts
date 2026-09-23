/* 持久化层（连接配置 / 脚本 / 历史 / 偏好 / 标签页）
 *
 * 双模式适配：
 * - Web 模式：localStorage 同步读写（与页面同生命周期）
 * - Chrome 插件模式：chrome.storage.local 异步读写。由于 Zustand 初始
 *   state 需要同步读取，启动时由 initStorage() 在应用渲染前把数据一次性
 *   预载进内存缓存，之后读写全部走缓存（写操作再异步刷回 chrome.storage）。
 */

const PREFIX = 'mws.v1.'

/** 是否运行在 Chrome 插件页面（chrome-extension:// 协议） */
export const IS_EXTENSION =
  typeof location !== 'undefined' && location.protocol === 'chrome-extension:'

/** 默认桥接地址：Web 模式与页面同源；插件模式指向本机独立桥接器（npm run bridge，默认端口 5189） */
export function defaultBridgeUrl(): string {
  return IS_EXTENSION
    ? 'ws://localhost:5189/__mysql_bridge'
    : `ws://${location.host}/__mysql_bridge`
}

/** MV3 chrome.storage.local（本仓库未引入 @types/chrome，这里给最小类型声明） */
declare const chrome: {
  storage?: {
    local?: {
      get: (keys: null) => Promise<Record<string, unknown>>
      set: (items: Record<string, string>) => Promise<void>
      remove: (keys: string | string[]) => Promise<void>
    }
  }
}

const chromeStore =
  IS_EXTENSION && typeof chrome !== 'undefined' ? chrome.storage?.local : undefined

/** 插件模式的内存缓存：initStorage() 预载，此后同步读写 */
const memCache = new Map<string, string>()

/** 应用渲染前调用：插件模式预载持久化数据（Web 模式无需处理） */
export async function initStorage(): Promise<void> {
  if (!chromeStore) return
  try {
    const all = await chromeStore.get(null)
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(PREFIX) && typeof v === 'string') memCache.set(k, v)
    }
  } catch (e) {
    console.warn('chrome.storage 预载失败，将使用空白数据', e)
  }
}

export function loadStore<T>(key: string, fallback: T): T {
  try {
    const raw = chromeStore ? memCache.get(PREFIX + key) : localStorage.getItem(PREFIX + key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveStore(key: string, value: unknown) {
  const raw = JSON.stringify(value)
  try {
    if (chromeStore) {
      memCache.set(PREFIX + key, raw)
      void chromeStore.set({ [PREFIX + key]: raw }).catch((e) => console.warn('persist failed', key, e))
    } else {
      localStorage.setItem(PREFIX + key, raw)
    }
  } catch (e) {
    console.warn('persist failed', key, e)
  }
}

export function removeStore(key: string) {
  if (chromeStore) {
    memCache.delete(PREFIX + key)
    void chromeStore.remove(PREFIX + key).catch(() => undefined)
  } else {
    localStorage.removeItem(PREFIX + key)
  }
}
