-- Separate from passkey enrollment: a locally issued owner login capability.
CREATE TABLE owner_link_permits (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
