import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './runtime-db';
import {sealTokens,openTokens,setRuntime,getRuntime,budget,creditStopAt,reserve,XClient,type XBindings} from '../src/x-runtime';
import {reconcileSubscription,type ControlState} from '../src/x-control';
import {readPost} from '../src/x-lookup';
const time=Date.parse('2026-01-01T12:00:00Z');
const DEADLINE=time+90*86400000;
test('transport is invoked as a standalone native function for token refresh and credit lookup',async()=>{
  const s=await setup();
  await setRuntime(s.db,'tokens',await sealTokens({access_token:'old',refresh_token:'refresh',scope:'like.read',expiresAt:time},s.env.X_VAULT_KEY!));
  const paths:string[]=[];
  const nativeStyle:typeof fetch=async function(this:unknown,input,init){
    assert.equal(this,undefined,'Workers native fetch rejects a class instance as its receiver');
    const path=new URL(String(input)).pathname;paths.push(path);
    if(path==='/2/oauth2/token')return Response.json({access_token:'fresh',refresh_token:'fresh-refresh',scope:'like.read',expires_in:7200});
    return Response.json({data:{free_balance:20,prepaid_balance:0}});
  };
  await new XClient(s.env,nativeStyle,()=>time).request('/2/usage/credits');
  assert.deepEqual(paths,['/2/oauth2/token','/2/usage/credits']);
  assert.equal((await openTokens(await getRuntime(s.db,'tokens',null),s.env.X_VAULT_KEY!)).access_token,'fresh');
});
async function setup() {
  const {db,sqlite}=database();
  const key=btoa('k'.repeat(32));
  const env:XBindings={DB:db,X_SYNC_ENABLED:'true',X_VAULT_KEY:key,X_OAUTH2_CLIENT_ID:'synthetic',X_OAUTH2_CLIENT_SECRET:'synthetic'};
  await setRuntime(db,'tokens',await sealTokens({access_token:'fictional',refresh_token:'fictional-refresh',scope:'tweet.read like.read offline.access',expiresAt:time+7200000},key));
  const state:ControlState={enabled:true,ownerId:'8000000000000000001',webhookId:'8000000000000000002',tag:'margin-cloud-synthetic',freeStopAt:DEADLINE};
  await setRuntime(db,'control',state);
  let active:any[]=[],credit=20,posts=0,lists=0;
  const paths:string[]=[];
  const fake:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));paths.push(url.pathname);
    assert.equal(url.origin,'https://api.x.com'); assert.equal(init?.redirect,'manual');
    if(url.pathname==='/2/usage/credits')return Response.json({data:{free_balance:credit,prepaid_balance:0}});
    if(url.pathname==='/2/activity/subscriptions' && init?.method==='POST'){
      posts++; const body=JSON.parse(String(init.body));active=[{...body,subscription_id:'8000000000000000003'}];return Response.json({data:{subscription:active[0]}});
    }
    if(url.pathname==='/2/activity/subscriptions'){lists++;return Response.json({data:active});}
    if(url.pathname.startsWith('/2/activity/subscriptions/') && init?.method==='DELETE'){active=[];return Response.json({data:{deleted:true}});}
    throw new Error('unexpected_endpoint');
  };
  return {db,sqlite,env,state,fake,paths,active:()=>active,posts:()=>posts,lists:()=>lists,setCredit:(v:number)=>credit=v};
}
test('finite owner outbound lease, concurrent calls create once; fresh lease never reads posts or profiles',async()=>{
  const s=await setup();await Promise.all([reconcileSubscription(s.env,time,s.fake),reconcileSubscription(s.env,time,s.fake)]);
  assert.equal(s.posts(),1);assert.equal(s.active()[0].filter.qualifiers.direction,'outbound');
  assert.equal(s.active()[0].expires_at,new Date(time+3600000).toISOString());
  await reconcileSubscription(s.env,time+900000,s.fake);assert.equal(s.posts(),1);
  assert.ok(s.paths.every(p=>p.includes('activity/subscriptions') || p==='/2/usage/credits'));
  await reconcileSubscription(s.env,time+1800000,s.fake);assert.equal(s.posts(),2);assert.equal(s.active().length,1);
});
test('low free credits, budget exhaustion and absolute expiry stop without making a new subscription',async()=>{
  for(const reason of ['credits','budget','expiry']){
    const s=await setup();await reconcileSubscription(s.env,time,s.fake);
    if(reason==='credits')s.setCredit(0.5);
    if(reason==='budget')s.sqlite.prepare('INSERT INTO x_budget VALUES (?,?,?,?)').run('reserved',new Date(time).toISOString(),1000000,'synthetic');
    if(reason==='expiry')await setRuntime(s.db,'tokens',await sealTokens({access_token:'fictional',refresh_token:'fictional-refresh',scope:'like.read',expiresAt:DEADLINE+7200000},s.env.X_VAULT_KEY!));
    const state=await reconcileSubscription(s.env,reason==='expiry' ? DEADLINE:time+900000,s.fake);
    assert.equal(s.active().length,0);assert.equal(s.posts(),1);assert.ok(state?.reason);
  }
});
test('ambiguous creation is reconciled before another POST; invalid filters cause deletion and disable',async()=>{
  const s=await setup();let lost=true;
  const network:typeof fetch=async(url,init)=>{const result=await s.fake(url,init);if(init?.method==='POST' && lost){lost=false;throw new Error('synthetic_network');}return result;};
  await reconcileSubscription(s.env,time,network);assert.equal(s.posts(),1);
  await reconcileSubscription(s.env,time+1800000,network);assert.equal(s.posts(),2); // adopted at threshold, then replaced
  assert.equal(s.active().length,1);
  const bad=await setup();const malformed:typeof fetch=async(url,init)=>{
    const result=await bad.fake(url,init);if(init?.method==='POST'){const body=await result.json() as any;body.data.subscription.filter.qualifiers.direction='inbound';return Response.json(body);}return result;};
  const state=await reconcileSubscription(bad.env,time,malformed);assert.equal(state?.enabled,false);assert.equal(bad.active().length,0);
});
test('duplicate UUID reserves once, historical imports reserve nothing; prior month only counts in lifetime total',async()=>{
  const {db,sqlite}=database();
  const insert=sqlite.prepare('INSERT OR IGNORE INTO x_activity_inbox VALUES (?,?,?,?,?,?,NULL)');
  for(let i=0;i<2;i++)insert.run('same','8000000000000000003','8000000000000000004',new Date(time).toISOString(),new Date(time).toISOString(),null);
  sqlite.prepare('INSERT INTO x_budget VALUES (?,?,?,?)').run('old','2025-12-01T00:00:00Z',2000000,'bootstrap_import');
  assert.deepEqual({...await budget(db,time)},{total:2010000,month:10000,bootstrap:2000000});
});
test('uncertain refresh preserves encrypted credentials and disables retries; vault cannot be decrypted with another key',async()=>{
  const s=await setup();const old=await sealTokens({access_token:'old',refresh_token:'old-refresh',scope:'like.read',expiresAt:time},s.env.X_VAULT_KEY!);
  await setRuntime(s.db,'tokens',old);let count=0;
  const fail:typeof fetch=async()=>{count++;throw new Error('synthetic_network');};
  await reconcileSubscription(s.env,time,fail);await reconcileSubscription(s.env,time+1800000,fail);
  assert.equal(count,1);assert.deepEqual(await getRuntime(s.db,'tokens',null),old);
  assert.equal((await getRuntime<ControlState>(s.db,'control',s.state)).enabled,false);
  await assert.rejects(openTokens(old,btoa('z'.repeat(32))));
});
test('only viewed missing post is fetched once per day, reserving first, without author expansion or wiping notes',async()=>{
  const s=await setup();await reconcileSubscription(s.env,time,s.fake);
  const id='x:8000000000000000003',stamp=new Date(time).toISOString();
  s.sqlite.prepare('INSERT INTO items VALUES (?,1,NULL,?,?,?)').run(id,JSON.stringify({state:'inbox',read:true,laterUntil:null,tags:['メモ'],memo:'保持',genre:null}),JSON.stringify({origin:'x',fictional:false,sourceStatus:'pending',fetchedAt:stamp,likedAt:stamp}),stamp);
  let calls=0;
  const post:typeof fetch=async(url,init)=>{
    calls++;const u=new URL(String(url));assert.equal(u.pathname,'/2/tweets');assert.equal(u.searchParams.get('ids'),id.slice(2));assert.equal(u.searchParams.has('expansions'),false);
    assert.equal((await budget(s.db,time)).month,5000);
    return Response.json({data:[{id:id.slice(2),author_id:'8000000000000000004',text:'架空本文',created_at:stamp}]});};
  await readPost(s.env,id.slice(2),time,post);await readPost(s.env,id.slice(2),time,post);assert.equal(calls,1);
  const row=s.sqlite.prepare('SELECT * FROM items WHERE id=?').get(id)!;assert.equal(JSON.parse(row.user_json as string).memo,'保持');
  assert.equal(JSON.parse(row.source_json as string).text,'架空本文');
});

test('missing or invalid private deadline blocks subscription creation and paid reads',async()=>{
  for(const freeStopAt of [undefined,0,-1,NaN,Infinity,Number.MAX_VALUE]){
    const s=await setup();await setRuntime(s.db,'control',{...s.state,freeStopAt});
    const result=await reconcileSubscription(s.env,time,s.fake);
    assert.equal(result?.reason,'credits_expiry');assert.equal(s.posts(),0);
    await assert.rejects(()=>reserve(s.db,time,5000,'synthetic'),/budget/);
    assert.equal(s.paths.length,0);
  }
  assert.equal(creditStopAt({freeStopAt:DEADLINE}),DEADLINE);
});
