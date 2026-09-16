var CACHE='ghrdp-explorer-v1';
var PRE=['./explorer.html','./archive.json','./data.json','./archive.html','./decrypt.html'];
self.addEventListener('install',function(e){
  e.waitUntil(Promise.all(PRE.map(function(u){return fetch(u,{cache:'no-store'}).then(function(r){if(!r.ok)return null;return caches.open(CACHE).then(function(c){return c.put(u,r)})}).catch(function(){return null})})).then(function(){return self.skipWaiting()}));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}));
});
self.addEventListener('fetch',function(e){
  var req=e.request;
  if(req.method!=='GET')return;
  var u=new URL(req.url);
  if(u.origin!==location.origin)return;
  if(req.mode==='navigate'){
    e.respondWith(fetch(req).then(function(r){var c=r.clone();caches.open(CACHE).then(function(cc){cc.put(req,c)});return r}).catch(function(){return caches.match('./explorer.html')}));
    return;
  }
  e.respondWith(caches.match(req).then(function(hit){
    var net=fetch(req).then(function(r){if(r.ok){var c=r.clone();caches.open(CACHE).then(function(cc){cc.put(req,c)})}return r}).catch(function(){return hit||Response.error()});
    return hit||net;
  }));
});