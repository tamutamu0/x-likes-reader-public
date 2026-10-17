-- No private notes or X credentials in the external preview cache.
CREATE TABLE link_previews (
  url_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT,
  image BLOB,
  image_type TEXT
);
CREATE INDEX link_previews_expiry ON link_previews(expires_at);
CREATE TABLE preview_daily_budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL);
