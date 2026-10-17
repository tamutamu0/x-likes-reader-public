import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { webhookApp, postSnapshot, type WebhookBindings } from '../src/x-webhook';

const secret = 'SYNTHETIC_OAUTH2_CLIENT_SECRET_NOT_REAL';
const owner = '8000000000000000001';
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0002_x_activity_inbox.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql: string) {
    return { bind(...args: (string | null)[]) { return { async run() { sqlite.prepare(sql).run(...args); return { success: true }; } }; } };
  } } as unknown as D1Database;
  const env: WebhookBindings = { DB: db, X_WEBHOOK_ENABLED: 'true', X_OWNER_ID: owner, X_OAUTH2_CLIENT_SECRET: secret };
  return { sqlite, env };
}
function event() { return { data: {
  event_uuid: '-8000000000000000002', event_type: 'like.create', created_at: '2026-10-12T02:00:00.000Z',
  filter: { user_id: owner, direction: 'outbound' },
  payload: { liking_user_id: owner, liked_tweet_id: '8000000000000000003', liked_tweet_author_id: '8000000000000000004', created_at: '2020-01-01T00:00:00Z' },
  includes: { tweets: [{ id: '8000000000000000003', author_id: '8000000000000000004', text: '架空の投稿', created_at: '2020-01-01T00:00:00Z',
    entities: { urls: [{ url: 'https://t.co/fictional', expanded_url: 'https://example.com/article' }] } }],
    users: [{ id: '8000000000000000004', description: 'DO_NOT_STORE_PROFILE' }] },
} }; }
const signature = (raw: string) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('base64');
test('delivered author identity and link metadata retained without profiles or unrelated users',()=>{
  const data:any=event().data;
  data.includes.users=[{id:'999',name:'WRONG',username:'wrong'},{id:data.payload.liked_tweet_author_id,name:'架空の投稿者',username:'fixture_user',description:'DO_NOT_RETAIN',profile_image_url:'https://example.com/avatar'}];
  Object.assign(data.includes.tweets[0].entities.urls[0],{title:'架空の記事',description:'架空の説明',images:[{url:'https://example.com/card.png'}]});
  const p=postSnapshot(data,data.payload.liked_tweet_id,data.payload.liked_tweet_author_id)!;
  assert.deepEqual(p.author,{name:'架空の投稿者',handle:'fixture_user'});assert.equal(p.entities.urls[0].title,'架空の記事');
  assert.ok(!JSON.stringify(p).includes('DO_NOT_RETAIN'));assert.ok(!JSON.stringify(p).includes('WRONG'));assert.ok(!JSON.stringify(p).includes('avatar'));
});
const post = (env: WebhookBindings, raw: string, headers: Record<string, string> = {}) => webhookApp.request('https://events.example/webhooks/x', {
  method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Twitter-Webhooks-Signature-OAuth2': signature(raw), ...headers },
}, env);

test('disabled and incomplete configurations fail closed; public worker never exposes reader or admin API', async () => {
  const { env, sqlite } = setup();
  for (const overrides of [{ X_WEBHOOK_ENABLED: 'false' }, { X_OAUTH2_CLIENT_SECRET: '' }, { X_OWNER_ID: 'bad' }, { DB: undefined }])
    assert.equal((await post({ ...env, ...overrides }, JSON.stringify(event()))).status, 503);
  for (const path of ['/v1/items', '/v1/changes', '/v1/health', '/admin', '/'])
    assert.equal((await webhookApp.request('https://events.example' + path, {}, env)).status, 404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 0);
});

test('CRC uses OAuth2 client secret; invalid challenges rejected and responses not cached', async () => {
  const { env } = setup();
  const res = await webhookApp.request('https://events.example/webhooks/x?crc_token=fictional-challenge', {}, env);
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { response_token: signature('fictional-challenge') });
  assert.equal((await webhookApp.request('https://events.example/webhooks/x', {}, env)).status, 400);
  assert.equal((await webhookApp.request('https://events.example/webhooks/x?crc_token=' + 'x'.repeat(1025), {}, env)).status, 400);
});

test('tampering, missing signatures and a legacy header never authenticate a payload', async () => {
  const { env, sqlite } = setup(); const raw = JSON.stringify(event());
  for (const header of ['', 'sha256=invalid', signature(raw + ' '), 'sha256=' + 'A'.repeat(43) + '='])
    assert.equal((await post(env, raw, { 'X-Twitter-Webhooks-Signature-OAuth2': header, 'X-Twitter-Webhooks-Signature': signature(raw) })).status, 401);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 0);
});
test('CRC cannot be used as an oracle to sign an arbitrary webhook event',async()=>{
  const {env,sqlite}=setup(),raw=JSON.stringify(event());
  assert.ok(raw.length<=1024,'regression must exercise the signing-oracle restriction, not the size guard');
  const result=await webhookApp.request('https://events.example/webhooks/x?crc_token='+encodeURIComponent(raw),{},env);
  assert.equal(result.status,400);assert.deepEqual(await result.json(),{error:'invalid_request'});
  assert.equal(sqlite.prepare('SELECT count(*) n FROM x_activity_inbox').get()!.n,0);
});

