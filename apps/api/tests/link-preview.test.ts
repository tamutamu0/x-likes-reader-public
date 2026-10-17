import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { externalResource, previewUrl, trustedHost } from '../src/preview-network';
import { linkPreview, previewImage, expirePreviews } from '../src/link-preview';
import type { Bindings } from '../src/types';
const encoder=new TextEncoder(),now=Date.parse('2026-10-13T02:00:00Z');
const url='https://www.python.org/fictional-article';
function setup(reply:any={status:'ok',title:'架空の見出し',description:'架空の説明'}) {
  const sql=new DatabaseSync(':memory:');
  for(const file of readdirSync(new NodeURL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new NodeURL('../migrations/'+file,import.meta.url),'utf8'));
  const db={prepare(query:string){let args:any[]=[];const stmt={bind(...v:any[]){args=v.map(a=>a instanceof ArrayBuffer?new Uint8Array(a):a);return stmt;},
    async first(){return sql.prepare(query).get(...args) ?? null;},async run(){return sql.prepare(query).run(...args);}};return stmt;},async batch(s:any[]){for(const a of s)await a.run();}} as unknown as D1Database;
  sql.prepare('INSERT INTO items VALUES (?,1,?,?,?,?)').run('x:123',JSON.stringify({postId:'123',author:{name:'架空',handle:'fixture'},text:'架空',links:[{url,title:'example.org'}]}),JSON.stringify({memo:'大切なメモ'}),JSON.stringify({origin:'x',fetchedAt:new Date(now).toISOString()}),new Date(now).toISOString());
  let calls=0;const env:Bindings={DB:db,PREVIEW:{async fetch(request:Request){calls++;const input=await request.json() as any;
    assert.deepEqual(Object.keys(input),['url']);assert.equal(input.url,url);assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('authorization'),null);
    return Response.json(reply);}} as any};
  return {env,sql,calls:()=>calls};
}
test('previews reject local, credential, signed, X and arbitrary ports without any DNS request',async()=>{
  for(const raw of ['http://example.org','https://user:pass@example.org','https://127.0.0.1','https://[::1]','https://0x7f000001','https://metadata.internal',
    'https://example.org:444/a','https://example.org/a?access_token=SECRET','https://example.org/oauth/callback','https://x.com/a/status/1','https://private-reader.example.workers.dev'])
    assert.throws(()=>previewUrl(raw),raw);
  assert.equal(previewUrl(url+'?utm_source=fixture#anchor').href,url);
});
test('every redirect checks trusted host and all DNS addresses; mixed private DNS is rejected',async()=>{
  let calls=0;
  await assert.rejects(()=>externalResource(url,'html',async()=>{calls++;throw Error();},async()=>['93.184.216.34','10.0.0.1'],()=>true));assert.equal(calls,0);
  let dns=0;
  const result=await externalResource(url,'html',async(u,ip)=>{
    assert.equal(ip,'93.184.216.34');calls++;
    return {status:200,headers:{'content-type':'text/html'},body:encoder.encode('<title>fixture</title>')};
  },async()=>{dns++;return ['93.184.216.34'];},()=>true);assert.equal(result.status,200);assert.equal(dns,1);
  await assert.rejects(()=>externalResource(url,'html',async()=>({status:302,headers:{location:'https://169.254.169.254/secrets'},body:new Uint8Array()}),async()=>['93.184.216.34']));
});
test('arbitrary hosts never reach DNS or transport; allowlist uses DNS label boundaries',async()=>{
  assert.equal(trustedHost('docs.github.com'),true);assert.equal(trustedHost('github.com.evil.org'),false);assert.equal(trustedHost('evilgithub.com'),false);
  await assert.rejects(()=>externalResource('https://untrusted.org/article','html',async()=>{throw Error('should not call');},async()=>{throw Error('should not call');}));
});
test('only saved, unexpired owner post URLs get fetched; failures, successes and shared URLs cached',async()=>{
  const {env,sql,calls}=setup();
  assert.equal((await linkPreview(env,'123','https://example.org/other',now)).status,'unavailable');assert.equal(calls(),0);
  const [a,b]=await Promise.all([linkPreview(env,'123',url,now),linkPreview(env,'123',url,now)]);
  assert.ok([a.status,b.status].includes('ok'));assert.equal(calls(),1);
  assert.equal((await linkPreview(env,'123',url,now+1000)).title,'架空の見出し');assert.equal(calls(),1);
  assert.equal(JSON.parse(String(sql.prepare("SELECT user_json FROM items WHERE id='x:123'").get()!.user_json)).memo,'大切なメモ');
  assert.equal((await linkPreview(env,'123',url,now+8*86400000)).status,'unavailable');assert.equal(calls(),1);
  const failed=setup({status:'unavailable'});await linkPreview(failed.env,'123',url,now);await linkPreview(failed.env,'123',url,now+1000);assert.equal(failed.calls(),1);
});
test('daily hard limit prevents outbound calls and malformed/SVG image replies never become image endpoints',async()=>{
  const {env,sql,calls}=setup();sql.prepare('INSERT INTO preview_daily_budget VALUES (?,60)').run('2026-10-13');
  assert.equal((await linkPreview(env,'123',url,now)).status,'limited');assert.equal(calls(),0);
  const malformed=setup({status:'ok',title:'fixture',image:btoa('<svg onload="bad"/>'),imageType:'image/svg+xml'});
  const response=await linkPreview(malformed.env,'123',url,now);assert.ok(!('imagePath' in response));
  assert.equal((await previewImage(malformed.env,'a'.repeat(64),now)).status,404);
  await expirePreviews(malformed.env.DB!,now+15*86400000);assert.equal(malformed.sql.prepare('SELECT COUNT(*) n FROM link_previews').get()!.n,0);
});
