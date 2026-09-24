/* 主题引导：在首帧渲染前把持久化的主题设置到 <html data-theme>，
 * 避免亮色主题用户刷新时先按 :root 暗色兜底渲染、React 挂载后再切换的闪烁。
 * 只做格式校验（作为 CSS 属性选择器的匹配值），非法/缺失值落回 :root 暗色兜底。
 * 插件模式数据在 chrome.storage（异步预载），无法同步首帧恢复，行为与此前一致。 */
try {
  var t = (JSON.parse(localStorage.getItem('mws.v1.prefs') || '{}') || {}).theme
  if (typeof t === 'string' && /^[a-z][a-z0-9-]*$/.test(t)) {
    document.documentElement.setAttribute('data-theme', t)
  }
} catch (e) { /* ignore */ }
