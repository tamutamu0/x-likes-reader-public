// Explicit one-post experiment only. Never run as a recurring job.
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { XService } from '../stable/server/x-service.mjs';
import { webhookApp } from '../apps/api/src/x-webhook.ts';

const dir = '.cache/activity-trial';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.loadEnvFile('stable/.env.x.local');
const service = new XService({ directory: 'stable/data/x', clientId: process.env.X_CLIENT_ID, clientSecret: process.env.X_CLIENT_SECRET });
const stateFile = `${dir}/trial-state.json`;
const readState = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const writeState = (v: object) => fs.writeFileSync(stateFile, JSON.stringify(v, null, 2), { mode: 0o600 });
const numeric = (v: unknown) => typeof v === 'string' && /^[0-9]{1,19}$/.test(v);
const output = (v: object) => console.log(JSON.stringify(v));
const command = process.argv[2];
let token: string;
async function request(path: string, method = 'GET', body?: object) {
  if (!token) {
    let t = service.tokens();
    if (!t) throw new Error('missing_tokens');
    if (t.expiresAt <= Date.now() + 60000) {
      const fresh = await service.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
      if (!fresh.refresh_token || !String(fresh.scope).split(' ').includes('like.read')) throw new Error('missing_like_scope');
      service.set('tokens', service.seal(fresh)); t = fresh;
    }
    token = t.access_token;
  }
  const r = await fetch('https://api.x.com' + path, { method, headers: {
    Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const b: any = await r.json().catch(() => ({}));
  if (!r.ok || b.errors?.length) {
    // Only problem categories, never arbitrary error text or credential values.
    const problem = String(b.type || b.errors?.[0]?.type || 'request_failed').split('/').pop();
    throw new Error(`x_${r.status}_${/^[a-z_-]+$/.test(problem) ? problem : 'request_failed'}`);
  }
  return b;
}
function subscriptions(b: any): any[] {
  const data = b.data?.subscriptions ?? b.data;
  if (!Array.isArray(data)) throw new Error('unknown_subscription_list_shape');
  if (b.meta?.next_token) throw new Error('subscription_list_has_more_pages');
  return data;
}
async function stop(state: any) {
  const list = subscriptions(await request('/2/activity/subscriptions?max_results=100'));
  const owned = list.filter(s => s.tag === state.tag && s.filter?.user_id === state.ownerId);
  for (const s of owned) {
    const id = s.subscription_id ?? s.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid_subscription_id');
    await request('/2/activity/subscriptions/' + id, 'DELETE');
  }
  const remaining = subscriptions(await request('/2/activity/subscriptions?max_results=100'));
  if (remaining.some(s => s.tag === state.tag)) throw new Error('subscription_cleanup_unconfirmed');
  writeState({ ...state, stoppedAt: new Date().toISOString(), stopped: true });
  output({ subscriptionStopped: true, deleted: owned.length });
}
try {
  if (command === 'serve') {
    const postId = process.argv[3];
    const ownerId = service.get('account')?.id;
    if (!numeric(postId) || !numeric(ownerId) || !process.env.X_CLIENT_SECRET) throw new Error('missing_trial_configuration');
    const sqlite = new DatabaseSync(`${dir}/inbox.sqlite`);
    fs.chmodSync(`${dir}/inbox.sqlite`, 0o600);
    if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE name='x_activity_inbox'").get())
      sqlite.exec(fs.readFileSync('apps/api/migrations/0002_x_activity_inbox.sql', 'utf8'));
    const db: any = { prepare(sql: string) { return { bind(...args: any[]) { return { async run() {
      sqlite.prepare(sql).run(...args); return { success: true };
    } }; } }; } };
    // This isolated listener exposes only CRC and signed notification ingestion.
    // There is no access to the reader, posts, keys, reports, or control API.
    const server = http.createServer(async (req, res) => {
      try {
        const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        if (path !== '/webhooks/x') { res.writeHead(404); res.end(); return; }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
        const state = readState();
        const response = await webhookApp.fetch(new Request('http://127.0.0.1' + req.url, {
          method: req.method, headers,
          ...(req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
        } as RequestInit), { DB: db, X_WEBHOOK_ENABLED: 'true', X_OWNER_ID: ownerId,
          X_OAUTH2_CLIENT_SECRET: process.env.X_CLIENT_SECRET,
          X_ALLOWED_POST_ID: postId,
          // Keep CRC available, reject unsolicited POSTs before trial activation.
          X_RECEIVE_UNTIL: state.postId === postId && !state.stopped ? state.expiresAt : '2000-01-01T00:00:00Z',
        });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(503); res.end(); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    server.listen(47329, '127.0.0.1', () => output({ receiverReady: true, port: 47329, onePostOnly: true }));
    let stopping = false;
    const watchdog = setInterval(async () => {
      const state = readState();
      if (!state.tag || state.stopped || stopping) return;
      const received = sqlite.prepare('SELECT COUNT(*) AS n FROM x_activity_inbox WHERE post_id=?').get(postId)?.n;
      if (!received && Date.now() < Date.parse(state.expiresAt)) return;
      stopping = true;
      try { await stop(state); }
      catch { output({ subscriptionCleanupFailed: true, fallbackExpiresAt: state.expiresAt }); }
      // No retry loop; the X-side five-minute lease remains the fallback.
    }, 1000);
    watchdog.unref();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { sqlite.close(); service.close(); process.exit(); }));
  } else if (command === 'register') {
    const url = new URL(process.argv[3]);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com') || url.pathname !== '/webhooks/x' || url.search || url.username || url.password)
      throw new Error('invalid_temporary_receiver_url');
    // Save intent before the non-idempotent request. An ambiguous failure must
    // be reconciled by listing, never blindly POSTed again.
    const state = readState();
    if (state.webhookAttempted) throw new Error('reconcile_prior_webhook_attempt_before_retry');
    writeState({ ...state, webhookUrl: url.href, webhookAttempted: true });
    const b = await request('/2/webhooks', 'POST', { url: url.href });
    const webhook = b.data?.webhook ?? b.data;
    const id = webhook?.id;
    if (!numeric(id) || webhook.valid !== true) throw new Error('webhook_registration_unconfirmed');
    writeState({ ...readState(), webhookId: id }); output({ webhookRegistered: true, valid: true });
  } else if (command === 'start') {
    const url = new URL(process.argv[3]);
    const postId = /^\/[^/]+\/status\/(\d{1,19})\/?$/.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com'].includes(url.hostname) || url.username || url.password || !numeric(postId)) throw new Error('invalid_post_url');
    const old = readState();
    if (!numeric(old.webhookId) || old.subscriptionAttempted) throw new Error('missing_webhook_or_trial_already_attempted');
    const ownerId = service.get('account')?.id;
    if (!numeric(ownerId)) throw new Error('missing_owner');
    const b = await request('/2/usage/credits');
    const free = b.data?.free_balance;
    if (typeof free !== 'number' || free < 1) throw new Error('insufficient_free_credits');
    const available = 1000000 - service.used(true);
    if (available <= 0) throw new Error('month_budget_exhausted');
    const reservation = service.reserve(available, 'activity_trial_unknown_price');
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    const state = { ...old, subscriptionAttempted: true, postId, ownerId, expiresAt,
      tag: 'margin-one-post-trial-' + Date.now(), beforeBalance: free, reservation, stopped: false };
    writeState(state);
    try {
      const created = await request('/2/activity/subscriptions', 'POST', { event_type: 'like.create',
        filter: { user_id: ownerId, qualifiers: { direction: 'outbound', post_id: postId } },
        webhook_id: old.webhookId, expires_at: expiresAt, tag: state.tag });
      const s = created.data?.subscription ?? created.data;
      const matched = s?.event_type === 'like.create' && s.filter?.user_id === ownerId &&
        s.filter?.qualifiers?.post_id === postId && (s.filter?.qualifiers?.direction ?? s.filter?.direction) === 'outbound' &&
        s.webhook_id === old.webhookId && s.tag === state.tag && Date.parse(s.expires_at) <= Date.parse(expiresAt) && Date.parse(s.expires_at) > Date.now();
      if (!matched) throw new Error('subscription_filter_or_expiry_unconfirmed');
      writeState({ ...state, subscriptionId: s.subscription_id ?? s.id, readyAt: new Date().toISOString() });
      output({ trialReady: true, expiresAt, singlePost: true, beforeBalance: free });
    } catch (e) { await stop(state); throw e; }
  } else if (command === 'stop') {
    const state = readState();
    if (!state.tag || !state.ownerId) throw new Error('no_trial_subscription');
    await stop(state);
  } else if (command === 'cleanup') {
    const state = readState();
    if (!state.stopped || !numeric(state.webhookId)) throw new Error('stop_subscription_before_webhook_cleanup');
    if (!state.webhookDeleteAcknowledgedAt) {
      const deleted = await request('/2/webhooks/' + state.webhookId, 'DELETE');
      if (deleted.data?.deleted !== true) throw new Error('webhook_deletion_unconfirmed');
      state.webhookDeleteAcknowledgedAt = new Date().toISOString(); writeState(state);
    }
    const list = await request('/2/webhooks');
    // The real API omits data for an empty list, unlike the example schema.
    const hooks = list.data?.webhooks ?? list.webhooks ?? list.data ?? (list.meta?.result_count === 0 ? [] : undefined);
    if (!Array.isArray(hooks)) {
      output({ webhookDeleted: true, listShapeUnknown: true, topLevelKeys: Object.keys(list), dataKeys: Object.keys(list.data ?? {}) });
      throw new Error('webhook_list_shape_unconfirmed');
    }
    if (hooks.some((h: any) => h.id === state.webhookId)) throw new Error('webhook_still_listed');
    writeState({ ...state, webhookDeletedAt: new Date().toISOString() }); output({ webhookDeleted: true, absentFromList: true });
  } else if (command === 'inspect') {
    const sqlite = new DatabaseSync(`${dir}/inbox.sqlite`, { readOnly: true });
    const rows = sqlite.prepare('SELECT liked_at, received_at, post_json IS NOT NULL AS has_body FROM x_activity_inbox').all();
    sqlite.close(); output({ eventCount: rows.length, events: rows });
  } else if (command === 'balance') {
    const b = await request('/2/usage/credits');
    const report = { at: new Date().toISOString(), freeBalance: b.data?.free_balance, prepaidBalance: b.data?.prepaid_balance };
    fs.writeFileSync(`${dir}/after-balance.json`, JSON.stringify(report), { mode: 0o600 }); output(report);
  } else throw new Error('use_serve_register_start_stop_cleanup_inspect_or_balance');
} catch (e: any) {
  output({ failed: true, reason: /^[a-z0-9_]+$/.test(e.message) ? e.message : 'trial_failed_no_sensitive_details_logged' });
  process.exitCode = 1;
} finally { if (command !== 'serve' || process.exitCode) service.close(); }