test('signed owner event saved before ACK; replay is idempotent and keeps event time separate from old post time', async () => {
  const { env, sqlite } = setup(); const raw = JSON.stringify(event());
  assert.equal((await post(env, raw)).status, 200);
  const row = sqlite.prepare('SELECT * FROM x_activity_inbox').get()!;
  assert.equal(row.post_id, '8000000000000000003'); assert.equal(row.liked_at, '2026-10-12T02:00:00.000Z');
  assert.equal(JSON.parse(row.post_json as string).created_at, '2020-01-01T00:00:00.000Z');
  assert.ok(!(row.post_json as string).includes('DO_NOT_STORE_PROFILE'));
  assert.equal((await post(env, raw)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 1);
  assert.deepEqual(sqlite.prepare('SELECT * FROM x_activity_inbox').get(), row);
});

test('other actors, inbound likes and other event types ACK without storing or fetching', async () => {
  const { env, sqlite } = setup();
  for (const variant of ['actor', 'filter', 'direction', 'qualifier', 'type']) {
    const e: any = event();
    if (variant === 'actor') e.data.payload.liking_user_id = '999';
    if (variant === 'filter') e.data.filter.user_id = '999';
    if (variant === 'direction') e.data.filter.direction = 'inbound';
    if (variant === 'qualifier') e.data.filter.qualifiers = { direction: 'inbound' };
    if (variant === 'type') e.data.event_type = 'profile.update.bio';
    assert.equal((await post(env, JSON.stringify(e))).status, 200);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 0);
});

test('one-post trial rejects other posts and stops storing after its deadline', async () => {
  const { env, sqlite } = setup(); const raw = JSON.stringify(event());
  for (const extra of [{ X_ALLOWED_POST_ID: '999' }, { X_ALLOWED_POST_ID: 'invalid' },
    { X_RECEIVE_UNTIL: 'invalid' }, { X_RECEIVE_UNTIL: '2000-01-01T00:00:00Z' }])
    assert.equal((await post({ ...env, ...extra }, raw)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 0);
  assert.equal((await post({ ...env, X_ALLOWED_POST_ID: '8000000000000000003', X_RECEIVE_UNTIL: '2099-01-01T00:00:00Z' }, raw)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 1);
});

test('missing, withheld or mismatching source remains pending; note text is preserved and unsafe URLs discarded', async () => {
  for (const variant of ['missing', 'withheld', 'author', 'note']) {
    const { env, sqlite } = setup(); const e: any = event();
    if (variant === 'missing') delete e.data.includes.tweets;
    if (variant === 'withheld') e.data.includes.tweets[0].withheld = { country_codes: ['XX'] };
    if (variant === 'author') e.data.includes.tweets[0].author_id = '999';
    if (variant === 'note') { e.data.includes.tweets[0].note_tweet = { text: '架空の長い本文' }; e.data.includes.tweets[0].entities.urls.push({ url: 'javascript:bad', expanded_url: 'https://user:pass@example.com/' }); }
    assert.equal((await post(env, JSON.stringify(e))).status, 200);
    const row = sqlite.prepare('SELECT * FROM x_activity_inbox').get()!;
    if (variant === 'note') { const p = JSON.parse(row.post_json as string); assert.equal(p.text, '架空の長い本文'); assert.equal(p.entities.urls.length, 1); }
    else assert.equal(row.post_json, null);
  }
});

test('oversized streamed input, unsupported encoding and malformed signed data rejected without storage', async () => {
  const { env, sqlite } = setup();
  assert.equal((await post(env, 'x'.repeat(262145), { 'Content-Length': '1' })).status, 413);
  assert.equal((await post(env, '{}', { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await post(env, '{}', { 'Content-Type': 'text/plain' })).status, 415);
  for (const raw of ['{', '{}', '{"data":[]}', JSON.stringify({ data: { event_type: 'like.create' } })])
    assert.equal((await post(env, raw)).status, 400);
  const e: any = event(); e.data.payload.liked_tweet_id = 8000000000000000003;
  assert.equal((await post(env, JSON.stringify(e))).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox').get()!.n, 0);
});

test('database failure returns a retryable response with no secrets or source text', async () => {
  const { env } = setup(); env.DB = { prepare() { throw new Error(secret); } } as unknown as D1Database;
  const res = await post(env, JSON.stringify(event()));
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: 'unavailable' });
});

test('durable ACK survives a lost private RPC wakeup; no public processing route is exposed', async () => {
  const { env, sqlite } = setup(); const pending: Promise<unknown>[] = [];
  let called = 0;
  env.X_INBOX_PROCESSOR = { async process() { called++; throw new Error('synthetic lost RPC'); } };
  const res = await webhookApp.request('https://events.example/webhooks/x', {
    method: 'POST', body: JSON.stringify(event()), headers: { 'Content-Type': 'application/json', 'X-Twitter-Webhooks-Signature-OAuth2': signature(JSON.stringify(event())) },
  }, env, { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}, props: {} });
  assert.equal(res.status, 200); await Promise.all(pending); assert.equal(called, 1);
  assert.equal(sqlite.prepare('SELECT processed_at FROM x_activity_inbox').get()!.processed_at, null);
  assert.equal((await webhookApp.request('https://events.example/process', {}, env)).status, 404);
});
