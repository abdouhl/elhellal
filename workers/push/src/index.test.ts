// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dayNumber, digestMessage, nextSlot, quickRead, readingReminder, streakReminder, weeklyRecap } from './index';
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
            { s: 'c', t: 'ثالث', c: 'ai', d: '2026-10-10', i: 'https://img/c', p: 'ملخص الثالث' },
            { s: 'b', t: 'ثاني', c: 'history', d: '2026-10-09' },
            // Published long ago but only imported now: still new.
            { s: 'a', t: 'أول', c: 'history', d: '2026-09-30' },
        ],
    };
    const seen = new Map([['c', 300], ['b', 200], ['a', 200]]);

    it('lists only articles first seen since the last digest', () => {
        const m = digestMessage(digest, seen, { categories: '*', frequency: 'daily', since: 250 })!;
        expect(m.title).toBe('ثالث');
        expect(m.body).toBe('ملخص الثالث');
        expect(m.url).toBe('/articles/c/?utm_source=push&utm_medium=daily');
        expect(m.image).toBe('https://img/c');
        expect(m.actions).toEqual([{ action: 'read', title: 'اقرأ المقال' }]);
    });

    it('filters by category, opens the top article and offers the category', () => {
        const m = digestMessage(digest, seen, { categories: ',history,', frequency: 'weekly', since: 100 })!;
        expect(m.title).toBe('ثاني');
        // No preview: the category stands in.
        expect(m.body).toBe('التاريخ\n📚 ومقال آخر في التاريخ');
        expect(m.url).toBe('/articles/b/?utm_source=push&utm_medium=weekly');
        expect(m.actions).toEqual([
            { action: 'read', title: 'اقرأ المقال' },
            { action: 'more', title: 'كل الجديد (2)', url: '/history/?utm_source=push&utm_medium=weekly' },
        ]);
    });

    it('opens the top article and offers the home page across categories', () => {
        const m = digestMessage(digest, seen, { categories: '*', frequency: 'daily', since: 100 })!;
        expect(m.count).toBe(3);
        expect(m.body).toBe('ملخص الثالث\n📚 ومقالان آخران');
        expect(m.url).toBe('/articles/c/?utm_source=push&utm_medium=daily');
        expect((m.actions as Array<{ url?: string }>)[1]!.url).toBe('/?utm_source=push&utm_medium=daily');
    });

    it('sends nothing when nothing is new, or for articles never seen', () => {
        expect(digestMessage(digest, seen, { categories: ',history,', frequency: 'daily', since: 250 })).toBeNull();
        expect(digestMessage(digest, new Map(), { categories: '*', frequency: 'daily', since: 0 })).toBeNull();
    });

    const quote = { text: 'نص الاقتباس', title: 'كاتب', url: 'https://quotes.elhellal.com/x/1/' };

    it('ends the digest with the quote of the day', () => {
        const m = digestMessage(digest, seen, { categories: '*', frequency: 'daily', since: 250 }, quote)!;
        expect(m.body).toBe('ملخص الثالث\n❝ نص الاقتباس — كاتب');
    });

    it('sends a daily subscriber the quote alone when nothing is new, a weekly one nothing', () => {
        const m = digestMessage(digest, seen, { categories: ',history,', frequency: 'daily', since: 250 }, quote)!;
        expect(m.title).toBe('الهلال — اقتباس اليوم');
        expect(m.body).toBe('❝ نص الاقتباس\n— كاتب');
        expect(m.url).toBe('/explore/?utm_source=push&utm_medium=quote');
        expect(digestMessage(digest, seen, { categories: ',history,', frequency: 'weekly', since: 250 }, quote)).toBeNull();
    });
});

describe('quiz streaks', () => {
    it('counts days the way the Explore tab does', () => {
        expect(dayNumber(at('2026-10-13T00:00:00Z'))).toBe(Date.UTC(2026, 9, 13) / 86_400_000);
        expect(dayNumber(at('2026-10-13T23:59:59Z'))).toBe(dayNumber(at('2026-10-13T00:00:00Z')));
    });
    it('names the streak in the reminder', () => {
        expect(streakReminder(5).title).toBe('🔥 5 أيام متتالية');
        expect(streakReminder(5).url).toBe('/explore/?utm_source=push&utm_medium=quiz#quiz');
    });
});

describe('digestMessage with follows', () => {
    const digest: PushDigest = {
        generatedAt: '2026-10-10T00:00:00Z',
        categories: { history: 'التاريخ', ai: 'الذكاء الاصطناعي' },
        articles: [
            { s: 'c', t: 'ثالث', c: 'ai', d: '2026-10-10', p: 'ملخص' },
            { s: 'b', t: 'ثاني', c: 'history', d: '2026-10-09', a: 'writer', p: 'عن التاريخ' },
            { s: 'a', t: 'أول', c: 'history', d: '2026-10-08', g: ['ابن-خلدون'] },
        ],
    };
    const seen = new Map([['c', 300], ['b', 300], ['a', 300]]);

    it('adds followed authors and tags outside the chosen categories, and leads with them', () => {
        const m = digestMessage(digest, seen, { categories: ',ai,', frequency: 'daily', since: 0, follows: ',author:writer,tag:ابن-خلدون,' })!;
        expect(m.title).toBe('ثاني');
        expect(m.body).toContain('⭐ @writer');
        expect(m.count).toBe(3);
    });
    it('leaves the categories alone without follows', () => {
        const m = digestMessage(digest, seen, { categories: ',ai,', frequency: 'daily', since: 0, follows: '' })!;
        expect(m.title).toBe('ثالث');
        expect(m.count).toBe(1);
    });
});

describe('nudges', () => {
    const digest: PushDigest = {
        generatedAt: '2026-10-10T00:00:00Z',
        categories: { history: 'التاريخ', ai: 'الذكاء الاصطناعي' },
        articles: [
            { s: 'long', t: 'طويل', c: 'ai', d: '2026-10-10', m: 14 },
            { s: 'short', t: 'قصير', c: 'ai', d: '2026-10-09', m: 3 },
            { s: 'other', t: 'آخر', c: 'history', d: '2026-10-09', m: 1 },
        ],
    };

    it('offers the shortest recent article in the subscriber’s topics', () => {
        expect(quickRead(digest, ',ai,')!.s).toBe('short');
        expect(quickRead(digest, '*')!.s).toBe('other');
    });
    it('links the streak reminder to that article', () => {
        const m = readingReminder(5, quickRead(digest, ',ai,'));
        expect(m.title).toBe('🔥 5 أيام متتالية');
        expect(m.url).toBe('/articles/short/?utm_source=push&utm_medium=streak');
        expect(m.body).toContain('«قصير»');
    });
    it('sums up the week, naming the top category', () => {
        const m = weeklyRecap({ week_reads: 9, week_minutes: 47, week_top: 'ai', read_streak: 4 }, digest.categories);
        expect(m.body).toBe('📖 9 مقالات · ⏱ 47 دقيقة · أكثر ما قرأت: الذكاء الاصطناعي\n🔥 سلسلتك: 4 أيام');
    });
});
