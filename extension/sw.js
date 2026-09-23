/* 点击工具栏图标 → 在新标签页打开工作台（index.html 经 options_ui 注册） */
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage()
})
