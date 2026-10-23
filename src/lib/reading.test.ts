import { describe, expect, it } from 'vitest';
import {
    awardBadges,
    dealToday,
    markDone,
    openEntry,
    streak,
    todayProgress,
    toggleFollow,
    unfinished,
    type Candidate,
    type ReadingState,
} from './reading';

const T = 20_000;

function state(days: number[] = []): ReadingState {
    return {
        reads: [],
        days: Object.fromEntries(days.map((d) => [d, 1])),
        follows: [],
        badges: {},
        dailyDone: [],
        randoms: 0,
        best: 0,
    };
}

describe('streak', () => {
    it('counts consecutive days ending today', () => {
        expect(streak(state([T - 2, T - 1, T]), T)).toEqual({ current: 3, today: true, frozen: false });
    });
    it('stays alive through today until it is over', () => {
        expect(streak(state([T - 2, T - 1]), T)).toEqual({ current: 2, today: false, frozen: false });
    });
    it('forgives one missed day a week', () => {
        expect(streak(state([T - 3, T - 2, T]), T)).toEqual({ current: 3, today: true, frozen: true });
    });
    it('does not forgive two missed days in the same week', () => {
        expect(streak(state([T - 5, T - 3, T - 2, T]), T).current).toBe(3);
    });
    it('forgives again once a week has passed', () => {
        expect(streak(state([T - 9, T - 8, T - 6, T - 5, T - 4, T - 3, T - 2, T - 1, T]), T).current).toBe(9);
    });
    it('is broken by two missed days in a row', () => {
        expect(streak(state([T - 4, T - 3]), T).current).toBe(0);
    });
});

describe('history', () => {
    it('counts a read once, on its day, and tracks the best streak', () => {
        const s = state([T - 1]);
        openEntry(s, { s: 'a', t: 'A', c: 'ai' });
        expect(markDone(s, 'a', T)).toBe(true);
        expect(markDone(s, 'a', T)).toBe(false);
        expect(s.days[T]).toBe(1);
        expect(s.best).toBe(2);
    });
    it('lists opened but unread articles as unfinished', () => {
        const s = state();
        openEntry(s, { s: 'a', t: 'A', c: 'ai' });
        openEntry(s, { s: 'b', t: 'B', c: 'ai' });
        markDone(s, 'b', T);
        expect(unfinished(s).map((r) => r.s)).toEqual(['a']);
    });
});

describe('badges', () => {
    it('awards each achievement once', () => {
        const s = state();
        openEntry(s, { s: 'a', t: 'A', c: 'ai' });
        markDone(s, 'a', T);
        expect(awardBadges(s, { saved: 0, quizStreak: 0, hour: 2 }, T).map((b) => b.id)).toEqual(['first', 'night']);
        expect(awardBadges(s, { saved: 0, quizStreak: 0, hour: 2 }, T)).toEqual([]);
    });
});

describe('dealToday', () => {
    const candidates: Candidate[] = [
        { s: 'ai1', t: '', c: 'ai', d: '2026-10-10' },
        { s: 'ai2', t: '', c: 'ai', d: '2026-10-10' },
        { s: 'h1', t: '', c: 'history', d: '2026-10-10' },
        { s: 'p1', t: '', c: 'psychology', d: '2026-10-10' },
        { s: 'e1', t: '', c: 'economics', d: '2026-10-10' },
        { s: 'w1', t: '', c: 'writing', d: '2026-10-10', a: 'fav' },
        { s: 'read', t: '', c: 'art', d: '2026-10-10' },
    ];

    it('deals five unread articles from different categories, the same all day', () => {
        const s = state();
        openEntry(s, { s: 'read', t: '', c: 'art' });
        const picks = dealToday(s, candidates, T);
        expect(picks).toHaveLength(5);
        expect(picks.map((p) => p.s)).not.toContain('read');
        expect(new Set(picks.map((p) => p.c)).size).toBe(5);
        expect(dealToday(s, candidates, T)).toEqual(picks);
    });
    it('always includes a followed author', () => {
        const s = state();
        toggleFollow(s, { kind: 'author', id: 'fav', label: 'Fav' });
        for (let day = T; day < T + 10; day++) expect(dealToday(s, candidates, day).map((p) => p.s)).toContain('w1');
    });
    it('reports progress through the day’s picks', () => {
        const s = state();
        s.today = { day: T, picks: dealToday(s, candidates, T) };
        openEntry(s, { s: s.today.picks[0]!.s, t: '', c: '' });
        markDone(s, s.today.picks[0]!.s, T);
        expect(todayProgress(s, T)).toEqual({ done: 1, total: 5 });
        expect(todayProgress(s, T + 1)).toEqual({ done: 0, total: 5 });
    });
});
