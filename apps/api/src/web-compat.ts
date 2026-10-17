import { Hono } from 'hono';
import type { Bindings } from './types';
import { authenticated } from './session';
import { getRuntime, setRuntime, budget, creditStopAt } from './x-runtime';
import { reconcileSubscription, withXLock, type ControlState } from './x-control';
import { ReaderStore } from './store';
import { readPost } from './x-lookup';
import { linkPreview, previewImage } from './link-preview';

export const webApp = new Hono<{Bindings: Bindings}>();
async function smallJson(request: Request, limit=256): Promise<any> {
  const reader=request.body?.getReader(); if(!reader)return null;
  let size=0, text=''; const decoder=new TextDecoder();
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;
    if(size>limit){await reader.cancel();return null;}text+=decoder.decode(part.value,{stream:true});}
  try{return JSON.parse(text+decoder.decode());}catch{return null;}
}
webApp.use('*', async(c,next) => {
  c.header('Cache-Control','no-store'); c.header('Referrer-Policy','no-referrer');
  const url = new URL(c.req.url), origin = c.req.header('Origin');
  if (origin && origin !== url.origin) return c.json({status:'failed'},403);
  if (!c.env.DB) return c.json({status:'failed'},503);
  const imageGet=c.req.method==='GET' && /^\/api\/link-preview\/[a-f0-9]{64}\/image$/.test(url.pathname);
  if ((!imageGet && c.req.header('X-Margin-Request') !== '1') || !await authenticated(c.req.raw,c.env)) return c.json({status:'failed'},401);
  if (c.req.method !== 'GET' && origin !== url.origin) return c.json({status:'failed'},403);
  await next();
});
webApp.onError((_e,c) => c.json({status:'failed'},503));
webApp.get('/api/health',c => c.json({ok:true,app:'margin',cloud:true,articleFetch:false,linkPreview:!!c.env.PREVIEW}));
webApp.post('/api/link-preview',async c=>{
  const body=await smallJson(c.req.raw,4096);
  if(typeof body?.postId!=='string' || typeof body?.url!=='string')return c.json({status:'unavailable'},400);
  return c.json(await linkPreview(c.env,body.postId,body.url));
});
webApp.get('/api/link-preview/:key/image',c=>previewImage(c.env,c.req.param('key')));
webApp.get('/api/x/status',async c => {
  const state = await getRuntime<ControlState|null>(c.env.DB!,'control',null);
  const account = await getRuntime(c.env.DB!,'account',null);
  const b = await budget(c.env.DB!,Date.now());
  const counts = await c.env.DB!.prepare('SELECT count(*) total, count(source_json) available FROM items').first<{total:number;available:number}>();
  const active = !!state?.subscriptionId && Date.parse(state.expiresAt ?? '') > Date.now();
  return c.json({status:'ok',configured:!!state,connected:!!state,account,paused:!state?.enabled || !!state.reason,
    reason:state?.reason ?? null,running:false,lastSuccessAt:state?.lastRenewedAt,nextAllowedAt:state?.expiresAt,
    count:counts?.total ?? 0,availableCount:counts?.available ?? 0,bootstrapImported:1000,bootstrapTarget:1000,
    backfillAvailable:false,automatic:'cloud_webhook',active,freeBalance:state?.freeBalance,lastCreditCheckAt:state?.lastCheckAt,
    budget:{reservedUsd:b.total/1e6,monthReservedUsd:b.month/1e6,bootstrapReservedUsd:b.bootstrap/1e6,totalCapUsd:8,monthCapUsd:1,bootstrapCapUsd:5,stopsAt:creditStopAt(state)?new Date(creditStopAt(state)).toISOString():null,provisionalNotificationUsd:0.01}});
});
webApp.get('/api/x/items',async c => {
  const after = Number(c.req.query('after') ?? '0');
  if (!Number.isSafeInteger(after) || after < 0) return c.json({status:'failed'},400);
  const page = await new ReaderStore(c.env.DB!).changes(after,100);
  const positions = await c.env.DB!.prepare(`SELECT item_id, position FROM x_feed_order WHERE item_id IN (${page.changes.map(()=>'?').join(',') || 'NULL'})`)
    .bind(...page.changes.map(change=>change.item.id)).all<{item_id:string;position:number}>();
  const order = new Map(positions.results.map(row=>[row.item_id,row.position]));
  const entries = [];
  for (const change of page.changes) {
    const item = change.item;
    if (item.metadata.origin !== 'x') continue;
    const s = item.source;
    entries.push({postId:item.id.slice(2),feedOrder:order.get(item.id) ?? 0,sourceStatus:item.metadata.sourceStatus,
      src:s ? {postId:s.postId,url:s.url,text:s.text,author:s.author,postedAt:s.postedAt,links:s.links} :
        item.metadata.sourceStatus === 'pending' ? {postId:item.id.slice(2),text:'',author:{name:'X の投稿',handle:''}} : null,
      fetchedAt:item.metadata.fetchedAt,likedAt:item.metadata.likedAt ?? null});
  }
  return c.json({status:'ok',revision:1000000000000+page.nextCursor,cursor:page.nextCursor,hasMore:page.hasMore,entries});
});
webApp.post('/api/x/pause',async c => {
  if (Number(c.req.header('Content-Length') ?? 0) > 256) return c.json({status:'failed'},413);
  const body = await smallJson(c.req.raw);
  if (typeof body?.paused !== 'boolean') return c.json({status:'failed'},400);
  const changed = await withXLock(c.env.DB!,Date.now(),async()=>{
    const state = await getRuntime<ControlState|null>(c.env.DB!,'control',null);
    if (!state) return false;
    state.enabled = !body.paused; delete state.retryAt;
    await setRuntime(c.env.DB!,'control',state);return true;
  });
  if(!changed)return c.json({status:'waiting',reason:'control_busy'},503);
  await reconcileSubscription(c.env,Date.now(),fetch,true);
  return c.json({status:'ok'});
});
// Manual refresh reads the D1 cache only. No repeated paid liked_posts scan.
webApp.post('/api/x/sync',c => c.json({status:'ok',cached:true}));
webApp.post('/api/x/backfill',c => c.json({status:'waiting',reason:'cloud_backfill_disabled'}));
webApp.post('/api/x/connect',c => c.json({status:'waiting',reason:'already_connected'}));
// No unused public disconnect/reconnect/token administration surface.
webApp.post('/api/x/post',async c => {
  const body=await smallJson(c.req.raw);
  if(!body)return c.json({status:'failed'},400);
  return c.json(await readPost(c.env,String(body.postId ?? '')));
});
webApp.post('/api/article',c => c.json({status:'failed',reason:'記事はリンク先で読めます。クラウド版の記事保存は準備中です',code:'cloud_article_disabled'}));
webApp.post('/api/image',c => c.json({status:'failed',reason:'クラウド版の画像保存は準備中です',code:'cloud_image_disabled'}));
