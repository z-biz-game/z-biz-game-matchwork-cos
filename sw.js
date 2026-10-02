'use strict';
// 离线壳。只做 network-first，绝不做 cache-first。
//
// 为什么：这个仓的入口是 `<script type="module">`，浏览器会替我拉一串 js/*.js。一旦
// cache-first 把某次访问的模块钉在缓存里，下一次 index.html 更新就会拿新壳跑旧模块，
// 那是没人写过的状态组合。所以网络能答就先让网络答，缓存只是断网时的救生圈 ——
// 这也就是"地铁里第二次打开还能玩"的全部含义。
//
// 缓存名带版本；activate 删掉所有别的名字。改了不兼容的东西就把 VERSION 往上抬一位，
// 这是唯一的清缓存动作，没有第二处需要记。
const VERSION = 'matchwork-shell-v1';

// 装的时候先把壳预置一遍，这样第一次进也能离线（addAll 是一个失败全体失败，
// 所以这里逐条 catch：少一张图不该让整次 install 变红）。
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/textures/felt-256.png',
  './assets/textures/ember-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((cache) => Promise.all(SHELL.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  // 只管同源：跨源的东西（字体、Electron 的 file:// 兄弟请求）不在我的版本控制里。
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit
        || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
