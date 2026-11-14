-- Articles readers write on /write/ (POST /api/push/submit). They wait here
-- until the admin panel (scripts/admin.ts) approves one, which writes it to
-- src/content/community/<slug>.md, or rejects it. The email is never published.
CREATE TABLE submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    category TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL DEFAULT '',
    author_url TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    -- salted SHA-256 of the sender's IP, for the daily limit (never the IP itself)
    ip_hash TEXT NOT NULL DEFAULT '',
    -- pending | approved | rejected
    status TEXT NOT NULL DEFAULT 'pending',
    -- the published slug once approved
    slug TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX submissions_status ON submissions (status, created_at);
CREATE INDEX submissions_ip ON submissions (ip_hash, created_at);
