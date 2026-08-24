import { api } from "./api";

// The push service needs the VAPID public key as a raw byte array, but it's
// handed out as a URL-safe base64 string — this is the standard conversion
// (there's no built-in for it).
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function isPushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window;
}

export async function getCurrentSubscription() {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export async function subscribeToPush() {
  if (!isPushSupported()) {
    throw new Error("This browser doesn't support push notifications");
  }
  const { configured, publicKey } = await api.getPushPublicKey();
  if (!configured) {
    throw new Error("Push notifications aren't configured on the server yet");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was denied");
  }
  // register() resolves as soon as the worker is registered, not once it's
  // active — Chrome tolerates subscribing before that, but Safari/WebKit
  // throws ("no active Service Worker") if pushManager.subscribe() runs
  // first. `ready` resolves only once a worker is actually active.
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api.subscribePush(subscription.toJSON());
  return subscription;
}

export async function unsubscribeFromPush() {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  await api.unsubscribePush(subscription.endpoint);
  await subscription.unsubscribe();
}
