// The service worker of the inbox page. It shows a notification when the inbox pushes a new card, and opens that card when
// the person taps the notification. It caches nothing and takes over no request, so the page always comes from the inbox.
// The page registers it from its own path, so its scope is the inbox's address, such as /i/<inbox id>/ on a relay.

const HEADING = 'A card is waiting for you';

// The push carries the card's id and title, encrypted so that only this browser reads them.
function readPush(event) {
  try {
    const message = event.data && event.data.json();
    if (message && typeof message.id === 'string' && typeof message.title === 'string') return message;
  } catch {
    // An unreadable message still gets a notification: a browser needs one for each push.
  }
  return null;
}

self.addEventListener('push', (event) => {
  const message = readPush(event);
  const options = { icon: new URL('icon-192.png', self.registration.scope).href };
  if (message) Object.assign(options, { body: message.title, tag: `card:${message.id}`, data: { id: message.id } });
  event.waitUntil(self.registration.showNotification(HEADING, options));
});

async function openCard(id) {
  const address = new URL(id ? `#card=${encodeURIComponent(id)}` : '', self.registration.scope).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = windows.find((w) => w.url.startsWith(self.registration.scope));
  if (mine) {
    try {
      await mine.focus();
      // A change of the address after the # moves the open page to the card without a reload.
      await mine.navigate(address);
      return;
    } catch {
      // A page that cannot be moved gets a window of its own.
    }
  }
  await self.clients.openWindow(address);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil(openCard(data && typeof data.id === 'string' ? data.id : ''));
});
