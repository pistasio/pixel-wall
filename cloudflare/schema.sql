-- Apply to the D1 database once before deploying the Worker.
-- Grid cells are stored as validated 25-by-25 JSON arrays, never as screenshots.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  client_submission_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '' CHECK(length(name) <= 60),
  student_id TEXT NOT NULL DEFAULT '' CHECK(length(student_id) <= 80),
  grid_json TEXT NOT NULL CHECK(json_valid(grid_json) AND json_array_length(grid_json) = 25),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64)
);

CREATE INDEX IF NOT EXISTS submissions_created_at ON submissions(created_at DESC, id DESC);

-- A conservative ceiling leaves room below a free D1 database's storage limit.
-- This is not a promise of exact storage use: indexes, counters, and database overhead
-- also occupy space. Keep the account on the free plan and monitor its actual usage.
-- The count is initialized once when this schema is installed on an existing database.
CREATE TABLE IF NOT EXISTS wall_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  submission_count INTEGER NOT NULL CHECK(submission_count >= 0)
);

INSERT OR IGNORE INTO wall_state (id, submission_count) SELECT 1, COUNT(*) FROM submissions;

-- Optional email overflow retains only receipt metadata and a payload fingerprint.
-- Never put grid content, names, student IDs, or recipient addresses in this table.
-- Claims are not automatically deleted: keeping them prevents duplicate email attempts.
CREATE TABLE IF NOT EXISTS overflow_deliveries (
  client_submission_id TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed'))
);

CREATE TABLE IF NOT EXISTS overflow_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  delivery_count INTEGER NOT NULL CHECK(delivery_count >= 0)
);

INSERT OR IGNORE INTO overflow_state (id, delivery_count) SELECT 1, COUNT(*) FROM overflow_deliveries;

CREATE TRIGGER IF NOT EXISTS overflow_capacity BEFORE INSERT ON overflow_deliveries
WHEN COALESCE((SELECT delivery_count FROM overflow_state WHERE id = 1), 10000) >= 10000
  AND NOT EXISTS (SELECT 1 FROM overflow_deliveries WHERE client_submission_id = NEW.client_submission_id)
BEGIN
  SELECT RAISE(ABORT, 'PIXEL_WALL_OVERFLOW_FULL');
END;

CREATE TRIGGER IF NOT EXISTS overflow_count_insert AFTER INSERT ON overflow_deliveries
BEGIN
  UPDATE overflow_state SET delivery_count = delivery_count + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS overflow_count_delete AFTER DELETE ON overflow_deliveries
BEGIN
  UPDATE overflow_state SET delivery_count = delivery_count - 1 WHERE id = 1;
END;

-- Email receipts keep their identity even if organizers later free ordinary wall capacity.
-- Together with the conditional overflow insert, this prevents races between the two routes.
CREATE TRIGGER IF NOT EXISTS submissions_email_reference BEFORE INSERT ON submissions
WHEN EXISTS (SELECT 1 FROM overflow_deliveries WHERE client_submission_id = NEW.client_submission_id)
BEGIN
  SELECT RAISE(ABORT, 'PIXEL_WALL_EMAIL_REFERENCE');
END;

-- The check and count update execute in the insert transaction. Existing references
-- remain retryable when full, including detection of changed idempotency payloads.
CREATE TRIGGER IF NOT EXISTS submissions_capacity BEFORE INSERT ON submissions
WHEN COALESCE((SELECT submission_count FROM wall_state WHERE id = 1), 40000) >= 40000
  AND NOT EXISTS (SELECT 1 FROM submissions WHERE client_submission_id = NEW.client_submission_id)
  AND NOT EXISTS (SELECT 1 FROM overflow_deliveries WHERE client_submission_id = NEW.client_submission_id)
BEGIN
  SELECT RAISE(ABORT, 'PIXEL_WALL_FULL');
END;

CREATE TRIGGER IF NOT EXISTS submissions_count_insert AFTER INSERT ON submissions
BEGIN
  UPDATE wall_state SET submission_count = submission_count + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS submissions_count_delete AFTER DELETE ON submissions
BEGIN
  UPDATE wall_state SET submission_count = submission_count - 1 WHERE id = 1;
END;

-- Keys are secret-keyed HMACs of Cloudflare's client IP, not raw IP addresses.
-- There is one active minute counter per address and purpose across all Worker instances.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY CHECK(length(key) = 64),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0)
);

CREATE INDEX IF NOT EXISTS rate_limits_window_start ON rate_limits(window_start);
