/**
 * Browser side of push notifications: subscribing through the service worker
 * (public/sw.js) and storing preferences with the push Worker (workers/push/).
 */

export type Frequency = 'daily' | 'weekly';

export interface PushPrefs {
    /** '*' = every category */
    categories: '*' | string[];
    frequency: Frequency;
}

const API = '/api/push';

export type PushSupport = 'ok' | 'unsupported' | 'ios-install';

export function pushSupport(): PushSupport {
    const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // iOS only offers push to apps added to the home screen.
    if (ios && !standalone) return 'ios-install';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
    return 'ok';
}

async function registration(): Promise<ServiceWorkerRegistration> {
    if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js');
    return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
    return body as T;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
    const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The stored preferences, or null when the server doesn't know this subscription. */
export async function fetchPrefs(sub: PushSubscription): Promise<PushPrefs | null> {
    const res = await call<{ subscribed: boolean } & Partial<PushPrefs>>(
        `/subscription?endpoint=${encodeURIComponent(sub.endpoint)}`
    );
    return res.subscribed ? { categories: res.categories!, frequency: res.frequency! } : null;
}

export async function savePrefs(sub: PushSubscription, prefs: PushPrefs): Promise<void> {
    await call('/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), ...prefs }) });
}

/** Asks for permission (if needed), subscribes and stores the preferences. */
export async function subscribe(prefs: PushPrefs): Promise<PushSubscription> {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed');
    const reg = await registration();
    const { key } = await call<{ key: string }>('/key');
    const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    await savePrefs(sub, prefs);
    return sub;
}

export async function unsubscribe(sub: PushSubscription): Promise<void> {
    await call('/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    await sub.unsubscribe();
}

export async function sendTest(sub: PushSubscription): Promise<void> {
    await call('/test', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
}
