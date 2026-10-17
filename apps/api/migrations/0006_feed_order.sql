CREATE TABLE IF NOT EXISTS x_feed_order (item_id TEXT PRIMARY KEY, position INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS x_feed_insert AFTER INSERT ON items
WHEN json_extract(NEW.metadata_json,'$.origin') = 'x' BEGIN
  INSERT OR IGNORE INTO x_feed_order(item_id,position)
  VALUES (NEW.id, (SELECT coalesce(min(position),0)-1 FROM x_feed_order));
END;
