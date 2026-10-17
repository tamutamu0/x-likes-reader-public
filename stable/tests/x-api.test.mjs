import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { XService, normalizePosts } from '../server/x-service.mjs';
const require = createRequire(import.meta.url);
const M = require('../public/js/core/model.js');
const B = require('../public/js/store/backends.js');
const R = require('../public/js/store/repo.js');
const post = (n=1) => ({id:String(8000000000000000000n+BigInt(n)),author_id:'123',text:'架空の検証投稿 '+n,created_at:'2026-10-10T00:00:00Z'});
const author = {id:'123',name:'架空の著者',username:'fictional_test'};
function fixture(t, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'margin-x-test-'));
  let time = Date.parse('2026-10-12T00:00:00Z');
  const x = new XService({directory:dir,clientId:'fictional-client',ownerHandle:'fictional_owner',freeStopAt:new Date(time+90*86400000).toISOString(),fetchImpl,now:()=>time});
  t.after(()=>{x.close();fs.rmSync(dir,{recursive:true,force:true});});
  x.set('tokens',x.seal({access_token:'fictional-secret-token',refresh_token:'fictional-refresh',expiresAt:time+30*86400000}));
  x.set('account',{id:'1',handle:'fictional_owner'});
  return {x,dir,advance:()=>time+=86400000};
}
function reply(body,status=200) { return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}); }

test('PKCE uses S256; cookie/state mismatch and replay never make a network call; tokens stay encrypted', async t=>{
  let calls=0;
  const {x,dir} = fixture(t,async()=>{calls++;throw new Error('unexpected');});
  const a = x.startAuth('http://127.0.0.1:47321/oauth/x/callback'), u=new URL(a.url);
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.equal(u.searchParams.get('scope'),'tweet.read users.read like.read offline.access');
  await assert.rejects(x.finishAuth(u.searchParams.get('state'),'fake','wrong'));
  assert.equal(calls,0);
  assert.ok(!fs.readFileSync(path.join(dir,'x.sqlite')).includes(Buffer.from('fictional-secret-token')));
  assert.ok(!JSON.stringify(x.status()).includes('fictional-secret'));
});

test('initial import reaches 1,000 using ten pages; repeated checks do not use X; no profile lookup; restart keeps admission',async t=>{
  let likes=0,authors=0;
  const {x,dir}=fixture(t,async url=>{
    const u=new URL(url);
    if (u.pathname==='/2/users') {authors++;return reply({data:[author]});}
    likes++;assert.equal(u.searchParams.get('max_results'),'100');
    return reply({data:Array.from({length:100},(_,i)=>post((likes-1)*100+i+1)),meta:{next_token:'page'+likes}});
  });
  const r=await x.sync();assert.equal(r.added,1000);assert.equal(likes,10);assert.equal(authors,0);
  assert.equal(x.status().bootstrapImported,1000);assert.equal(x.status().budget.reservedUsd,1);
  assert.equal((await x.sync()).reason,'interval');assert.equal(likes,10);
  const y=new XService({directory:dir,clientId:'fictional',fetchImpl:async()=>{throw new Error('must not request');},now:x.now});
  assert.equal((await y.sync()).reason,'interval');y.close();
});

test('newest page stops at known IDs and reuses cached authors',async t=>{
  let calls=[];
  const {x,advance}=fixture(t,async url=>{calls.push(new URL(url).pathname);return new URL(url).pathname==='/2/users' ? reply({data:[author]}) : reply({data:[post()],meta:{next_token:'more'}});});
  await x.sync();x.set('bootstrapDone',true);advance();calls=[];
  const r=await x.sync();assert.equal(r.pages,1);assert.equal(r.added,0);assert.deepEqual(calls,['/2/users/1/liked_tweets']);
});

test('API feed order survives old-page imports and daily updates without refetching profiles',async t=>{
  let step=0;
  const {x,advance}=fixture(t,async url=>{
    assert.equal(new URL(url).pathname,'/2/users/1/liked_tweets');
    return reply(step++ === 0 ? {data:[post(2),post(1)],meta:{}} : {data:[post(3),post(2)],meta:{next_token:'old'}});
  });
  await x.sync();advance();await x.sync();
  assert.deepEqual(x.snapshot().entries.map(e=>e.postId),[post(3).id,post(2).id,post(1).id]);
});

