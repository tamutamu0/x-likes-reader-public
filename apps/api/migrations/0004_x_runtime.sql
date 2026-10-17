CREATE TABLE IF NOT EXISTS x_runtime (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK(json_valid(value))
);
CREATE TABLE IF NOT EXISTS x_control_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1), owner TEXT NOT NULL, until_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS x_budget (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, units INTEGER NOT NULL CHECK(units >= 0), kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS x_budget_at ON x_budget(at);
-- Provisional reservation, NOT an asserted X price. A duplicated UUID never
-- reserves twice. Imported historical posts don't run this trigger.
CREATE TRIGGER IF NOT EXISTS x_event_reservation AFTER INSERT ON x_activity_inbox BEGIN
  INSERT OR IGNORE INTO x_budget(id, at, units, kind)
  VALUES ('event:' || NEW.event_uuid, NEW.received_at, 10000, 'activity_pending_price');
END;
CREATE TABLE IF NOT EXISTS x_lookup_attempts (
  post_id TEXT PRIMARY KEY, attempted_at TEXT NOT NULL
);
