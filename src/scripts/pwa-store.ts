/**
 * Small per-device PWA state in localStorage: recently read articles (listed
 * on /offline/ when they're cached) and the install prompt's bookkeeping.
 * Every read and write tolerates storage being unavailable.
 */

const RECENT_KEY = 'elhellal_recent';
const RECENT_MAX = 30;
const INSTALL_KEY = 'elhellal_install';

export interface RecentPage {
    url: string;
    title: string;
}

export interface InstallState {
    /** Article pages read on this device. */
    reads: number;
    /** When the reader last dismissed the install banner (ms). */
    dismissedAt?: number;
    installed?: boolean;
    /** When the reader last dismissed the installed app's notifications banner (ms). */
    notifyDismissedAt?: number;
}

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function write(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // storage full or blocked
    }
}

export function readRecent(): RecentPage[] {
    const list = read<RecentPage[]>(RECENT_KEY, []);
    return Array.isArray(list) ? list : [];
}

export function rememberRecent(page: RecentPage) {
    write(RECENT_KEY, [page, ...readRecent().filter((p) => p.url !== page.url)].slice(0, RECENT_MAX));
}

export function readInstallState(): InstallState {
    return { reads: 0, ...read<Partial<InstallState>>(INSTALL_KEY, {}) };
}

export function updateInstallState(patch: Partial<InstallState>): InstallState {
    const next = { ...readInstallState(), ...patch };
    write(INSTALL_KEY, next);
    return next;
}
