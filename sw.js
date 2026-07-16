// 超哥超车 Service Worker
const CACHE='chaoge-v1';
const URLS=['./','./index.html','./style.css','./manifest.json',
'./models.html','./guide.html','./calculator.html','./loan.html','./database.html',
'./compare.html','./ev-vs-gas.html','./quotes.html','./cases.html','./stories.html',
'./checklist.html','./pitfalls.html','./faq.html','./videos.html','./recommend.html',
'./quiz.html','./chat.html','./board.html','./about.html'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(URLS)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(
    caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{
      const cp=resp.clone();
      caches.open(CACHE).then(c=>c.put(e.request,cp)).catch(()=>{});
      return resp;
    }).catch(()=>caches.match('./index.html')))
  );
});
