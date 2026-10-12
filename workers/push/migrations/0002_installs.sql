-- Installed apps (POST /api/push/ping): one row per device running the site
-- from its home screen, keyed by a random id the app keeps in localStorage.
-- Unlike the 'installed' event, this sees iOS installs too (Safari never fires
-- appinstalled) and tells which installs are still being opened.
CREATE TABLE installs (
    id TEXT PRIMARY KEY,
    -- ios | android | desktop | other
    platform TEXT NOT NULL,
    -- ms since epoch
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    -- days the app was opened
    days INTEGER NOT NULL DEFAULT 1,
    -- 1 when notifications were on at the last open
    push INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX installs_last_seen ON installs (last_seen);

-- 1 when the subscription was made from the installed app.
ALTER TABLE subscriptions ADD COLUMN app INTEGER NOT NULL DEFAULT 0;
