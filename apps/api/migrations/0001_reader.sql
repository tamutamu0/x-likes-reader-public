CREATE TABLE items (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json)),
  user_json TEXT NOT NULL CHECK (json_valid(user_json)),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  updated_at TEXT NOT NULL
);

-- Each write appends a snapshot in the same SQLite transaction.
-- A deletion of X content updates source_json to NULL, preserving personal notes.
CREATE TABLE changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  item_json TEXT NOT NULL CHECK (json_valid(item_json))
);
CREATE TRIGGER items_insert_change AFTER INSERT ON items BEGIN
  INSERT INTO changes (item_json) VALUES (json_object(
    'id', NEW.id, 'revision', NEW.revision, 'updatedAt', NEW.updated_at,
    'source', json(NEW.source_json), 'user', json(NEW.user_json), 'metadata', json(NEW.metadata_json)
  ));
END;
CREATE TRIGGER items_update_change AFTER UPDATE ON items BEGIN
  INSERT INTO changes (item_json) VALUES (json_object(
    'id', NEW.id, 'revision', NEW.revision, 'updatedAt', NEW.updated_at,
    'source', json(NEW.source_json), 'user', json(NEW.user_json), 'metadata', json(NEW.metadata_json)
  ));
END;

-- Only hashes of app-specific device session tokens are stored.
-- Session provisioning/login is deliberately not exposed in this milestone.
CREATE TABLE device_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
