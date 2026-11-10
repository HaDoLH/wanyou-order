/*  萬友咖啡點單 — Service Worker（PWA 離線快取）
 *  ===================================================================
 *  作用：第一次連網開過後，把「網頁外殼」（HTML/CSS/圖片/字體等）存進瀏覽器快取，
 *  之後沒網路也能從主畫面圖示開啟。資料（商品/銷售）另存在 localStorage，與此無關。
 *
 *  改版時把 CACHE 的版本號加一（例 wy-v1 → wy-v2），舊快取會自動清掉。
 *  =================================================================== */

const CACHE = 'wy-v25';

// 要預先快取的檔案（app shell）
const ASSETS = [
  './',
  './index.html',
  './style.css?v=15',
  './sync.js?v=3',
  './expo-orders.js?v=5',
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

// 取用策略：
//  • 開啟頁面（HTML / 導覽）：network-first —— 有網路一律先抓最新版，離線才用快取備份。
//    這樣更新上線後「一開就是新版」，不會再卡成半新半舊。
//  • 其餘同源資源（CSS/JS/圖片）：cache-first —— 這些檔名都帶 ?v= 版本號，
//    改版即換網址、自然抓新；維持快取優先，開啟最快。
//  • 雲端連線（Firebase）：直接通過，不經快取。
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  if(new URL(req.url).origin !== location.origin) return;  // Firebase 等跨網域直接放行

  // 是不是「開啟頁面」的請求（導覽，或要求 HTML）
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  if(isHTML){
    // network-first：先上網抓，成功就順手更新離線備份；失敗（離線）才回快取
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put('./index.html', copy));
        return res;
      }).catch(() =>
        caches.match(req).then(r => r || caches.match('./index.html'))
      )
    );
    return;
  }

  // cache-first：先找快取，沒有再上網抓，抓到順手存起來
  event.respondWith(
    caches.match(req).then(cached => {
      if(cached) return cached;
      return fetch(req).then(res => {
        if(res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});