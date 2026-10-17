import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { processInbox, expireSources } from '../src/x-inbox';
import { source } from '../src/x-inbox';
import { ReaderStore } from '../src/store';

const now = '2026-10-12T12:00:00.000Z';
const postId = '8000000000000000003', authorId = '8000000000000000004';
const id = 'x:' + postId;
test('delivered name and handle reach contract source without any extra profile read',()=>{
  const snapshot=source({event_uuid:'fictional',post_id:postId,author_id:authorId,liked_at:now,received_at:now,
    post_json:JSON.stringify({id:postId,author_id:authorId,text:'架空',author:{name:'架空の投稿者',handle:'fixture_user'},entities:{urls:[]}})})!;
  assert.deepEqual(snapshot.author,{name:'架空の投稿者',handle:'fixture_user'});
});
const spec = JSON.parse(readFileSync(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false }); addFormats(ajv); ajv.addSchema(spec, 'contract');
const valid = ajv.getSchema('contract#/components/schemas/Item')!;
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_reader.sql', '0002_x_activity_inbox.sql', '0003_source_expiry.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  const prepare = (sql: string) => {
    let args: (string | number | null)[] = [];
    const s = {
      bind(...values: (string | number | null)[]) { args = values; return s; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
      async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
    }; return s;
  };
  let queue = Promise.resolve();
  const db = { prepare, batch(statements: ReturnType<typeof prepare>[]) {
    // D1 serializes transactions, while both callers can still select the
    // same pending rows before either transaction begins.
    const job = queue.then(async () => {
      sqlite.exec('BEGIN');
      try { const output = []; for (const s of statements) output.push(await s.run()); sqlite.exec('COMMIT'); return output; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    });
    queue = job.then(() => undefined, () => undefined); return job;
  } } as unknown as D1Database;
  function event(uuid: string, likedAt = now, text: string | null = '架空の通知本文', target = postId) {
    sqlite.prepare('INSERT INTO x_activity_inbox VALUES (?, ?, ?, ?, ?, ?, NULL)').run(uuid, target, authorId, likedAt, now,
      text === null ? null : JSON.stringify({ id: target, author_id: authorId, text, created_at: '2020-01-01T00:00:00.000Z',
        entities: { urls: [{ expanded_url: 'https://example.com/fictional' }, { expanded_url: 'javascript:bad' }, { expanded_url: 'https://example.com/fictional' }] } }));
  }
  function item() {
    const row = sqlite.prepare('SELECT * FROM items WHERE id = ?').get(id)!;
    const item = { id: row.id, revision: row.revision, updatedAt: row.updated_at,
      source: row.source_json ? JSON.parse(row.source_json as string) : null, user: JSON.parse(row.user_json as string), metadata: JSON.parse(row.metadata_json as string) };
    assert.ok(valid(item), JSON.stringify(valid.errors)); return item;
  }
  return { sqlite, db, event, item };
}

test('notification becomes a contract item and change, without fetching profiles or resetting user edits', async () => {
  const { db, sqlite, event, item } = setup(); event('first');
  await processInbox(db, now);
  const first = item(); assert.equal(first.source.text, '架空の通知本文'); assert.equal(first.source.author.handle, '');
  assert.equal(first.source.postedAt, '2020-01-01T00:00:00.000Z'); assert.equal(first.metadata.likedAt, now); assert.equal(first.source.links.length, 1);
  assert.equal(sqlite.prepare('SELECT post_json FROM x_activity_inbox').get()!.post_json, null);
  await new ReaderStore(db).patch(id, { expectedRevision: 1, changes: { read: true, memo: '本人のメモ', tags: ['自分のタグ'], genre: '自分の分類' } }, now);
  event('re-like', '2026-10-12T12:01:00.000Z', '新しい架空本文'); await processInbox(db, '2026-10-12T12:02:00.000Z');
  const next = item(); assert.deepEqual(next.user, { ...first.user, read: true, memo: '本人のメモ', tags: ['自分のタグ'], genre: '自分の分類' });
  assert.equal(next.source.text, '新しい架空本文'); assert.equal(next.revision, 3);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM changes').get()!.n, 3);
  await processInbox(db, now); assert.equal(item().revision, 3);
});

test('out-of-order events do not replace newer source or like time; two overlapping workers emit one change', async () => {
  const { db, sqlite, event, item } = setup(); event('same');
  await Promise.all([processInbox(db, now), processInbox(db, now)]);
  assert.equal(item().revision, 1); assert.equal(sqlite.prepare('SELECT count(*) n FROM changes').get()!.n, 1);
  event('old', '2026-10-12T11:00:00.000Z', '古い本文'); await processInbox(db, now);
  assert.equal(item().source.text, '架空の通知本文'); assert.equal(item().metadata.likedAt, now); assert.equal(item().revision, 1);
  assert.equal(sqlite.prepare("SELECT post_json FROM x_activity_inbox WHERE event_uuid = 'old'").get()!.post_json, null);
});

test('missing source uses only unexpired cache, leaves unknown posts pending and never revives removed source', async () => {
  const { db, event, item, sqlite } = setup(); event('first'); await processInbox(db, now);
  event('cache', '2026-10-12T12:01:00.000Z', null); await processInbox(db, '2026-10-12T12:02:00.000Z');
  assert.equal(item().source.text, '架空の通知本文'); assert.equal(item().metadata.fetchedAt, now); assert.equal(item().metadata.sourceStatus, 'available');
  event('unknown', now, null, '8000000000000000010'); await processInbox(db, now);
  const pending = sqlite.prepare("SELECT * FROM items WHERE id = 'x:8000000000000000010'").get()!;
  assert.equal(pending.source_json, null); assert.equal(JSON.parse(pending.metadata_json as string).sourceStatus, 'pending');
  event('waiting', '2026-10-12T12:03:00.000Z', '削除前の通知');
  await new ReaderStore(db).removeSource(id, '2026-10-12T12:04:00.000Z'); await processInbox(db, '2026-10-12T12:05:00.000Z');
  event('missing-after-delete', '2026-10-12T12:06:00.000Z', null); await processInbox(db, '2026-10-12T12:07:00.000Z');
  assert.equal(item().source, null); assert.equal(item().metadata.sourceStatus, 'removed');
  for (const row of sqlite.prepare('SELECT item_json FROM changes WHERE json_extract(item_json, \'$.id\') = ?').all(id))
    assert.equal(JSON.parse(row.item_json as string).source, null);
});

test('expiry scrubs source, history and pending inbox while preserving notes; old events cannot reset TTL', async () => {
  const { db, event, item, sqlite } = setup(); event('old', '2026-10-01T12:00:00.000Z');
  await processInbox(db, now); assert.equal(item().source, null); assert.equal(item().metadata.sourceStatus, 'expired');
  event('fresh'); await processInbox(db, now);
  await new ReaderStore(db).patch(id, { expectedRevision: 2, changes: { memo: '残すメモ', read: true } }, now);
  event('pending-expired', '2026-10-01T12:00:00.000Z', '消すinbox本文', '8000000000000000010');
  await expireSources(db, '2026-10-19T12:00:00.000Z');
  assert.equal(item().source, null); assert.equal(item().user.memo, '残すメモ'); assert.equal(item().user.read, true);
  for (const row of sqlite.prepare('SELECT item_json FROM changes').all()) assert.equal(JSON.parse(row.item_json as string).source, null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM x_activity_inbox WHERE post_json IS NOT NULL').get()!.n, 0);
  const revision = item().revision; await expireSources(db, '2026-10-20T12:00:00.000Z'); assert.equal(item().revision, revision);
  await expireSources(db, '2026-11-13T12:00:00.000Z');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM x_activity_inbox WHERE processed_at IS NOT NULL').get()!.n, 0);
});

test('old change snapshots expire even when current source is fresh; API never serves stale source during cleanup failure', async () => {
  const { db, event, item, sqlite } = setup(); event('first', '2026-10-01T12:00:00.000Z'); await processInbox(db, '2026-10-01T12:00:00.000Z');
  event('fresh'); await processInbox(db, now); await expireSources(db, now);
  assert.equal(item().source.text, '架空の通知本文');
  const rows = sqlite.prepare('SELECT item_json FROM changes ORDER BY cursor').all();
  assert.equal(JSON.parse(rows[0].item_json as string).source, null); assert.ok(JSON.parse(rows[1].item_json as string).source);
  sqlite.prepare("UPDATE items SET metadata_json = json_set(metadata_json, '$.fetchedAt', '2000-01-01T00:00:00.000Z')").run();
  assert.equal((await new ReaderStore(db).get(id))!.source, null);
  assert.equal((await new ReaderStore(db).changes(0, 100)).changes.at(-1)!.item.source, null);
});

test('failed transaction leaves source and processed marker untouched for retry; backlog bounded to twenty events', async () => {
  const { db, event, item, sqlite } = setup(); event('first');
  sqlite.exec("CREATE TRIGGER fail_processing BEFORE UPDATE ON x_activity_inbox BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  await assert.rejects(processInbox(db, now)); assert.equal(sqlite.prepare('SELECT count(*) n FROM items').get()!.n, 0);
  assert.equal(sqlite.prepare('SELECT processed_at FROM x_activity_inbox').get()!.processed_at, null);
  sqlite.exec('DROP TRIGGER fail_processing'); await processInbox(db, now); assert.equal(item().revision, 1);
  for (let n = 0; n < 21; n++) event('bulk' + n, now, null, String(8000000000000000100n + BigInt(n)));
  assert.deepEqual(await processInbox(db, now), { scanned: 20, hasMore: true });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM x_activity_inbox WHERE processed_at IS NULL').get()!.n, 1);
  assert.deepEqual(await processInbox(db, now), { scanned: 1, hasMore: false });
  await assert.rejects(processInbox(db, now, 21));
});
