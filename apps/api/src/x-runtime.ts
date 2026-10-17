export type XBindings = {
  DB?: D1Database; X_SYNC_ENABLED?: string; X_OAUTH2_CLIENT_ID?: string;
  X_OAUTH2_CLIENT_SECRET?: string; X_VAULT_KEY?: string;
};
export type Tokens = { access_token: string; refresh_token: string; scope: string; expiresAt: number };
// An absolute credit deadline is deployment state. Missing/invalid means stopped.
export function creditStopAt(state: {freeStopAt?: number} | null): number {
  const value=state?.freeStopAt;
  return typeof value==='number' && Number.isFinite(value) && value>0 && value<=8640000000000000 ? value : 0;
}
export const MONTH_CAP = 1000000, TOTAL_CAP = 8000000;
const encoder = new TextEncoder();
const base64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unbase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function sealTokens(value: Tokens, key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', unbase64(key), 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('margin-x-oauth-v1') }, k, encoder.encode(JSON.stringify(value))));
  return { version: 1, iv: base64(iv), body: base64(encrypted) };
}
export async function openTokens(value: { version: number; iv: string; body: string } | null, key: string): Promise<Tokens> {
  if (!value || value.version !== 1) throw new Error('vault_version');
  const k = await crypto.subtle.importKey('raw', unbase64(key), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(value.iv), additionalData: encoder.encode('margin-x-oauth-v1') }, k, unbase64(value.body))));
}
export async function getRuntime<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare('SELECT value FROM x_runtime WHERE key = ?').bind(key).first<{value: string}>();
  return row ? JSON.parse(row.value) : fallback;
}
export async function setRuntime(db: D1Database, key: string, value: unknown) {
  await db.prepare('INSERT INTO x_runtime(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, JSON.stringify(value)).run();
}
export async function budget(db: D1Database, now: number) {
  const d = new Date(now), month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  return (await db.prepare(`SELECT coalesce(sum(units),0) total,
    coalesce(sum(CASE WHEN at >= ? AND kind NOT LIKE 'bootstrap_%' THEN units ELSE 0 END),0) month,
    coalesce(sum(CASE WHEN kind LIKE 'bootstrap_%' THEN units ELSE 0 END),0) bootstrap
    FROM x_budget`).bind(month).first<{total:number;month:number;bootstrap:number}>())!;
}
export async function reserve(db: D1Database, now: number, units: number, kind: string) {
  const b = await budget(db, now);
  const stopAt=creditStopAt(await getRuntime<{freeStopAt?:number}|null>(db,'control',null));
  if (now >= stopAt || b.total + units > TOTAL_CAP || b.month + units > MONTH_CAP) throw new Error('budget');
  await db.prepare('INSERT INTO x_budget VALUES (?,?,?,?)').bind(crypto.randomUUID(), new Date(now).toISOString(), units, kind).run();
}
export class XClient {
  constructor(private env: XBindings, private fetcher: typeof fetch = fetch, private now = Date.now) {}
  async request(path: string, method = 'GET', body?: unknown, allowPartialErrors = false) {
    // Keep the transport a standalone call rather than changing the receiver
    // of an injected or native function by invoking it as a class method.
    const fetcher = this.fetcher;
    if (!path.startsWith('/2/') || path.includes('://')) throw new Error('invalid_x_path');
    const { DB: db, X_VAULT_KEY: key, X_OAUTH2_CLIENT_ID: id, X_OAUTH2_CLIENT_SECRET: secret } = this.env;
    if (!db || !key || !id || !secret) throw new Error('configuration');
    let tokens = await openTokens(await getRuntime(db, 'tokens', null), key);
    if (!tokens?.refresh_token || !tokens.scope.split(' ').includes('like.read')) throw new Error('auth');
    if (tokens.expiresAt <= this.now() + 60000) {
      // Caller owns a persisted lock; a timed-out refresh is ambiguous. Do not
      // erase credentials or retry a potentially consumed refresh token.
      if (await getRuntime(db, 'refreshUncertain', false)) throw new Error('auth_refresh_uncertain');
      await setRuntime(db, 'refreshUncertain', true);
      const response = await fetcher('https://api.x.com/2/oauth2/token', {
        method: 'POST', headers: { Authorization: 'Basic ' + btoa(id + ':' + secret), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
        // Workers rejects redirect:'error' before sending. manual keeps
        // redirects disabled; any 3xx is rejected by response.ok below.
        redirect: 'manual', signal: AbortSignal.timeout(15000),
      }).catch(error => { throw transportError(error); });
      const fresh: any = await response.json();
      if (!response.ok || !fresh.access_token || !fresh.refresh_token || !Number.isFinite(fresh.expires_in) || !String(fresh.scope).split(' ').includes('like.read')) throw new Error('auth');
      tokens = { access_token: fresh.access_token, refresh_token: fresh.refresh_token, scope: fresh.scope, expiresAt: this.now() + fresh.expires_in * 1000 };
      await setRuntime(db, 'tokens', await sealTokens(tokens, key));
      await setRuntime(db, 'refreshUncertain', false);
    }
    const response = await fetcher('https://api.x.com' + path, {
      method, headers: { Authorization: 'Bearer ' + tokens.access_token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(15000),
    }).catch(error => { throw transportError(error); });
    const result: any = await response.json().catch(() => ({}));
    if (!response.ok || (!allowPartialErrors && result.errors?.length)) throw new Error(response.status === 429 ? 'rate_limit' : [401,403].includes(response.status) ? 'auth' : response.status === 402 ? 'credits' : 'x_request');
    return result;
  }
}
function transportError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return new Error(message.includes('Illegal invocation') ? 'transport_receiver' :
    message.includes('different request') ? 'transport_request_context' :
    message.includes('Cannot use a ReadableStream') ? 'transport_stream' :
    message.includes('SSL') || message.includes('TLS') ? 'transport_tls' : 'transport_failure');
}
