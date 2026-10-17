CREATE TABLE IF NOT EXISTS browser_bootstrap (
  token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
