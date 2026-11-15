import { describe, expect, it } from 'vitest';
import { compareNativeFirst, toFeedCard, type FeedCard } from './feed';
import { articlesCountAr, isAiAssisted, isNative } from './native';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const card = (title: string, date: string, n?: 1): FeedCard => ({ title, date, category: 'x', ...(n ? { n } : {}) });

describe('native origin', () => {
    it('classifies origins', () => {
        expect(isNative('write')).toBe(true);
        expect(isNative('persona')).toBe(true);
        expect(isNative('personal')).toBe(true);
        expect(isNative('substack')).toBe(false);
        expect(isNative(undefined)).toBe(false);
        expect(isAiAssisted('write')).toBe(false);
        expect(isAiAssisted('persona')).toBe(true);
    });

    it('sets card flags from origin', () => {
        const base = { title: 't', created_at: '2026-11-01', slug: 's' };
        expect(toFeedCard({ ...base, origin: 'write' }, 'c')).toMatchObject({ n: 1 });
        expect(toFeedCard({ ...base, origin: 'write' }, 'c').ai).toBeUndefined();
        expect(toFeedCard({ ...base, origin: 'personal' }, 'c')).toMatchObject({ n: 1, ai: 1 });
        const plain = toFeedCard(base, 'c');
        expect(plain.n).toBeUndefined();
        expect(plain.ai).toBeUndefined();
    });

    it('formats Arabic counts', () => {
        expect(articlesCountAr(1)).toBe('مقال واحد');
        expect(articlesCountAr(2)).toBe('مقالان');
        expect(articlesCountAr(5)).toBe('5 مقالات');
        expect(articlesCountAr(40)).toBe('40 مقالاً');
    });
});

describe('compareNativeFirst', () => {
    const cmp = compareNativeFirst(NOW);

    it('puts recent native posts ahead of newer curated ones', () => {
        const list = [card('curated', '2026-11-14'), card('native', '2026-11-01', 1)].sort(cmp);
        expect(list.map((c) => c.title)).toEqual(['native', 'curated']);
    });

    it('stops boosting after the window', () => {
        const list = [card('old-native', '2026-09-01', 1), card('curated', '2026-10-01')].sort(cmp);
        expect(list.map((c) => c.title)).toEqual(['curated', 'old-native']);
    });

    it('keeps newest-first among boosted and among the rest', () => {
        const list = [
            card('a', '2026-11-02', 1),
            card('b', '2026-11-10'),
            card('c', '2026-11-12', 1),
            card('d', '2026-11-13'),
        ].sort(cmp);
        expect(list.map((c) => c.title)).toEqual(['c', 'a', 'd', 'b']);
    });
});
