// Service worker mínimo: permite instalar o app do zelador na tela inicial.
// Não guarda páginas em cache, para o zelador sempre ver os chamados atualizados.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
