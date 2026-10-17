-- Expression indexes match the expiry predicates and avoid scanning every
-- memo update to find source snapshots whose seven-day cache has expired.
CREATE INDEX items_x_source_expiry ON items(json_extract(metadata_json, '$.fetchedAt'))
  WHERE json_extract(metadata_json, '$.origin') = 'x' AND source_json IS NOT NULL;
CREATE INDEX changes_x_source_expiry ON changes(json_extract(item_json, '$.metadata.fetchedAt'))
  WHERE json_extract(item_json, '$.metadata.origin') = 'x' AND json_extract(item_json, '$.source') IS NOT NULL;
CREATE INDEX x_activity_inbox_retention ON x_activity_inbox(received_at) WHERE processed_at IS NOT NULL;
