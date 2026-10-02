'use strict';
// 注册 service worker。故意写成普通脚本（不是 module）：它必须在 file:// 下安静地什么都不做。
//
// Electron 走的是 `loadFile()`，协议是 file:，那时 navigator.serviceWorker 要么不存在、
// 要么注册必败 —— 那是运行环境的形状，不是玩家的错，所以这里连协议一起判掉，
// 剩下的一条 catch 只用来吃掉无痕窗口/旧 Safari 的拒绝，控制台不该见红。
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
