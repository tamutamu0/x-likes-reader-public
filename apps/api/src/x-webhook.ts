import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

export type WebhookBindings = {
  DB?: D1Database;
  X_WEBHOOK_ENABLED?: string;
  X_OWNER_ID?: string;
  X_OAUTH2_CLIENT_SECRET?: string;
  X_ALLOWED_POST_ID?: string;
  X_RECEIVE_UNTIL?: string;
  X_INBOX_PROCESSOR?: { process?(): Promise<{ scanned: number; hasMore: boolean }>; receive?(raw:Uint8Array,signature:string):Promise<number> };
};
const bytes = new TextEncoder();
const numericId = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,19}$/.test(v);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

async function signingKey(secret: string) {
  return crypto.subtle.importKey('raw', bytes.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function crcResponse(secret: string, token: string) {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), bytes.encode(token)));
  return 'sha256=' + btoa(String.fromCharCode(...signature));
}
export async function verifySignature(secret: string, signature: string | undefined, raw: Uint8Array) {
  // OAuth2 is the only supported signing mode. Never fall back to a legacy
  // signature when an OAuth2 signature is invalid or missing.
  if (!signature || !/^sha256=[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = Uint8Array.from(atob(signature.slice(7)), ch => ch.charCodeAt(0));
  return crypto.subtle.verify('HMAC', await signingKey(secret), expected, raw);
}

export function postSnapshot(data: Record<string, any>, postId: string, authorId: string) {
  const tweet = Array.isArray(data.includes?.tweets) ? data.includes.tweets.find((t: unknown) => object(t) && t.id === postId) : null;
  if (!object(tweet) || tweet.withheld || tweet.author_id !== authorId) return null;
  const text = typeof tweet.note_tweet?.text === 'string' ? tweet.note_tweet.text : tweet.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) return null;
  const entities = tweet.note_tweet?.entities ?? tweet.entities;
  const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';
  const urls = Array.isArray(entities?.urls) ? entities.urls.slice(0, 50).flatMap((u: unknown) => {
    if (!object(u)) return [];
    const safe = (v: unknown) => {
      if (typeof v !== 'string' || v.length > 2048) return null;
      try { const url = new URL(v); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
      catch { return null; }
    };
    const url = safe(u.url), expanded_url = safe(u.unwound_url) ?? safe(u.expanded_url);
    return url && expanded_url ? [{ url, expanded_url, title: clean(u.title, 200), description: clean(u.description, 300),
      image_url: safe(Array.isArray(u.images) ? u.images[0]?.url : null) }] : [];
  }) : [];
  // Only the matched author's delivered identity. No user lookup, profiles,
  // avatars, metrics, or other users (including the liking actor) retained.
  const user = Array.isArray(data.includes?.users) ? data.includes.users.find((u: unknown) => object(u) && u.id === authorId) : null;
  const handle = typeof user?.username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(user.username) ? user.username : '';
  const name=clean(user?.name,60);
  const author = name || handle ? { name: name || '@' + handle, handle } : undefined;
  return { id: postId, author_id: authorId, text, created_at: iso(tweet.created_at), ...(author ? { author } : {}), entities: { urls } };
}

export const webhookApp = new Hono<{ Bindings: WebhookBindings }>();
webhookApp.use('*', secureHeaders());
webhookApp.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); });
webhookApp.onError((_error, c) => c.json({ error: 'unavailable' }, 503));
webhookApp.notFound(c => c.json({ error: 'not_found' }, 404));
webhookApp.use('/webhooks/x', async (c, next) => {
  if (c.env.X_WEBHOOK_ENABLED !== 'true' || !c.env.X_OAUTH2_CLIENT_SECRET || !numericId(c.env.X_OWNER_ID) || (!c.env.DB && !c.env.X_INBOX_PROCESSOR?.receive))
    return c.json({ error: 'unavailable' }, 503);
  await next();
});
webhookApp.get('/webhooks/x', async c => {
  const token = c.req.query('crc_token');
  // CRC and delivery signatures use the same HMAC key. Never sign a JSON
  // event supplied as a challenge: that would become a public signing oracle.
  // Reject JSON structural characters while allowing opaque CRC strings.
  if (!token || token.length > 1024 || /[\u0000-\u0020\u007f{}\[\]"\\]/.test(token)) return c.json({ error: 'invalid_request' }, 400);
  return c.json({ response_token: await crcResponse(c.env.X_OAUTH2_CLIENT_SECRET!, token) });
});
webhookApp.post('/webhooks/x', async c => {
  if (c.req.header('Content-Encoding') && c.req.header('Content-Encoding') !== 'identity') return c.json({ error: 'invalid_request' }, 415);
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'invalid_request' }, 415);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: 'invalid_request' }, 400);
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.length;
    if (size > 262144) { await reader.cancel(); return c.json({ error: 'too_large' }, 413); }
    chunks.push(part.value);
  }
  const raw = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  if (!await verifySignature(c.env.X_OAUTH2_CLIENT_SECRET!, c.req.header('X-Twitter-Webhooks-Signature-OAuth2'), raw)) return c.json({ error: 'unauthorized' }, 401);
  if(!c.env.DB) {
    const status=await c.env.X_INBOX_PROCESSOR!.receive!(raw,c.req.header('X-Twitter-Webhooks-Signature-OAuth2')!);
    return status===200 ? c.json({received:true}):c.json({error:'unavailable'},503);
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)); }
  catch { return c.json({ error: 'invalid_request' }, 400); }
  if (!object(body) || !object(body.data)) return c.json({ error: 'invalid_request' }, 400);
  const data = body.data;
  if (data.event_type !== 'like.create') return c.json({ received: true });
  if (!object(data.payload)) return c.json({ error: 'invalid_request' }, 400);
  const p = data.payload;
  // Optional narrow, time-bounded receiver for a real one-post trial. X-side
  // subscription expiry/deletion must still stop delivery and its charges.
  if (c.env.X_ALLOWED_POST_ID && (!numericId(c.env.X_ALLOWED_POST_ID) || p.liked_tweet_id !== c.env.X_ALLOWED_POST_ID))
    return c.json({ received: true });
  if (c.env.X_RECEIVE_UNTIL && (!iso(c.env.X_RECEIVE_UNTIL) || Date.now() >= Date.parse(c.env.X_RECEIVE_UNTIL)))
    return c.json({ received: true });
  // Signed data must still match the authorized actor. An omitted direction
  // never broadens this test to likes received by the owner's posts.
  if (p.liking_user_id !== c.env.X_OWNER_ID || (data.filter?.user_id && data.filter.user_id !== c.env.X_OWNER_ID) ||
      (data.filter?.direction && data.filter.direction !== 'outbound') ||
      (data.filter?.qualifiers?.direction && data.filter.qualifiers.direction !== 'outbound')) return c.json({ received: true });
  const likedAt = iso(data.created_at);
  if (typeof data.event_uuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.event_uuid) || !likedAt ||
      !numericId(p.liked_tweet_id) || !numericId(p.liked_tweet_author_id)) return c.json({ error: 'invalid_request' }, 400);
  const snapshot = postSnapshot(data, p.liked_tweet_id, p.liked_tweet_author_id);
  // Wait for durable storage before ACK. A database failure returns 503 so X
  // can retry; repeated event UUIDs do not repeat processing or overwrite data.
  await c.env.DB!.prepare(`INSERT INTO x_activity_inbox
    (event_uuid, post_id, author_id, liked_at, received_at, post_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_uuid) DO NOTHING`)
    .bind(data.event_uuid, p.liked_tweet_id, p.liked_tweet_author_id, likedAt, new Date().toISOString(), snapshot ? JSON.stringify(snapshot) : null).run();
  if (c.env.X_INBOX_PROCESSOR?.process) {
    // Durable inbox is authoritative. A lost wakeup leaves pending work for
    // the private Worker's scheduled backstop; never log the payload/secret.
    c.executionCtx.waitUntil(Promise.resolve().then(() => c.env.X_INBOX_PROCESSOR!.process!()).catch(() => undefined));
  }
  return c.json({ received: true });
});

// Public Worker has no reader, admin, OAuth callback, or outbound X requests.
// Private inbox processor is invoked only through an optional service binding.
export default { fetch: webhookApp.fetch };
