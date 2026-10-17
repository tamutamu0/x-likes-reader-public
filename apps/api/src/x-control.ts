import { budget, getRuntime, setRuntime, XClient, creditStopAt, MONTH_CAP, TOTAL_CAP, type XBindings } from './x-runtime';
const LEASE = 60 * 60000;
const validId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
export type ControlState = {
  enabled: boolean; ownerId: string; webhookId: string; tag: string;
  subscriptionId?: string; expiresAt?: string; lastCheckAt?: string;
  freeBalance?: number; prepaidBalance?: number; baselineFreeBalance?: number;
  freeStopAt?: number; reason?: string | null; retryAt?: number;
  createUncertain?: boolean; lastRenewedAt?: string; failurePhase?: string; failureType?: string; failureHint?: string;
};
function matching(s: any, state: ControlState) {
  return s.event_type === 'like.create' && s.tag === state.tag && s.webhook_id === state.webhookId &&
    s.filter?.user_id === state.ownerId && (s.filter?.qualifiers?.direction ?? s.filter?.direction) === 'outbound' &&
    !s.filter?.qualifiers?.post_id && !s.filter?.keyword;
}
export async function withXLock<T>(db: D1Database, now: number, action: () => Promise<T>): Promise<T | null> {
  const owner = crypto.randomUUID();
  const lock = await db.prepare(`INSERT INTO x_control_lock VALUES (1,?,?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, until_at=excluded.until_at
    WHERE x_control_lock.until_at < ? RETURNING owner`).bind(owner, now + 300000, now).first();
  if (!lock) return null;
  try { return await action(); }
  finally { await db.prepare('DELETE FROM x_control_lock WHERE id=1 AND owner=?').bind(owner).run(); }
}
// No liked_posts or profile endpoint exists in this controller. Only official
// account credit and subscription control calls are made. Never open a stream.
export async function reconcileSubscription(env: XBindings, now = Date.now(), fetcher: typeof fetch = fetch, force = false) {
  if (!env.DB || env.X_SYNC_ENABLED !== 'true') return null;
  const db = env.DB;
  return withXLock(db, now, async () => {
    const state = await getRuntime<ControlState | null>(db, 'control', null);
    if (!state || !validId(state.ownerId) || !validId(state.webhookId) || !state.tag.startsWith('margin-cloud-')) throw new Error('configuration');
    const stopAt=creditStopAt(state);
    if (!force && state.retryAt && state.retryAt > now) return state;
    const client = new XClient(env, fetcher, () => now);
    const save = () => setRuntime(db, 'control', state);
    const listing = async () => {
      const list = await client.request('/2/activity/subscriptions?max_results=100');
      const data = list.data?.subscriptions ?? list.data ?? (list.meta?.result_count === 0 ? [] : null);
      if (!Array.isArray(data) || list.meta?.next_token) throw new Error('subscription_list');
      return data;
    };
    const stop = async () => {
      const active = await listing();
      let deleted = false;
      // Tag and webhook identify ONLY this dedicated reader's subscriptions.
      for (const s of active.filter(s => s.tag === state.tag && s.webhook_id === state.webhookId)) {
        const id = s.subscription_id ?? s.id;
        if (!validId(id)) throw new Error('subscription_id');
        await client.request('/2/activity/subscriptions/' + id, 'DELETE');
        deleted = true;
      }
      if(deleted && (await listing()).some(s=>s.tag===state.tag && s.webhook_id===state.webhookId)) throw new Error('subscription_cleanup');
      delete state.subscriptionId; delete state.expiresAt; state.createUncertain = false;
      await save();
    };
    let phase = 'budget';
    try {
      const b = await budget(db, now);
      const stopped = !state.enabled || now >= stopAt || b.month >= MONTH_CAP || b.total >= TOTAL_CAP;
      if (stopped) {
        state.reason = !state.enabled ? 'manual' : now >= stopAt ? 'credits_expiry' : 'budget';
        if (state.subscriptionId || state.createUncertain) await stop(); else await save();
        return state;
      }
      // Fresh credit verification at every cron turn (15 min). Never infer
      // prepaid funds are authorized. Keep a $1 free-credit buffer.
      phase = 'credits';
      const credits = (await client.request('/2/usage/credits')).data;
      if (!credits || typeof credits.free_balance !== 'number' || !Number.isFinite(credits.free_balance) ||
          typeof credits.prepaid_balance !== 'number' || !Number.isFinite(credits.prepaid_balance)) throw new Error('credits_unknown');
      state.freeBalance = credits.free_balance; state.prepaidBalance = credits.prepaid_balance;
      state.lastCheckAt = new Date(now).toISOString();
      const decrease = Math.max(0, (state.baselineFreeBalance ?? credits.free_balance) - credits.free_balance);
      if (credits.free_balance <= 1 || credits.prepaid_balance < 0 || decrease >= 1) {
        state.reason = 'credits'; state.enabled = false; await stop(); return state;
      }
      state.baselineFreeBalance ??= credits.free_balance;
      // An uncertain create is reconciled BEFORE another POST. Do not extend
      // an unconfirmed broad filter, lifetime or target, even if X returned 200.
      if (state.createUncertain) {
        const owned = (await listing()).filter(s => s.tag === state.tag && s.webhook_id === state.webhookId);
        if (owned.length === 1 && matching(owned[0], state) && Date.parse(owned[0].expires_at) > now && Date.parse(owned[0].expires_at) <= now + LEASE) {
          state.subscriptionId = owned[0].subscription_id ?? owned[0].id;
          state.expiresAt = owned[0].expires_at; state.createUncertain = false;
        } else { state.enabled = false; state.reason = 'subscription_unconfirmed'; await stop(); return state; }
      }
      if (state.expiresAt && Date.parse(state.expiresAt) > now + 30 * 60000) { state.reason = null; delete state.failurePhase; delete state.failureType; delete state.failureHint; await save(); return state; }
      // PUT does not document expiry updates. Delete/recreate with an explicit
      // finite lease, instead of relying on undocumented expiry extension.
      phase = 'stop';
      await stop();
      const expiresAt = new Date(Math.min(now + LEASE, stopAt)).toISOString();
      if (Date.parse(expiresAt) <= now + 5 * 60000) { state.reason = 'credits_expiry'; await save(); return state; }
      state.createUncertain = true; state.expiresAt = expiresAt; await save();
      phase = 'create';
      const created = await client.request('/2/activity/subscriptions', 'POST', {
        event_type: 'like.create', filter: { user_id: state.ownerId, qualifiers: { direction: 'outbound' } },
        webhook_id: state.webhookId, tag: state.tag, expires_at: expiresAt,
      });
      const s = created.data?.subscription ?? created.data;
      if (!s || !matching(s, state) || !validId(s.subscription_id ?? s.id) || Date.parse(s.expires_at) > Date.parse(expiresAt) || !(Date.parse(s.expires_at) > now)) {
        state.enabled = false; state.reason = 'subscription_unconfirmed'; await stop(); return state;
      }
      state.subscriptionId = s.subscription_id ?? s.id; state.expiresAt = s.expires_at;
      state.createUncertain = false; state.lastRenewedAt = new Date(now).toISOString(); state.reason = null; delete state.retryAt; delete state.failurePhase; delete state.failureType; delete state.failureHint;
      await save(); return state;
    } catch (error) {
      const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'unavailable';
      state.reason = reason;
      // Diagnostic categories only: never persist provider messages or tokens.
      state.failurePhase = phase;
      state.failureType = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'Error';
      const message = error instanceof Error ? error.message : '';
      state.failureHint = message.includes('AbortSignal.timeout') ? 'abort_timeout' : message.includes('Illegal invocation') ? 'native_receiver' :
        message.includes('different request') ? 'request_context' : message.includes('not a function') ? 'missing_function' : 'other';
      // No endless retries or new creates during an ambiguous failure. The
      // last confirmed X-side lease expires even if Cloudflare is unavailable.
      state.retryAt = now + (reason === 'rate_limit' ? 60 : 30) * 60000;
      if (reason.startsWith('auth') || reason === 'subscription_list' || reason === 'subscription_cleanup') state.enabled = false;
      await save(); return state;
    }
  });
}
