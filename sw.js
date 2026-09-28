/* FORM · service worker — yalnız dinlenme bildirimi.
   Bilerek "fetch" dinleyicisi YOK: sayfa önbelleğe alınmaz, her açılışta sunucudaki
   en güncel sürüm gelir. Bu dosyanın tek işi, uygulama kapalıyken ya da ekran
   kilitliyken gelen push bildirimini göstermek. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Dinlenme bitti', {
    body: d.body || 'Sıradaki sete geç',
    tag: 'rest',          /* yeni bildirim eskisinin yerine geçer, üst üste yığılmaz */
    renotify: true,
    icon: 'icon-180.png',
    badge: 'icon-180.png'
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) if ('focus' in cs[i]) return cs[i].focus();
    return self.clients.openWindow('./');
  }));
});