test('opening fresh or unknown posts costs nothing; stale lookup uses one post only, hides withheld content, and waits a day',async t=>{
  let calls=0;
  const {x}=fixture(t,async url=>{
    calls++;const u=new URL(url);assert.equal(u.pathname,'/2/tweets');assert.equal(u.searchParams.get('ids'),post().id);assert.ok(!u.searchParams.has('expansions'));
    return reply({data:[{...post(),withheld:{country_codes:['XX']}}]});
  });
  x.save([post()],[author]);
  assert.equal((await x.readPost(post().id)).cached,true);
  assert.equal((await x.readPost(post(99).id)).reason,'unknown_post');assert.equal(calls,0);
  x.db.prepare('UPDATE posts SET fetched=?').run(x.now()-7*86400000);
  await x.readPost(post().id);assert.equal(calls,1);assert.equal(x.snapshot().entries[0].sourceStatus,'removed');
  assert.equal((await x.readPost(post().id)).reason,'interval');assert.equal(calls,1);assert.equal(x.status().budget.monthReservedUsd,0.005);
});

test('offline source expiry preserves personal notes and feed order',async t=>{
  const repo=R.createRepo(B.memoryBackend()), now=Date.parse('2026-10-12T00:00:00Z');
  await repo.applyXSnapshot({revision:1,entries:[{postId:post().id,src:normalizePosts([post()])[0].src,feedOrder:7,fetchedAt:new Date(now).toISOString()}]},now);
  const it=(await repo.loadAll()).items[0];await repo.patchUser(it.id,it.user,{memo:'本人が書いたメモ',read:true},now);
  assert.equal(await repo.expireXSources(now+8*86400000),1);
  const after=(await repo.loadAll()).items[0];assert.equal(after.src.text,'');assert.equal(after.meta.sourceStatus,'expired');assert.equal(after.meta.xFeedOrder,7);assert.equal(after.user.memo,'本人が書いたメモ');assert.ok(after.user.read);
});

test('budget and free-credit expiration block requests before network; 401 pauses; failure admission survives',async t=>{
  let calls=0;
  const {x,advance}=fixture(t,async()=>{calls++;return reply({},401);});
  x.reserve(4950000,'bootstrap_test-limit');assert.equal((await x.sync()).reason,'budget');assert.equal(calls,0);
  x.db.exec('DELETE FROM ledger');x.pause(false);advance();assert.equal((await x.sync()).reason,'auth');assert.equal(calls,1);assert.ok(x.status().paused);
  x.pause(false);assert.equal((await x.sync()).reason,'interval');assert.equal(calls,1);
});

test('weekly confirmation removes explicitly inaccessible sources and unverified content expires; notes remain',async t=>{
  const {x}=fixture(t,async url=>new URL(url).pathname==='/2/tweets' ? reply({errors:[{resource_id:post().id,status:404}]}) : reply({data:[author]}));
  x.save([post()],[author]);x.db.prepare('INSERT INTO viewed VALUES (?,?)').run(post().id,x.now());x.db.prepare('UPDATE posts SET fetched=?').run(x.now()-6.5*86400000);
  await x.refreshStale('fictional');assert.equal(x.snapshot().entries[0].src,null);
  const repo=R.createRepo(B.memoryBackend());
  const src=normalizePosts([post()],[author])[0].src;
  await repo.mergeFetched([{src,via:'like'}],'import',x.now());
  const item=(await repo.loadAll()).items[0];await repo.patchUser(item.id,item.user,{memo:'本人の架空メモ',read:true},x.now());
  await repo.applyXSnapshot({revision:1,entries:[{postId:src.postId,src,fetchedAt:new Date(x.now()).toISOString()}]},x.now());
  await repo.applyXSnapshot({revision:2,entries:[{postId:src.postId,src:null,fetchedAt:new Date(x.now()).toISOString()}]},x.now());
  const after=(await repo.loadAll()).items[0];assert.equal(after.src.text,'');assert.equal(after.user.memo,'本人の架空メモ');assert.equal(after.user.read,true);
});

