// BIKIBioMed — service worker (programme de démarrage de l'application installée)
// Stratégie volontairement simple : on passe toujours par le réseau pour avoir
// la dernière version ; sans connexion, on affiche une page « hors ligne ».
const CACHE = "bikibiomed-v1";
const HORS_LIGNE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([HORS_LIGNE, "/icon-192.png"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Seules les ouvertures de page sont interceptées ; les données (API) passent normalement.
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(HORS_LIGNE)));
});
