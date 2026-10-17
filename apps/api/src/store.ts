import type { Item, PatchRequest, ChangePage } from './types';
import { SOURCE_TTL } from './x-inbox';

function readable(item: Item): Item {
  // Even if the scheduled cleanup is delayed, never serve expired source.
  const fetchedAt = Date.parse(item.metadata.fetchedAt);
  if (item.metadata.origin === 'x' && item.source && (!Number.isFinite(fetchedAt) || fetchedAt <= Date.now() - SOURCE_TTL))
    return { ...item, source: null, metadata: { ...item.metadata, sourceStatus: 'expired' } };
  return item;
}

type Row = { id: string; revision: number; updated_at: string; source_json: string | null; user_json: string; metadata_json: string };
function decode(row: Row): Item {
  return readable({
    id: row.id, revision: row.revision, updatedAt: row.updated_at,
    source: row.source_json === null ? null : JSON.parse(row.source_json),
    user: JSON.parse(row.user_json), metadata: JSON.parse(row.metadata_json),
  });
}

export class ReaderStore {
  constructor(private readonly db: D1Database) {}

  async list(cursor: string | null, limit: number) {
    const query = cursor
      ? this.db.prepare('SELECT * FROM items WHERE id > ? ORDER BY id LIMIT ?').bind(cursor, limit + 1)
      : this.db.prepare('SELECT * FROM items ORDER BY id LIMIT ?').bind(limit + 1);
    const { results } = await query.all<Row>();
    const items = results.slice(0, limit).map(decode);
    return { items, nextCursor: results.length > limit ? items.at(-1)!.id : null };
  }

  async get(id: string): Promise<Item | null> {
    const row = await this.db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first<Row>();
    return row ? decode(row) : null;
  }

  async patch(id: string, request: PatchRequest, now: string) {
    const current = await this.get(id);
    if (!current) return { status: 'missing' as const };
    if (current.revision !== request.expectedRevision) return { status: 'conflict' as const, item: current };
    const user = { ...current.user, ...request.changes };
    // SQL compare-and-swap, not a read-then-unconditional-write.
    const row = await this.db.prepare(
      'UPDATE items SET user_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? RETURNING *'
    ).bind(JSON.stringify(user), now, id, request.expectedRevision).first<Row>();
    if (row) return { status: 'ok' as const, item: decode(row) };
    const latest = await this.get(id);
    return latest ? { status: 'conflict' as const, item: latest } : { status: 'missing' as const };
  }

  async changes(after: number, limit: number): Promise<ChangePage> {
    const { results } = await this.db.prepare('SELECT cursor, item_json FROM changes WHERE cursor > ? ORDER BY cursor LIMIT ?')
      .bind(after, limit + 1).all<{ cursor: number; item_json: string }>();
    const changes = results.slice(0, limit).map(r => ({ cursor: r.cursor, item: readable(JSON.parse(r.item_json) as Item) }));
    return { changes, nextCursor: changes.at(-1)?.cursor ?? after, hasMore: results.length > limit };
  }

  async validSession(hash: string, now: string) {
    return !!await this.db.prepare('SELECT token_hash FROM device_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > ?')
      .bind(hash, now).first();
  }

  // Server-only content removal. Also redact historical snapshots, since they
  // would otherwise leak removed source text to a freshly syncing device.
  async removeSource(id: string, now: string) {
    await this.db.batch([
      this.db.prepare('UPDATE x_activity_inbox SET post_json = NULL, processed_at = coalesce(processed_at, ?) WHERE post_id = ?').bind(now, id.slice(2)),
      this.db.prepare("UPDATE changes SET item_json = json_set(item_json, '$.source', NULL, '$.metadata.sourceStatus', 'removed') WHERE json_extract(item_json, '$.id') = ?").bind(id),
      this.db.prepare("UPDATE items SET source_json = NULL, metadata_json = json_set(metadata_json, '$.sourceStatus', 'removed'), revision = revision + 1, updated_at = ? WHERE id = ?").bind(now, id),
    ]);
  }
}
