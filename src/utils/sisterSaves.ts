// Quotes, books and writers saved from the Explore tab (src/pages/explore.astro),
// listed in /saved/ (FavoritesView.tsx). They live on the sister sites, so the
// whole item is kept here, not a slug: a saved quote reads offline.

const STORAGE_KEY = 'sister_saves';
export const SISTER_SAVES_EVENT = 'sister-saves:changed';

export type SisterKind = 'quotes' | 'books' | 'biographies';

export interface SisterSave {
    kind: SisterKind;
    url: string;
    title: string;
    text?: string;
    meta?: string;
    image?: string;
    savedAt: number;
}

export function getSisterSaves(): SisterSave[] {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(stored) ? stored : [];
    } catch {
        return [];
    }
}

function write(saves: SisterSave[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saves));
        window.dispatchEvent(new CustomEvent(SISTER_SAVES_EVENT));
    } catch (error) {
        console.warn('Failed to save to localStorage:', error);
    }
}

export function isSisterSaved(url: string): boolean {
    return getSisterSaves().some((s) => s.url === url);
}

export function removeSisterSave(url: string) {
    write(getSisterSaves().filter((s) => s.url !== url));
}

/** Saves or unsaves the item; returns whether it is saved now. */
export function toggleSisterSave(item: Omit<SisterSave, 'savedAt'>): boolean {
    if (isSisterSaved(item.url)) {
        removeSisterSave(item.url);
        return false;
    }
    write([{ ...item, savedAt: Date.now() }, ...getSisterSaves()]);
    return true;
}
