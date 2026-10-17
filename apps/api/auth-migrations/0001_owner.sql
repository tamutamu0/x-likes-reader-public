-- Authentication store only: no X content, tokens, notes or profiles.
CREATE TABLE owner_passkey (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  user_handle TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE device_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  kind TEXT NOT NULL CHECK(kind IN ('web','setup'))
);
CREATE TABLE browser_bootstrap (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('register','login')),
  session_hash TEXT,
  user_handle TEXT,
  expires_at TEXT NOT NULL
);
CREATE TRIGGER owner_enrolled AFTER INSERT ON owner_passkey BEGIN
  UPDATE device_sessions SET revoked=1;
END;
