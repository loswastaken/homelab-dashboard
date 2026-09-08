(function () {
  function urlB64ToUint8(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function getRegistration() {
    const existing = await navigator.serviceWorker.getRegistration('/sw.js');
    if (existing) return existing;
    return navigator.serviceWorker.register('/sw.js');
  }

  async function getSubscription() {
    if (!supported()) return null;
    try {
      const reg = await getRegistration();
      await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch { return null; }
  }

  // The VAPID key a subscription was created with, base64url like the server
  // reports it. A subscription made against an old key (data/vapid.json
  // regenerated or restored) still looks "subscribed" to the browser, but
  // every send from the server is rejected by the push service with 401/403
  // — silently, from the user's point of view. Returns null when the browser
  // does not expose the key, in which case we cannot tell.
  function keyOf(sub) {
    try {
      const k = sub && sub.options && sub.options.applicationServerKey;
      if (!k) return null;
      const bytes = new Uint8Array(k);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch { return null; }
  }
  function keyMismatch(sub, serverKey) {
    const local = keyOf(sub);
    return !!local && local !== String(serverKey || '').replace(/=+$/, '');
  }

  async function fetchPublicKey() {
    const r = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('Could not fetch VAPID key');
    const j = await r.json();
    return j.publicKey;
  }

  async function registerPush() {
    if (!supported()) throw new Error('Push notifications are not supported in this browser');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notification permission denied');
    const reg = await getRegistration();
    await navigator.serviceWorker.ready;
    const publicKey = await fetchPublicKey();
    let sub = await reg.pushManager.getSubscription();
    if (sub && keyMismatch(sub, publicKey)) {
      // Stale subscription from a previous server key: drop it and subscribe
      // fresh so the server can actually deliver to this browser.
      try { await sub.unsubscribe(); } catch {}
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8(publicKey)
      });
    }
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub)
    });
    if (!res.ok) throw new Error('Server rejected subscription');
    return sub;
  }

  async function unregisterPush() {
    const sub = await getSubscription();
    if (!sub) return;
    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    } catch {}
    try { await sub.unsubscribe(); } catch {}
  }

  async function testPush() {
    if (!supported()) throw new Error('Push notifications are not supported in this browser');
    let sub = await getSubscription();
    if (!sub || Notification.permission !== 'granted') {
      sub = await registerPush();
    }
    const res = await fetch('/api/push/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'Test push failed');
    }
  }

  async function currentState() {
    const state = { supported: supported(), permission: 'default', subscribed: false, keyMismatch: false };
    if (!state.supported) return state;
    state.permission = Notification.permission;
    const sub = await getSubscription();
    state.subscribed = !!sub;
    if (sub) {
      try { state.keyMismatch = keyMismatch(sub, await fetchPublicKey()); } catch {}
    }
    return state;
  }

  window.Push = { supported, registerPush, unregisterPush, testPush, currentState, getSubscription };
})();
