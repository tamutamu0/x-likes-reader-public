import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { components } from '../../../packages/contracts/generated';
import { DatabaseSync } from 'node:sqlite';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { app } from '../src/index';
import { ReaderStore } from '../src/store';
import type { Bindings } from '../src/types';
import { ReaderClient, APIError } from '../../../packages/contracts/client';

const spec = JSON.parse(readFileSync(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(spec, 'contract');
type Schemas = components['schemas'];
function contract<N extends keyof Schemas>(name: N, value: unknown): asserts value is Schemas[N] {
  const validate = ajv.getSchema('contract#/components/schemas/' + name)!;
  assert.ok(validate(value), JSON.stringify(validate.errors));
}

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_reader.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_x_activity_inbox.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_source_expiry.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../../packages/contracts/fixtures/seed.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string) => {
    let args: (string | number | null)[] = [];
    const statement = {
      bind(...values: (string | number | null)[]) { args = values; return statement; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
      async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  } as unknown as D1Database;
  return { db, sqlite, env: { DB: db, APP_ENV: 'local' } satisfies Bindings };
}
const id = 'x:8000000000000000001';
function request(env: Bindings, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return app.request('http://127.0.0.1:8787' + path, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: { 'X-Margin-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

test('fixture and responses conform to the versioned OpenAPI contract; IDs preserve integer precision', async () => {
  contract('ItemPage', JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/items.json', import.meta.url), 'utf8')));
  const { env } = database();
  const health = await request(env, '/v1/health'); contract('Health', await health.json());
  const res = await request(env, '/v1/items');
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const page = await res.json(); contract('ItemPage', page);
  assert.ok(page.items[0].source);
  assert.equal(page.items[0].source.postId, '8000000000000000001');
  assert.equal(page.items[0].metadata.fictional, true);
});

test('cursor pagination and empty change polls do not lose records or move backwards', async () => {
  const { env } = database();
  const first = await (await request(env, '/v1/items?limit=1')).json(); contract('ItemPage', first);
  const second = await (await request(env, '/v1/items?limit=1&cursor=' + encodeURIComponent(first.nextCursor!))).json(); contract('ItemPage', second);
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
  const changes1 = await (await request(env, '/v1/changes?limit=1')).json(); contract('ChangePage', changes1);
  assert.equal(changes1.hasMore, true);
  const changes2 = await (await request(env, '/v1/changes?limit=1&after=' + changes1.nextCursor)).json(); contract('ChangePage', changes2);
  assert.equal(changes2.hasMore, false);
  const empty = await (await request(env, '/v1/changes?after=' + changes2.nextCursor)).json();
  assert.deepEqual(empty, { changes: [], nextCursor: changes2.nextCursor, hasMore: false });
});

test('two devices editing the same revision: one succeeds, the other conflicts without overwriting notes', async () => {
  const { env } = database();
  const updates = await Promise.all([
    request(env, '/v1/items/' + id, { expectedRevision: 1, changes: { memo: 'iPhoneのメモ' } }),
    request(env, '/v1/items/' + id, { expectedRevision: 1, changes: { memo: 'PCのメモ' } }),
  ]);
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
  const winner = await updates.find(r => r.status === 200)!.json(); contract('Item', winner);
  const conflict = await updates.find(r => r.status === 409)!.json(); contract('Conflict', conflict);
  assert.equal(conflict.item.user.memo, winner.user.memo);
  assert.equal(winner.revision, 2);
  const next = await request(env, '/v1/items/' + id, { expectedRevision: 2, changes: { read: true } });
  const item = await next.json(); contract('Item', item); assert.equal(item.user.memo, winner.user.memo); assert.equal(item.user.read, true);
});

test('source removal scrubs current and historical content but preserves user notes and emits a tombstone', async () => {
  const { db, env, sqlite } = database();
  await request(env, '/v1/items/' + id, { expectedRevision: 1, changes: { memo: '自分のメモを保全' } });
  await new ReaderStore(db).removeSource(id, '2026-10-12T01:00:00.000Z');
  const current = await (await request(env, '/v1/items/' + id)).json(); contract('Item', current);
  assert.equal(current.source, null); assert.equal(current.metadata.sourceStatus, 'removed');
  assert.equal(current.user.memo, '自分のメモを保全');
  const page = await (await request(env, '/v1/changes')).json(); contract('ChangePage', page);
  for (const change of page.changes.filter(x => x.item.id === id)) assert.equal(change.item.source, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM changes WHERE item_json LIKE '%これは開発確認用%'").get()!.n, 0);
});

test('unauthenticated production and public-host demo requests fail closed; spoofed owner headers do not grant access', async () => {
  const { db } = database();
  for (const env of [{ DB: db, APP_ENV: 'production' }, { DB: db, APP_ENV: 'local' }]) {
    const res = await app.request('https://margin.example/v1/items', { headers: { 'X-Margin-Request': '1', 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } }, env);
    assert.equal(res.status, 401); contract('Error', await res.json());
  }
  assert.equal((await request({}, '/v1/items')).status, 503);
});

test('legacy per-device hashes are checked in development; missing passkey store never enables them in production', async () => {
  const { db, sqlite } = database();
  const token = 'SYNTHETIC_DEVICE_SESSION_NOT_REAL_12345678901234567890';
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('hex');
  sqlite.prepare('INSERT INTO device_sessions VALUES (?, ?, 0)').run(hash, '2200-01-01T00:00:00.000Z');
  const env = { DB: db, APP_ENV: 'local' };
  const headers = { Authorization: 'Bearer ' + token };
  const call = () => app.request('https://margin.example/v1/items', { headers }, env);
  assert.equal((await call()).status, 200);
  assert.equal((await app.request('https://margin.example/v1/items',{headers},{DB:db,APP_ENV:'production'})).status,401);
  sqlite.prepare('UPDATE device_sessions SET revoked = 1').run(); assert.equal((await call()).status, 401);
  sqlite.prepare("UPDATE device_sessions SET revoked = 0, expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await call()).status, 401);
});

test('cross-origin requests, unknown fields, bad revisions, invalid pagination and oversized bodies are rejected', async () => {
  const { env } = database();
  assert.equal((await request(env, '/v1/items', undefined, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await app.request('http://127.0.0.1:8787/v1/items', {}, env)).status, 401);
  for (const body of [
    { expectedRevision: 1, changes: { source: {} } }, { expectedRevision: 0, changes: { read: true } },
    { expectedRevision: 1, changes: { tags: ['a', 'a'] } }, { expectedRevision: 1, changes: {} },
    { expectedRevision: 1, changes: { read: 'true' } }, { expectedRevision: 1, changes: { memo: 'a'.repeat(10001) } },
    { expectedRevision: 1, changes: { laterUntil: 'tomorrow' } },
    { expectedRevision: 1, changes: { laterUntil: '2026-02-30T00:00:00Z' } },
  ]) assert.equal((await request(env, '/v1/items/' + id, body)).status, 400);
  assert.equal((await request(env, '/v1/items/' + id, { expectedRevision: 1, changes: { memo: 'a'.repeat(70000) } })).status, 413);
  for (const query of ['/v1/items?limit=0', '/v1/items?limit=101', '/v1/items?cursor=bad', '/v1/changes?after=-1', '/v1/changes?after=9007199254740992'])
    assert.equal((await request(env, query)).status, 400);
});

test('Web client consumes the same API, updates personal state, and surfaces a competing-device conflict', async () => {
  const { env } = database();
  const client = new ReaderClient('http://127.0.0.1:8787', {
    localDevelopment: true,
    fetch: ((url: string | URL | Request, options?: RequestInit) => app.request(url as string, options, env)) as typeof fetch,
  });
  const page = await client.items();
  const item = page.items[0];
  const updated = await client.patch(item.id, item.revision, { memo: 'Webから保存', tags: ['開発確認'] });
  assert.equal(updated.user.memo, 'Webから保存');
  await assert.rejects(client.patch(item.id, item.revision, { memo: '古い更新' }), (e: unknown) =>
    e instanceof APIError && e.status === 409 && e.item?.user.memo === 'Webから保存');
  const changes = await client.changes(2); assert.equal(changes.changes.at(-1)!.item.user.memo, 'Webから保存');
});
