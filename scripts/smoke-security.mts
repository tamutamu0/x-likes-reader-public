import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHmac,createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {authenticator,origin} from '../apps/api/tests/passkey-fixture';
const secret='SYNTHETIC_SECRET_NOT_REAL',owner='8000000000000000001',postId='8000000000000000003';
let outbound=0;
const shared={compatibilityDate:'2026-10-12',modules:true,outboundService:async()=>{outbound++;throw Error('outbound disabled');}};
const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,d1Persist:false,workers:[
  {...shared,name:'gateway',modules:[{type:'ESModule',path:fileURLToPath(new URL('../apps/api/dist/gateway.js',import.meta.url))},...readdirSync(new URL('../apps/api/dist/',import.meta.url)).filter(s=>/^[a-f0-9]+-auth-client\.txt$/.test(s)).map(s=>({type:'Text' as const,path:fileURLToPath(new URL('../apps/api/dist/'+s,import.meta.url))}))],d1Databases:{AUTH_DB:'synthetic-auth'},bindings:{AUTH_ORIGIN:origin,APP_ENV:'production'},serviceBindings:{CORE:'core',ASSETS:'assets'},ratelimits:{AUTH_RATE_LIMITER:{namespace_id:'1001',simple:{limit:200,period:60}},MCP_RATE_LIMITER:{namespace_id:'3001',simple:{limit:200,period:60}}}},
  {...shared,name:'core',scriptPath:fileURLToPath(new URL('../apps/api/dist/core/worker.js',import.meta.url)),d1Databases:{DB:'synthetic-reader',AUTH_DB:'synthetic-auth'},bindings:{APP_ENV:'production',X_INBOX_PROCESSING_ENABLED:'true',X_SYNC_ENABLED:'false',X_OWNER_ID:owner,X_OAUTH2_CLIENT_SECRET:secret}},
  {...shared,name:'receiver',scriptPath:fileURLToPath(new URL('../apps/api/dist/webhook/x-webhook.js',import.meta.url)),bindings:{X_WEBHOOK_ENABLED:'true',X_OWNER_ID:owner,X_OAUTH2_CLIENT_SECRET:secret},serviceBindings:{X_INBOX_PROCESSOR:{name:'core',entrypoint:'InboxProcessor'}}},
  {...shared,name:'assets',script:'export default {fetch(){return new Response("SYNTHETIC_PRIVATE_WEB")}}'},

]}));
const mfLink=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,d1Persist:false,workers:[
  {...shared,name:'link-gateway',modules:[{type:'ESModule',path:fileURLToPath(new URL('../apps/api/dist/gateway.js',import.meta.url))},...readdirSync(new URL('../apps/api/dist/',import.meta.url)).filter(s=>/^[a-f0-9]+-auth-client\.txt$/.test(s)).map(s=>({type:'Text' as const,path:fileURLToPath(new URL('../apps/api/dist/'+s,import.meta.url))}))],d1Databases:{AUTH_DB:'synthetic-link-auth'},bindings:{AUTH_ORIGIN:origin,APP_ENV:'production',AUTH_MODE:'link'},serviceBindings:{CORE:'link-core',ASSETS:'assets'},ratelimits:{AUTH_RATE_LIMITER:{namespace_id:'1002',simple:{limit:200,period:60}},MCP_RATE_LIMITER:{namespace_id:'3002',simple:{limit:200,period:60}}}},
  {...shared,name:'link-core',scriptPath:fileURLToPath(new URL('../apps/api/dist/core/worker.js',import.meta.url)),d1Databases:{DB:'synthetic-reader',AUTH_DB:'synthetic-link-auth'},bindings:{APP_ENV:'production',AUTH_MODE:'link',X_SYNC_ENABLED:'false'}},
  {...shared,name:'assets',script:'export default {fetch(){return new Response("SYNTHETIC_PRIVATE_WEB")}}'},
]}));
const cookie=(r:Response,name:string)=>r.headers.getSetCookie().find(s=>s.startsWith(name+'='))!.split(';')[0];
try {
  const source=await mf.getD1Database('DB','core'),auth=await mf.getD1Database('AUTH_DB','gateway');
  const linkAuth=await mfLink.getD1Database('AUTH_DB','link-gateway'),linkSource=await mfLink.getD1Database('DB','link-core');
  for(const [db,dir] of [[source,'migrations'],[auth,'auth-migrations'],[linkAuth,'auth-migrations'],[linkSource,'migrations']] as const) {
    for(const file of readdirSync(new URL('../apps/api/'+dir+'/',import.meta.url)).filter(s=>s.endsWith('.sql')).sort()) {
      const sql=readFileSync(new URL('../apps/api/'+dir+'/'+file,import.meta.url),'utf8').replace(/^--.*$/gm,'');
      for(const match of sql.matchAll(/\s*(CREATE TRIGGER[\s\S]*?END;|[\s\S]*?;)/g))await db.prepare(match[1]).run();
    }
  }
  const get=(path:string,c='',headers:Record<string,string>={})=>mf.dispatchFetch(origin+path,{headers:{Cookie:c,...headers},redirect:'manual'});
  const post=(path:string,body:unknown,c='',headers:Record<string,string>={})=>mf.dispatchFetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:c,'Content-Type':'application/json','X-Margin-Request':'1',...headers},body:JSON.stringify(body),redirect:'manual'});
  for(const path of ['/','/index.html','/js/sample.js','/css/app.css','/unknown'])assert.equal((await get(path)).status,302,path);
  for(const path of ['/api/health','/api/x/status','/api/x/items','/v1/health','/v1/items','/v1/changes'])assert.equal((await get(path,'',{'Cf-Access-Authenticated-User-Email':'fake@example.test','Cf-Access-Jwt-Assertion':'fake'})).status,401,path);
  assert.equal((await post('/api/link-preview',{postId,url:'https://www.python.org/'})).status,401);
  assert.equal((await get('/api/link-preview/'+'a'.repeat(64)+'/image')).status,401);
  assert.equal((await post('/auth/session',{token:'a'.repeat(43)})).status,404,'old bootstrap route removed');
  assert.equal((await post('/auth/register/options',{})).status,403,'no public registration');
  const crc=await (await (await mf.getWorker('receiver')).fetch('https://events.example/webhooks/x?crc_token=fictional')).json() as any;
  assert.equal(crc.response_token,'sha256='+createHmac('sha256',secret).update('fictional').digest('base64'));
  const t='a'.repeat(43);await auth.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').bind(createHash('sha256').update(t).digest('hex'),new Date(Date.now()+60000).toISOString()).run();
  const exchanged=await post('/auth/setup/exchange',{token:t}),permit=cookie(exchanged,'__Host-margin-setup');assert.equal(exchanged.status,200);
  assert.equal((await get('/v1/items',permit)).status,401,'setup permit cannot read data');
  const options=await post('/auth/register/options',{},permit),o:any=await options.json(),challenge=cookie(options,'__Host-margin-challenge'),device=authenticator();
  const registered=await post('/auth/register/verify',device.register(o.challenge),permit+'; '+challenge);assert.equal(registered.status,200);
  let session=cookie(registered,'__Host-margin-session');
  assert.equal((await get('/api/link-preview/'+'a'.repeat(64)+'/image',session)).status,404,'image path still needs owner session');
  const syntheticPng=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0zsAAAAASUVORK5CYII='),s=>s.charCodeAt(0));
  await source.prepare("INSERT INTO link_previews(url_key,expires_at,status,image,image_type) VALUES (?,?,'ok',?,'image/png')").bind('a'.repeat(64),Date.now()+60000,syntheticPng.buffer).run();
  const imageResponse=await get('/api/link-preview/'+'a'.repeat(64)+'/image',session);
  assert.equal(imageResponse.headers.get('Content-Type'),'image/png');assert.deepEqual(new Uint8Array(await imageResponse.arrayBuffer()),syntheticPng,'D1 BLOB must become exact image bytes, never a comma-separated string');
  assert.equal((await post('/api/link-preview',{postId,url:'https://www.python.org/'},session,{Origin:'https://evil.example.test'})).status,403);
  const web=await get('/',session);assert.equal(await web.text(),'SYNTHETIC_PRIVATE_WEB');assert.match(web.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);
  assert.match(web.headers.get('Content-Security-Policy')!,/script-src 'self'/);assert.equal(web.headers.get('Cache-Control'),'no-store');
  const receiver=await mf.getWorker('receiver'),raw=JSON.stringify({data:{event_uuid:'synthetic-security',event_type:'like.create',created_at:new Date().toISOString(),payload:{liking_user_id:owner,liked_tweet_id:postId,liked_tweet_author_id:'8000000000000000004'},includes:{tweets:[{id:postId,author_id:'8000000000000000004',text:'架空の非公開投稿',created_at:'2020-01-01T00:00:00.000Z'}]}}});
  assert.equal((await receiver.fetch('https://events.example/webhooks/x',{method:'POST',headers:{'Content-Type':'application/json'},body:raw})).status,401);
  const notify=()=>receiver.fetch('https://events.example/webhooks/x',{method:'POST',headers:{'Content-Type':'application/json','X-Twitter-Webhooks-Signature-OAuth2':'sha256='+createHmac('sha256',secret).update(raw).digest('base64')},body:raw});
  assert.equal((await notify()).status,200);
  for(let n=0;n<30;n++){if(await source.prepare('SELECT id FROM items').first())break;await new Promise(r=>setTimeout(r,20));}
  const item:any=await (await get('/v1/items/x:'+postId,session)).json();assert.equal(item.source.text,'架空の非公開投稿');
  const mcpToken='mr_'+'b'.repeat(43);
  await auth.prepare('INSERT INTO mcp_read_tokens VALUES (?,?,?,?,0)').bind('synthetic-mcp',createHash('sha256').update(mcpToken).digest('hex'),'synthetic',new Date(Date.now()+60000).toISOString()).run();
  const mcp=(path:string,body:unknown={},extra:Record<string,string>={})=>mf.dispatchFetch(origin+path,{method:'POST',headers:{Authorization:'Bearer '+mcpToken,'Content-Type':'application/json',...extra},body:JSON.stringify(body),redirect:'manual'});
  const recentMcp=await mcp('/mcp-read/recent',{limit:3});assert.equal(recentMcp.status,200);const saved:any=await recentMcp.json();assert.equal(saved.items[0].postId,postId);
  assert.equal((await mcp('/mcp-read/recent',{}, {Origin:origin})).status,401);
  assert.equal((await mcp('/mcp-read/recent',{}, {Cookie:session})).status,401);
  assert.equal((await mcp('/mcp-read/pause')).status,404);
  assert.equal((await mcp('/api/x/pause',{paused:true},{Origin:origin,'X-Margin-Request':'1'})).status,401,'MCP cannot change subscriptions');
  assert.equal((await get('/v1/items','',{Authorization:'Bearer '+mcpToken})).status,401,'MCP cannot use owner API');
  assert.equal((await mcp('/mcp-read/recent',{limit:1000})).status,400);
  await auth.prepare("UPDATE mcp_read_tokens SET revoked=1 WHERE id='synthetic-mcp'").run();assert.equal((await mcp('/mcp-read/recent')).status,401);
  const patch=(headers:Record<string,string>)=>mf.dispatchFetch(origin+'/v1/items/x:'+postId,{method:'PATCH',headers:{Cookie:session,'Content-Type':'application/json',...headers},body:JSON.stringify({expectedRevision:1,changes:{memo:'架空の本人メモ'}})});
  assert.equal((await patch({})).status,403,'cookie writes need origin and CSRF header');
  assert.equal((await patch({Origin:'https://evil.example.test','X-Margin-Request':'1'})).status,403);
  assert.equal((await patch({Origin:origin,'X-Margin-Request':'1'})).status,200);
  assert.equal((await notify()).status,200);assert.equal((await (await get('/v1/items/x:'+postId,session)).json() as any).user.memo,'架空の本人メモ');
  assert.equal((await receiver.fetch('https://events.example/v1/items')).status,404);
  assert.equal((await post('/auth/logout-all',{},session)).status,200);assert.equal((await get('/v1/items',session)).status,401);
  const login=await post('/auth/login/options'),loginOptions:any=await login.json(),loginChallenge=cookie(login,'__Host-margin-challenge');
  const logged=await post('/auth/login/verify',device.login(loginOptions.challenge,o.user.id),loginChallenge);assert.equal(logged.status,200);
  session=cookie(logged,'__Host-margin-session');assert.equal((await get('/api/x/items',session,{'X-Margin-Request':'1'})).status,200);
  const link={fetch:(url:string,init:RequestInit={})=>mfLink.dispatchFetch(url,init)};
  const linkPost=(body:unknown,c='',path='/auth/link/exchange')=>link.fetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:c,'Content-Type':'application/json','X-Margin-Request':'1'},body:JSON.stringify(body)});
  const linkGet=(c='')=>link.fetch(origin+'/api/x/items',{headers:{Cookie:c,'X-Margin-Request':'1'}});
  assert.equal((await linkGet()).status,401);
  assert.equal((await linkPost({},'','/auth/register/options')).status,403);
  await linkAuth.prepare('INSERT INTO owner_link_permits VALUES (?,?,0)').bind(createHash('sha256').update(t).digest('hex'),new Date(Date.now()+60000).toISOString()).run();
  const ownerLogin=await linkPost({token:t});assert.equal(ownerLogin.status,200);assert.match(ownerLogin.headers.get('Set-Cookie')!,/Max-Age=2592000/);
  const linkSession=cookie(ownerLogin,'__Host-margin-session');
  assert.equal((await linkGet(linkSession)).status,200,'both gateway and private core accept only the link session');
  assert.equal((await linkPost({token:t})).status,401,'owner link consumed once');
  assert.equal((await linkPost({},linkSession,'/auth/logout-all')).status,200);
  assert.equal((await linkGet(linkSession)).status,401);
  assert.equal(outbound,0);
  console.log('PASS: real Workers crypto/D1; one-use owner link and passkey modes, private source service, DB-less signed receiver, CSRF, replay, revocation, headers; zero outbound requests');
}finally{await mf.dispose();await mfLink.dispose();}
