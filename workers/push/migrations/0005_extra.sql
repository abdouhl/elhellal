-- "More notifications" (opt-in, daily subscribers): on top of the evening
-- digest and nudge, a morning article, the quote of the day and the quiz
-- question, up to five a day. extra_sent is a bitmask of the extra slots
-- already sent on extra_day (a UTC epoch day), so each goes out once.
ALTER TABLE subscriptions ADD COLUMN extra INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN extra_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN extra_sent INTEGER NOT NULL DEFAULT 0;
