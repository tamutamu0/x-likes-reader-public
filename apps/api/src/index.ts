import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Bindings } from './types';
import { ReaderStore } from './store';
import { integerParam, itemId, validPatch } from './validation';
import { authenticated } from './session';
import { sameOriginWrite } from './security';

export const app = new Hono<{ Bindings: Bindings }>();
app.use('*', secureHeaders());
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
});
app.onError((_error, c) => c.json({ error: { code: 'internal_error', message: '処理を完了できませんでした' } }, 500));
app.notFound(c => c.json({ error: { code: 'not_found', message: '見つかりません' } }, 404));

app.get('/v1/health', c => c.json({ ok: true as const, app: 'margin-api' as const, contractVersion: 1 as const, xConnected: false as const }));
app.use('/v1/*', async (c, next) => {
  const url = new URL(c.req.url);
  const origin = c.req.header('Origin');
  if (origin && origin !== url.origin) return c.json({ error: { code: 'forbidden', message: '別のサイトからは利用できません' } }, 403);
  if (!c.env.DB) return c.json({ error: { code: 'unavailable', message: '保存先が設定されていません' } }, 503);
  if (c.env.APP_ENV === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    if (c.req.header('X-Margin-Request') !== '1') return c.json({ error: { code: 'unauthorized', message: '開発用リクエストヘッダーが必要です' } }, 401);
  } else {
    if (!await authenticated(c.req.raw, c.env)) return c.json({ error: { code: 'unauthorized', message: 'ログインが必要です' } }, 401);
    if (!['GET','HEAD'].includes(c.req.method) && c.req.header('Cookie') && !sameOriginWrite(c.req.raw)) return c.json({error:{code:'forbidden',message:'同じサイトからの操作が必要です'}},403);
  }
  await next();
});

app.get('/v1/items', async c => {
  const cursor = c.req.query('cursor') ?? null;
  const limit = integerParam(c.req.query('limit'), 50, 1, 100);
  if ((cursor !== null && !itemId(cursor)) || limit === null) return c.json({ error: { code: 'invalid_request', message: 'ページ指定が不正です' } }, 400);
  return c.json(await new ReaderStore(c.env.DB!).list(cursor, limit));
});
app.get('/v1/items/:id', async c => {
  const id = c.req.param('id');
  if (!itemId(id)) return c.json({ error: { code: 'invalid_request', message: '投稿IDが不正です' } }, 400);
  const item = await new ReaderStore(c.env.DB!).get(id);
  return item ? c.json(item) : c.json({ error: { code: 'not_found', message: '投稿が見つかりません' } }, 404);
});
app.patch('/v1/items/:id', async c => {
  const id = c.req.param('id');
  if (!itemId(id) || !c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: { code: 'invalid_request', message: 'JSON形式の更新が必要です' } }, 400);
  // Check actual streamed bytes rather than trusting Content-Length.
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: { code: 'invalid_request', message: '更新内容が必要です' } }, 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.length;
    if (bytes > 65536) { await reader.cancel(); return c.json({ error: { code: 'too_large', message: '更新内容が大きすぎます' } }, 413); }
    chunks.push(part.value);
  }
  const data = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)); }
  catch { return c.json({ error: { code: 'invalid_request', message: 'JSONを読み取れません' } }, 400); }
  if (!validPatch(body)) return c.json({ error: { code: 'invalid_request', message: '更新内容が不正です' } }, 400);
  const result = await new ReaderStore(c.env.DB!).patch(id, body, new Date().toISOString());
  if (result.status === 'missing') return c.json({ error: { code: 'not_found', message: '投稿が見つかりません' } }, 404);
  if (result.status === 'conflict') return c.json({ error: { code: 'conflict' as const, message: 'ほかの端末で更新されています' }, item: result.item }, 409);
  return c.json(result.item);
});
app.get('/v1/changes', async c => {
  const after = integerParam(c.req.query('after'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerParam(c.req.query('limit'), 50, 1, 100);
  if (after === null || limit === null) return c.json({ error: { code: 'invalid_request', message: '同期指定が不正です' } }, 400);
  return c.json(await new ReaderStore(c.env.DB!).changes(after, limit));
});

// Worker/RPC/scheduled entrypoints live in worker.ts. This module keeps the
// HTTP app independently testable without the cloudflare:workers runtime.
