import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {URL as NodeURL} from 'node:url';
import {mcpAuthorized,mcpRead,savedData} from '../src/mcp-reader';
import {hashToken,authenticated} from '../src/session';
import type {Bindings} from '../src/types';
const now=Date.parse('2026-10-17T01:00:00Z'),day=86400000;
function setup(){
 const sql=new DatabaseSync(':memory:');
 for(const f of readdirSync(new NodeURL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new NodeURL('../migrations/'+f,import.meta.url),'utf8'));
 sql.exec(readFileSync(new NodeURL('../auth-migrations/0003_mcp_read_tokens.sql',import.meta.url),'utf8'));
 const db={prepare(query:string){let args:any[]=[];const p={bind(...a:any[]){args=a;return p;},async first(){return sql.prepare(query).get(...args)??null;},async all(){return {results:sql.prepare(query).all(...args)};}};return p;}} as unknown as D1Database;
 const add=(id:string,days:number,text:string,liked=true)=>sql.prepare('INSERT INTO items VALUES (?,1,?,?,?,?)').run('x:'+id,JSON.stringify({text,author:{name:'架空',handle:'fictional'},links:[{url:'https://example.org/fixture',title:'架空ライブラリ'}]}),JSON.stringify({memo:'本人メモを外へ返さない',read:true}),JSON.stringify({origin:'x',fetchedAt:new Date(now-days*day).toISOString(),...(liked?{likedAt:new Date(now-days*day).toISOString()}:{})}),new Date(now).toISOString());
 const env:Bindings={DB:db,AUTH_DB:db,AUTH_MODE:'link',APP_ENV:'production'};return {sql,db,env,add};
}
test('scoped credentials reject cookies, browser origins, expired/revoked credentials and never open owner Web',async()=>{
 const {sql,env}=setup(),token='mr_'+'a'.repeat(43),hash=await hashToken(token);
 sql.prepare('INSERT INTO mcp_read_tokens VALUES (?,?,?,?,0)').run('fixture',hash,'fictional',new Date(now+day).toISOString());
 const request=(headers:Record<string,string>={})=>new Request('https://example.org/mcp-read/recent',{headers:{Authorization:'Bearer '+token,...headers}});
 assert.equal(await mcpAuthorized(request(),env,now),true);
 assert.equal(await mcpAuthorized(request({Cookie:'__Host-margin-session=fictional'}),env,now),false);
 assert.equal(await mcpAuthorized(request({Origin:'https://example.org'}),env,now),false);
 assert.equal(await authenticated(request(),env),false);
 assert.equal(await mcpAuthorized(request(),env,now+day),false);
 sql.prepare('UPDATE mcp_read_tokens SET revoked=1').run();assert.equal(await mcpAuthorized(request(),env,now),false);
});
test('recent/search use saved data only; literal AND search, imported time basis, pagination and no personal edits',async()=>{
 const {sql,env,add}=setup();add('125',0.2,'Audio Motion');add('124',0.3,'audio music');add('123',0.4,'AUDIO MOTION',false);
 const a:any=await savedData(env,'recent',{limit:2},now);assert.deepEqual(a.items.map((i:any)=>i.postId),['125','124']);assert.ok(a.nextCursor);
 const b:any=await savedData(env,'recent',{limit:2,cursor:a.nextCursor},now);assert.equal(b.items[0].postId,'123');assert.equal(b.items[0].timeBasis,'first_saved');assert.equal(b.items[0].likedAt,null);
 const s:any=await savedData(env,'search',{query:'audio motion'},now);assert.equal(s.items.length,2);
 assert.equal((await savedData(env,'search',{query:'%'},now) as any).items.length,0);
 assert.equal((await savedData(env,'search',{query:"' OR 1=1 --"},now) as any).items.length,0);
 assert.ok(!JSON.stringify(a).includes('本人メモ'));
 assert.equal(JSON.parse(sql.prepare("SELECT user_json FROM items WHERE id='x:125'").get()!.user_json as string).read,true);
});
test('expired source never escapes through list, search or detail and is never fetched again',async()=>{
 const {env,add}=setup();add('123',8,'PRIVATE_EXPIRED');
 assert.equal((await savedData(env,'recent',{},now) as any).items.length,0);
 assert.equal((await savedData(env,'search',{query:'PRIVATE_EXPIRED'},now) as any).items.length,0);
 const p:any=await savedData(env,'post',{postId:'123'},now);assert.equal(p.post.text,null);assert.deepEqual(p.post.links,[]);assert.equal(p.post.author,null);
});
test('bounds reject extra args, oversized requests, invalid cursor and cap long text',async()=>{
 const {env,add}=setup();add('123',0,'x'.repeat(20000));
 for(const args of [{limit:1000},{days:8},{url:'https://example.org'},{cursor:'bad_cursor'}])await assert.rejects(()=>savedData(env,'recent',args,now));
 const detail:any=await savedData(env,'post',{postId:'123'},now);assert.equal(detail.post.text.length,8000);assert.equal(detail.post.nextTextOffset,8000);
 const later:any=await savedData(env,'post',{postId:'123',textOffset:16000},now);assert.equal(later.post.text.length,4000);assert.equal(later.post.nextTextOffset,null);
 const unauthorized=await mcpRead(new Request('https://example.org/mcp-read/recent',{method:'POST',body:'{}'}),env);assert.equal(unauthorized.status,401);
});
