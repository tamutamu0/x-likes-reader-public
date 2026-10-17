import { getRuntime, XClient, reserve, type XBindings } from './x-runtime';
import { withXLock, type ControlState } from './x-control';
import { ReaderStore } from './store';
import { postSnapshot } from './x-webhook';
import { source } from './x-inbox';
// A viewed stale/missing post only: no daily sweep through the 1,001 imports.
export async function readPost(env: XBindings, postId: string, now=Date.now(), fetcher:typeof fetch=fetch) {
  if (!env.DB || env.X_SYNC_ENABLED !== 'true' || !/^[0-9]{1,19}$/.test(postId)) return {status:'waiting',reason:'unavailable'};
  const db=env.DB, store=new ReaderStore(db);
  const item=await store.get('x:'+postId);
  if (!item) return {status:'failed',reason:'unknown_post'};
  if (item.source && Date.parse(item.metadata.fetchedAt)>now-6*86400000) return {status:'ok',cached:true};
  return await withXLock(db,now,async()=>{
    const state=await getRuntime<ControlState|null>(db,'control',null);
    if (!state?.enabled || state.reason || (state.retryAt ?? 0)>now || !state.lastCheckAt || Date.parse(state.lastCheckAt)<now-15*60000 || (state.freeBalance ?? 0)<=1)
      return {status:'waiting',reason:'not_available'};
    const last=await db.prepare('SELECT attempted_at FROM x_lookup_attempts WHERE post_id=?').bind(postId).first<{attempted_at:string}>();
    if (last && Date.parse(last.attempted_at)>now-86400000) return {status:'waiting',reason:'interval'};
    const time=new Date(now).toISOString();
    try {
      await reserve(db,now,5000,'read_post');
      await db.prepare('INSERT INTO x_lookup_attempts VALUES (?,?) ON CONFLICT(post_id) DO UPDATE SET attempted_at=excluded.attempted_at').bind(postId,time).run();
      const result=await new XClient(env,fetcher,()=>now).request('/2/tweets?'+new URLSearchParams({ids:postId,'tweet.fields':'author_id,created_at,entities,note_tweet'}),'GET',undefined,true);
      const tweet=result.data?.find((p:any)=>p.id===postId);
      const removed=tweet?.withheld || result.errors?.some((e:any)=>(e.resource_id ?? e.value)===postId && (e.type?.includes('resource-not-found') || [403,404].includes(e.status)));
      if (removed) { await store.removeSource(item.id,time); return {status:'ok'}; }
      if (!tweet || !/^[0-9]{1,19}$/.test(tweet.author_id)) return {status:'waiting',reason:'no_body'};
      const snapshot=postSnapshot({includes:{tweets:[tweet]}},postId,tweet.author_id);
      const src=source({event_uuid:'lookup',post_id:postId,author_id:tweet.author_id,liked_at:item.metadata.likedAt ?? time,received_at:time,post_json:snapshot ? JSON.stringify(snapshot):null});
      if (!src) return {status:'waiting',reason:'no_body'};
      if (item.source?.author.handle) src.author=item.source.author;
      await db.prepare(`UPDATE items SET source_json=?, metadata_json=json_set(metadata_json,'$.fetchedAt',?,'$.sourceStatus','available'),
        revision=revision+1, updated_at=? WHERE id=?`).bind(JSON.stringify(src),time,time,item.id).run();
      return {status:'ok'};
    } catch { return {status:'failed',reason:'lookup_unavailable'}; }
  }) ?? {status:'waiting',reason:'busy'};
}
