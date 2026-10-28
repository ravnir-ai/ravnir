// Push only. No fetch handler and no caching, so the app always loads fresh.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // renotify needs a tag, and a push must always show something.
  event.waitUntil(self.registration.showNotification(data.title || "Ravnir", {
    body: data.body || "",
    icon: "/logo.png?v=companion-20261025",
    badge: "/logo.png?v=companion-20261025",
    tag: data.tag || undefined,
    data: { url: data.url || "/", id: data.id || "" },
    renotify: Boolean(data.tag) && data.kind === "approval",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  const url = target.origin === self.location.origin ? target.pathname + target.search + target.hash : "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: "open", url });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const { key } = await (await fetch("/api/push/key", { credentials: "same-origin" })).json();
    const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
    const subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), label: "" }),
    });
  })());
});
