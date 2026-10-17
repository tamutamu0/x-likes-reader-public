-- Private durable inbox. Public webhook can only append verified owner events.
-- post_json is an optional minimal source snapshot, never the raw X payload.
CREATE TABLE x_activity_inbox (
  event_uuid TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  liked_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  post_json TEXT CHECK (post_json IS NULL OR json_valid(post_json)),
  processed_at TEXT
);
CREATE INDEX x_activity_inbox_pending ON x_activity_inbox(processed_at, received_at);
