-- The reading habit (src/scripts/reading.ts → POST /api/push/read): the last
-- day the subscriber read an article (their local epoch day), their streak as
-- the app counts it (with its forgiven days; 0 when they turned it off), and
-- the last 7 days' numbers for the Friday recap.
ALTER TABLE subscriptions ADD COLUMN read_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN read_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN week_reads INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN week_minutes INTEGER NOT NULL DEFAULT 0;
-- category key read most in those 7 days
ALTER TABLE subscriptions ADD COLUMN week_top TEXT NOT NULL DEFAULT '';
-- Followed authors and tags (POST /api/push/follows): ',author:x,tag:y,'.
-- Digests include their new articles whatever the chosen categories.
ALTER TABLE subscriptions ADD COLUMN follows TEXT NOT NULL DEFAULT '';
-- The last day a nudge (streak reminder, weekly recap) went out: one a day
-- at most on top of the digest.
ALTER TABLE subscriptions ADD COLUMN nudged_day INTEGER NOT NULL DEFAULT 0;

-- Links readers suggest for the directory (the app's share target, /share/).
CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    -- times suggested
    n INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);
