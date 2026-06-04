/*  萬友咖啡點單 — Service Worker（PWA 離線快取）
 *  ===================================================================
 *  作用：第一次連網開過後，把「網頁外殼」（HTML/CSS/圖片/字體等）存進瀏覽器快取，
 *  之後沒網路也能從主畫面圖示開啟。資料（商品/銷售）另存在 localStorage，與此無關。
 *
 *  改版時把 CACHE 的版本號加一（例 wy-v1 → wy-v2），舊快取會自動清掉。
 *  =================================================================== */

const CACHE = 'wy-v2';

// 要預先快取的檔案（app shell）
const ASSETS = [
  './',
  './index.html',
  './style.css?v=6',
  './manifest.webmanifest',
  './images/icon.png'
];

// 安裝：把上面的檔案抓下來存進快取
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// 啟用：清掉舊版本的快取
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 取用：cache-first（先找快取，沒有再上網抓；抓到的順手存起來）
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(res => {
        // 同源資源順便快取起來，下次離線也有
        if(res.ok && new URL(event.request.url).origin === location.origin){
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => cached); // 離線且沒快取時，回傳 undefined（瀏覽器自行處理）
    })
  );
});