test('concurrent syncs admit only one network operation; snapshot repeats do not rewrite personal state',async t=>{
  let resolveFetch,calls=0;
  const {x}=fixture(t,async()=>{calls++;return new Promise(resolve=>resolveFetch=resolve);});
  const first=x.sync();await Promise.resolve();assert.equal((await x.sync()).reason,'running');
  resolveFetch(reply({data:[],meta:{}}));await first;assert.equal(calls,1);
  const repo=R.createRepo(B.memoryBackend());
  const snap={revision:1,entries:[{postId:post().id,src:normalizePosts([post()],[author])[0].src,fetchedAt:new Date(x.now()).toISOString()}]};
  await repo.applyXSnapshot(snap,x.now());const before=(await repo.loadAll()).items[0].rev;
  await repo.applyXSnapshot(snap,x.now());assert.equal((await repo.loadAll()).items[0].rev,before);
});

test('OAuth code exchange is bound to browser cookie, rotates once, and rejects replay; no read occurs after credit expiry', async t=>{
  let calls=0;
  const {x}=fixture(t,async url=>{
    calls++;
    return new URL(url).pathname.endsWith('/token') ? reply({access_token:'fake-access',refresh_token:'fake-refresh',expires_in:7200,scope:'tweet.read users.read like.read offline.access'}) : reply({data:{id:'1',username:'fictional_owner',name:'架空'}});
  });
  const a=x.startAuth('http://127.0.0.1:47321/oauth/x/callback'),state=new URL(a.url).searchParams.get('state');
  await x.finishAuth(state,'fake-code',a.cookie);assert.equal(calls,2);
  await assert.rejects(x.finishAuth(state,'fake-code',a.cookie));assert.equal(calls,2);
  x.now=()=>x.freeEnd+1;
  assert.equal((await x.sync()).reason,'budget');assert.equal(calls,2);
});

test('missing or invalid local credit deadline blocks reads before network',async t=>{
  let calls=0;const {dir}=fixture(t,async()=>{calls++;throw new Error('unexpected_network');});
  for(const freeStopAt of ['', 'invalid', '2000-01-01T00:00:00Z']){
    const x=new XService({directory:dir,clientId:'fictional',freeStopAt,now:()=>Date.parse('2026-01-01T00:00:00Z'),fetchImpl:async()=>{calls++;throw new Error('unexpected_network');}});
    try{assert.throws(()=>x.reserve(1000,'fictional'),/budget/);}finally{x.close();}
  }
  assert.equal(calls,0);
});

test('local HTTP rejects foreign origins; OAuth callback accepts only bound cookie and redirects without code; cache polls cost no API reads',async t=>{
  const {createServer}=await import('../server.mjs');
  let syncs=0, callbacks=[];
  const fake={status:()=>({connected:false}),snapshot:()=>({revision:0,entries:[]}),startAuth:()=>({url:'https://x.com/i/oauth2/authorize?state=fake',cookie:'fake-cookie'}),finishAuth:async(...args)=>{callbacks.push(args);if(args[2]!=='fake-cookie')throw new Error('state');},sync:async()=>{syncs++;return {status:'ok'};},startTimer(){},close(){}};
  const server=createServer({port:0,xService:fake});await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const bad=await fetch(base+'/api/x/connect',{method:'POST',headers:{'x-margin-request':'1','content-type':'application/json',origin:'https://example.org'},body:'{}'});assert.equal(bad.status,403);
  const a=await fetch(base+'/api/x/connect',{method:'POST',headers:{'x-margin-request':'1','content-type':'application/json',origin:base},body:'{}'});
  assert.match(a.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  await fetch(base+'/api/x/items',{headers:{'x-margin-request':'1'}});assert.equal(syncs,0);
  const cb=await fetch(base+'/oauth/x/callback?state=fake&code=fake-code',{redirect:'manual',headers:{cookie:'margin-x-state=fake-cookie'}});
  assert.deepEqual(callbacks[0],['fake','fake-code','fake-cookie']);assert.equal(cb.status,303);assert.equal(cb.headers.get('location'),'/?x=connected');assert.equal(syncs,1);
});
