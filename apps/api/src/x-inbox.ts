import type { Item } from './types';

const DAY = 86400000;
export const SOURCE_TTL = 7 * DAY;
export const EVENT_RETENTION = 30 * DAY;
type EventRow = { event_uuid: string; post_id: string; author_id: string; liked_at: string; received_at: string; post_json: string | null };
const emptyUser: Item['user'] = { state: 'inbox', read: false, laterUntil: null, tags: [], memo: '', genre: null };

export function source(event: EventRow): Item['source'] {
  if (!event.post_json) return null;
  const post = JSON.parse(event.post_json);
  if (post.id !== event.post_id || post.author_id !== event.author_id || typeof post.text !== 'string' || !post.text.trim()) return null;
  const links: NonNullable<Item['source']>['links'] = [];
  for (const entry of Array.isArray(post.entities?.urls) ? post.entities.urls.slice(0, 50) : []) {
    try {
      const url = new URL(entry.expanded_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048 || links.some(link => link.url === url.href)) continue;
      links.push({ url: url.href, title: typeof entry.title === 'string' && entry.title ? entry.title.slice(0, 200) : url.hostname,
        ...(typeof entry.description === 'string' && entry.description ? { description: entry.description.slice(0, 300) } : {}),
        ...(typeof entry.image_url === 'string' && /^https:\/\//.test(entry.image_url) ? { imageUrl: entry.image_url } : {}) });
    } catch { /* Invalid URLs cannot become clickable source links. */ }
  }
  return {
    postId: event.post_id, url: 'https://x.com/i/web/status/' + event.post_id,
    author: post.author && typeof post.author.name==='string' && typeof post.author.handle==='string' && (!post.author.handle || /^[A-Za-z0-9_]{1,15}$/.test(post.author.handle))
      ? { name: post.author.name.slice(0,60) || 'X の投稿', handle: post.author.handle } : { name: 'X の投稿', handle: '' },
    text: post.text, postedAt: post.created_at, links,
  };
}

// Each event's item write and processed marker are one D1 transaction. The
// INSERT SELECT predicate is rechecked inside that transaction, so two callers
// reading the same pending row cannot create two changes or reset user edits.
export async function processInbox(db: D1Database, now = new Date().toISOString(), limit = 20) {
  if (!Number.isFinite(Date.parse(now)) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid processing parameters');
  const cutoff = new Date(Date.parse(now) - SOURCE_TTL).toISOString();
  const { results } = await db.prepare(`SELECT event_uuid, post_id, author_id, liked_at, received_at, post_json
    FROM x_activity_inbox WHERE processed_at IS NULL ORDER BY received_at, event_uuid LIMIT ?`).bind(limit).all<EventRow>();
  const statements: D1PreparedStatement[] = [];
  for (const event of results) {
    // A delayed/replayed notification cannot grant its old source a new TTL.
    const fetchedAt = new Date(Math.min(Date.parse(event.liked_at), Date.parse(event.received_at), Date.parse(now))).toISOString();
    const expired = fetchedAt <= cutoff;
    const snapshot = expired ? null : source(event);
    const metadata: Item['metadata'] = { origin: 'x', fictional: false, sourceStatus: snapshot ? 'available' : expired ? 'expired' : 'pending', fetchedAt, likedAt: event.liked_at };
    statements.push(db.prepare(`INSERT INTO items (id, revision, source_json, user_json, metadata_json, updated_at)
      SELECT ?, 1, ?, ?, ?, ? FROM x_activity_inbox WHERE event_uuid = ? AND processed_at IS NULL
      ON CONFLICT(id) DO UPDATE SET
        source_json = CASE
          WHEN excluded.source_json IS NOT NULL AND (items.source_json IS NULL OR json_extract(items.metadata_json, '$.fetchedAt') <= ?) THEN excluded.source_json
          WHEN items.source_json IS NOT NULL AND json_extract(items.metadata_json, '$.sourceStatus') = 'available' AND json_extract(items.metadata_json, '$.fetchedAt') > ? THEN items.source_json
          ELSE NULL END,
        metadata_json = CASE
          WHEN excluded.source_json IS NULL AND json_extract(items.metadata_json, '$.sourceStatus') IN ('removed', 'expired')
          THEN json_set(items.metadata_json, '$.likedAt', ?, '$.origin', 'x', '$.fictional', json('false'))
          WHEN items.source_json IS NOT NULL AND json_extract(items.metadata_json, '$.sourceStatus') = 'available'
            AND json_extract(items.metadata_json, '$.fetchedAt') > ? AND (excluded.source_json IS NULL OR json_extract(items.metadata_json, '$.fetchedAt') > ?)
          THEN json_set(items.metadata_json, '$.likedAt', ?, '$.origin', 'x', '$.fictional', json('false'))
          ELSE excluded.metadata_json END,
        revision = items.revision + 1, updated_at = excluded.updated_at
      WHERE coalesce(json_extract(items.metadata_json, '$.likedAt'), '') < ?`)
      .bind('x:' + event.post_id, snapshot ? JSON.stringify(snapshot) : null, JSON.stringify(emptyUser), JSON.stringify(metadata), now,
        event.event_uuid, fetchedAt, cutoff, event.liked_at, cutoff, fetchedAt, event.liked_at, event.liked_at));
    // The UUID remains for deduplication, but processed source text is removed.
    statements.push(db.prepare('UPDATE x_activity_inbox SET processed_at = ?, post_json = NULL WHERE event_uuid = ? AND processed_at IS NULL').bind(now, event.event_uuid));
  }
  if (statements.length) await db.batch(statements);
  return { scanned: results.length, hasMore: results.length === limit };
}

export async function expireSources(db: D1Database, now = new Date().toISOString()) {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) throw new Error('invalid expiry timestamp');
  const cutoff = new Date(time - SOURCE_TTL).toISOString();
  const dedupCutoff = new Date(time - EVENT_RETENTION).toISOString();
  await db.batch([
    // Historical snapshots have their own TTL, even when current source was
    // refreshed. Never return an older expired copy via the changes endpoint.
    db.prepare(`UPDATE changes SET item_json = json_set(item_json, '$.source', NULL, '$.metadata.sourceStatus', 'expired')
      WHERE json_extract(item_json, '$.metadata.origin') = 'x' AND json_extract(item_json, '$.source') IS NOT NULL
        AND json_extract(item_json, '$.metadata.fetchedAt') <= ?`).bind(cutoff),
    db.prepare(`UPDATE items SET source_json = NULL, metadata_json = json_set(metadata_json, '$.sourceStatus', 'expired'), revision = revision + 1, updated_at = ?
      WHERE json_extract(metadata_json, '$.origin') = 'x' AND source_json IS NOT NULL AND json_extract(metadata_json, '$.fetchedAt') <= ?`).bind(now, cutoff),
    db.prepare('UPDATE x_activity_inbox SET post_json = NULL WHERE post_json IS NOT NULL AND (liked_at <= ? OR received_at <= ? OR processed_at IS NOT NULL)').bind(cutoff, cutoff),
    db.prepare('DELETE FROM x_activity_inbox WHERE processed_at IS NOT NULL AND received_at <= ?').bind(dedupCutoff),
  ]);
}
