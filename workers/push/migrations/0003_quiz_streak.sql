-- The Explore tab's question of the day (POST /api/push/quiz): the last day
-- answered and the run of days in a row, so the cron can remind a subscriber
-- in the evening before a streak breaks. Days are UTC epoch days.
ALTER TABLE subscriptions ADD COLUMN quiz_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN quiz_streak INTEGER NOT NULL DEFAULT 0;
-- The last day a streak reminder went out.
ALTER TABLE subscriptions ADD COLUMN quiz_reminded INTEGER NOT NULL DEFAULT 0;
