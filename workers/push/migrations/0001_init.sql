-- Push subscriptions and their digest preferences (workers/push/src/index.ts).
CREATE TABLE subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    -- '*' or ',cat-a,cat-b,'
    categories TEXT NOT NULL DEFAULT '*',
    frequency TEXT NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
    -- ms: articles first seen after this are new to this subscriber
    since INTEGER NOT NULL,
    -- ms since epoch
    next_due_at INTEGER NOT NULL,
    last_sent_at INTEGER,
    last_test_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_next_due_at ON subscriptions (next_due_at);

-- One-off messages queued by the admin panel, drained by the cron trigger.
CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- What the admin panel sent, for its history.
CREATE TABLE broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    url TEXT NOT NULL,
    target TEXT NOT NULL,
    queued INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

-- Daily counters: sent, failed, gone, subscribed, unsubscribed, click, installed…
CREATE TABLE events (
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, name)
);

-- When the Worker first saw each article in the site's push digest: what
-- "new since your last notification" is measured against.
CREATE TABLE articles_seen (
    slug TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL
);
