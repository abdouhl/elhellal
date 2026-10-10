// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { digestMessage, nextSlot } from './index';
import type { PushDigest } from '../../../src/lib/push-digest';

const at = (iso: string) => Date.parse(iso);

describe('nextSlot', () => {
    it('is today at the send hour when that is still ahead', () => {
        expect(new Date(nextSlot(at('2026-10-10T09:00:00Z'), 'daily', 17)).toISOString()).toBe('2026-10-10T17:00:00.000Z');
    });
    it('is tomorrow once the send hour has passed', () => {
        expect(new Date(nextSlot(at('2026-10-10T17:00:00Z'), 'daily', 17)).toISOString()).toBe('2026-10-11T17:00:00.000Z');
    });
    it('is the next Friday for weekly digests', () => {
        // 2026-10-10 is a Saturday
        expect(new Date(nextSlot(at('2026-10-10T09:00:00Z'), 'weekly', 17)).toISOString()).toBe('2026-10-16T17:00:00.000Z');
        expect(new Date(nextSlot(at('2026-10-16T18:00:00Z'), 'weekly', 17)).toISOString()).toBe('2026-10-23T17:00:00.000Z');
    });
});

describe('digestMessage', () => {
    const digest: PushDigest = {
        generatedAt: '2026-10-10T00:00:00Z',
        categories: { history: 'التاريخ', ai: 'الذكاء الاصطناعي' },
        articles: [
            { s: 'c', t: 'ثالث', c: 'ai', d: '2026-10-10', i: 'https://img/c' },
            { s: 'b', t: 'ثاني', c: 'history', d: '2026-10-09' },
            // Published long ago but only imported now: still new.
            { s: 'a', t: 'أول', c: 'history', d: '2026-09-30' },
        ],
    };
    const seen = new Map([['c', 300], ['b', 200], ['a', 200]]);

    it('lists only articles first seen since the last digest', () => {
        const m = digestMessage(digest, seen, { categories: '*', frequency: 'daily', since: 250 })!;
        expect(m.body).toBe('ثالث');
        expect(m.url).toBe('/articles/c/?utm_source=push&utm_medium=daily');
        expect(m.image).toBe('https://img/c');
    });

    it('filters by category and names a single category', () => {
        const m = digestMessage(digest, seen, { categories: ',history,', frequency: 'weekly', since: 100 })!;
        expect(m.title).toBe('الهلال — مختارات الأسبوع في التاريخ');
        expect(m.body).toBe('ثاني\nومقال آخر');
        expect(m.url).toBe('/history/?utm_source=push&utm_medium=weekly');
    });

    it('links to the home page across categories', () => {
        const m = digestMessage(digest, seen, { categories: '*', frequency: 'daily', since: 100 })!;
        expect(m.count).toBe(3);
        expect(m.body).toBe('ثالث\nومقالان آخران');
        expect(m.url).toBe('/?utm_source=push&utm_medium=daily');
    });

    it('sends nothing when nothing is new, or for articles never seen', () => {
        expect(digestMessage(digest, seen, { categories: ',history,', frequency: 'daily', since: 250 })).toBeNull();
        expect(digestMessage(digest, new Map(), { categories: '*', frequency: 'daily', since: 0 })).toBeNull();
    });
});
