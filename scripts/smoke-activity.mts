import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac,createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Entirely fictional, isolated in-memory D1. Worker outbound fetches are
// blocked; this check never reads local credentials or calls X/Cloudflare.
const secret = 'SYNTHETIC_SMOKE_SECRET_NOT_REAL';
const owner = '8000000000000000001', postId = '8000000000000000003';
let outbound = 0;
const blockOutbound = async () => { outbound++; throw new Error('outbound disabled in smoke test'); };
const shared = { compatibilityDate: '2026-10-12', modules: true, d1Databases: { DB: 'synthetic-activity-smoke' }, outboundService: blockOutbound };
const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, d1Persist: false, workers: [
  { ...shared, name: 'reader', scriptPath: fileURLToPath(new URL('../apps/api/dist/core/worker.js', import.meta.url)), bindings: { APP_ENV: 'local', X_INBOX_PROCESSING_ENABLED: 'true' }, serviceBindings: { ASSETS: 'assets' } },
  { name: 'assets', compatibilityDate: '2026-10-12', modules: true,
    script: 'export default { fetch() { return new Response("SYNTHETIC_ASSET"); } }', outboundService: blockOutbound },
  { ...shared, name: 'events', scriptPath: fileURLToPath(new URL('../apps/api/dist/webhook/x-webhook.js', import.meta.url)),
    bindings: { X_WEBHOOK_ENABLED: 'true', X_OWNER_ID: owner, X_OAUTH2_CLIENT_SECRET: secret },
    serviceBindings: { X_INBOX_PROCESSOR: { name: 'reader', entrypoint: 'InboxProcessor' } } },
] }));
try {
  const db = await mf.getD1Database('DB', 'reader');
  for (const file of ['0001_reader.sql', '0002_x_activity_inbox.sql', '0003_source_expiry.sql','0004_x_runtime.sql','0005_browser_login.sql','0006_feed_order.sql']) {
    const sql = readFileSync(new URL('../apps/api/migrations/' + file, import.meta.url), 'utf8').replace(/^--.*$/gm, '');
    for (const match of sql.matchAll(/\s*(CREATE TRIGGER[\s\S]*?END;|[\s\S]*?;)/g)) await db.prepare(match[1]).run();
  }
  const events = await mf.getWorker('events'), reader = await mf.getWorker('reader');
  const now = new Date().toISOString();
  const raw = JSON.stringify({ data: { event_uuid: 'synthetic-smoke', event_type: 'like.create', created_at: now,
    filter: { user_id: owner, direction: 'outbound' }, payload: { liking_user_id: owner, liked_tweet_id: postId, liked_tweet_author_id: '8000000000000000004' },
    includes: { tweets: [{ id: postId, author_id: '8000000000000000004', text: '架空の通知 → 保存 → 同期確認', created_at: '2020-01-01T00:00:00.000Z' }] } } });
  const post = () => events.fetch('http://localhost/webhooks/x', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Twitter-Webhooks-Signature-OAuth2': 'sha256=' + createHmac('sha256', secret).update(raw).digest('base64') } });
  assert.equal((await post()).status, 200);
  let stored = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    stored = !!await db.prepare('SELECT id FROM items WHERE id = ?').bind('x:' + postId).first();
    if (stored) break; await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(stored, 'private RPC should process the durable inbox');
  const get = (path: string) => reader.fetch('http://localhost' + path, { headers: { 'X-Margin-Request': '1' } });
  const item = await (await get('/v1/items/x:' + postId)).json() as any;
  assert.equal(item.source.text, '架空の通知 → 保存 → 同期確認'); assert.equal(item.metadata.likedAt, now);
  const edited = await reader.fetch('http://localhost/v1/items/x:' + postId, { method: 'PATCH',
    headers: { 'X-Margin-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, changes: { memo: '架空の本人メモ', read: true } }) });
  assert.equal(edited.status, 200); assert.equal((await post()).status, 200);
  const after = await (await get('/v1/items/x:' + postId)).json() as any;
  assert.equal(after.revision, 2); assert.equal(after.user.memo, '架空の本人メモ'); assert.equal(after.user.read, true);
  const changes = await (await get('/v1/changes')).json() as any;
  assert.equal(changes.changes.length, 2);
  assert.equal((await events.fetch('http://localhost/v1/items')).status, 404);
  assert.equal((await reader.fetch('https://reader.example.test/v1/items', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' } })).status, 401);
  assert.equal((await reader.fetch('https://reader.example.test/', { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' },redirect:'manual' })).status, 302);
  assert.equal(await (await reader.fetch('http://localhost/')).text(), 'SYNTHETIC_ASSET');
  const bootstrap='a'.repeat(43), hash=createHash('sha256').update(bootstrap).digest('hex');
  await db.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').bind(hash,new Date(Date.now()+60000).toISOString()).run();
  const loginRequest=()=>mf.dispatchFetch('http://localhost/auth/session',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-Margin-Request':'1'},body:JSON.stringify({token:bootstrap})});
  const login=await loginRequest();assert.equal(login.status,204);assert.equal((await loginRequest()).status,401);
  const cookie=login.headers.get('Set-Cookie')!.split(';')[0];
  assert.equal(await (await reader.fetch('https://reader.example.test/',{headers:{Cookie:cookie}})).text(),'SYNTHETIC_ASSET');
  const snapshot=await (await reader.fetch('https://reader.example.test/api/x/items?after=0',{headers:{Cookie:cookie,'X-Margin-Request':'1'}})).json() as any;
  assert.equal(snapshot.entries[0].postId,postId);assert.equal(snapshot.entries[0].src.text,'架空の通知 → 保存 → 同期確認');
  assert.equal((await reader.fetch('https://reader.example.test/api/x/items',{headers:{'X-Margin-Request':'1'}})).status,401);
  assert.equal(await db.prepare('SELECT post_json FROM x_activity_inbox').first('post_json'), null);
  assert.equal(outbound, 0);
  console.log('PASS: actual Workers/D1, signed notification → private RPC → source + changes, duplicate and memo preservation; zero outbound requests');
} finally { await mf.dispose(); }
