import type { Bindings } from './types';
import { hashToken } from './session';
import { SOURCE_TTL } from './x-inbox';
// @ts-expect-error Shared, dependency-free JS protocol validation.
import { normalizeArgs } from '../../../packages/contracts/mcp-reader.mjs';

export async function mcpAuthorized(request:Request,env:Bindings,now=Date.now()) {
  // No browser credential crossover. No CORS, Cookie, or owner login reuse.
  if(!env.AUTH_DB || request.headers.has('Origin') || request.headers.has('Cookie'))return false;
  const auth=request.headers.get('Authorization');
  if(!auth || !/^Bearer mr_[A-Za-z0-9_-]{43}$/.test(auth))return false;
  return !!await env.AUTH_DB.prepare('SELECT id FROM mcp_read_tokens WHERE token_hash=? AND revoked=0 AND expires_at>?')
    .bind(await hashToken(auth.slice(7)),new Date(now).toISOString()).first();
}
type Row={id:string;source_json:string|null;metadata_json:string};
const clean=(v:unknown,n:number)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n):'';
function source(row:Row,now:number) {
  const meta=JSON.parse(row.metadata_json),fetched=Date.parse(meta.fetchedAt);
  return row.source_json && Number.isFinite(fetched) && fetched>now-SOURCE_TTL ? JSON.parse(row.source_json):null;
}
function links(src:any){return (Array.isArray(src?.links)?src.links:[]).slice(0,12).flatMap((l:any)=>{
  try{const u=new URL(l.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.href.length>2048)return [];
    return [{url:u.href,title:clean(l.title,200),description:clean(l.description,300)}];}catch{return [];}
});}
function summary(row:Row,now:number,detail=false,offset=0){
  const meta=JSON.parse(row.metadata_json),s=source(row,now),id=row.id.slice(2),text=typeof s?.text==='string'?s.text:'';
  return {postId:id,postUrl:'https://x.com/i/web/status/'+id,likedAt:meta.likedAt ?? null,
    fetchedAt:meta.fetchedAt ?? null,timeBasis:meta.likedAt?'liked':'first_saved',sourceStatus:s?'available':meta.sourceStatus==='removed'?'removed':'expired',
    author:s?{name:clean(s.author?.name,60),handle:clean(s.author?.handle,15)}:null,
    ...(detail?{text:s?text.slice(offset,offset+8000):null,textOffset:offset,nextTextOffset:offset+8000<text.length?offset+8000:null}
      :{excerpt:clean(text,360),textLength:text.length}),links:links(s)};
}
function cursor(raw:string){
  try{const v=JSON.parse(atob(raw.replaceAll('-','+').replaceAll('_','/')));
    if(typeof v.at!=='string'||new Date(v.at).toISOString()!==v.at||!/^x:[0-9]{1,19}$/.test(v.id))throw Error();return v;
  }catch{throw Error('invalid_arguments');}
}
const nextCursor=(row:Row)=>btoa(JSON.stringify({at:JSON.parse(row.metadata_json).likedAt ?? JSON.parse(row.metadata_json).fetchedAt,id:row.id})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export async function savedData(env:Bindings,action:string,input:unknown,now=Date.now()){
  const a=normalizeArgs(action,input),db=env.DB!;
  if(action==='status'){
    const counts=await db.prepare(`SELECT count(*) total,sum(CASE WHEN source_json IS NOT NULL AND json_extract(metadata_json,'$.fetchedAt')>? THEN 1 ELSE 0 END) readable,
      max(json_extract(metadata_json,'$.likedAt')) latestLikeAt FROM items WHERE json_extract(metadata_json,'$.origin')='x'`)
      .bind(new Date(now-SOURCE_TTL).toISOString()).first();
    const rows=await db.prepare("SELECT key,value FROM x_runtime WHERE key IN ('control','cronHealth')").all<{key:string;value:string}>();
    const values=Object.fromEntries(rows.results.map(r=>[r.key,JSON.parse(r.value)]));
    return {asOf:new Date(now).toISOString(),counts,automaticUpdate:{enabled:values.control?.enabled===true,reason:values.control?.reason ?? null,
      checkedAt:values.control?.lastCheckAt ?? null,subscriptionExpiresAt:values.control?.expiresAt ?? null,cronOk:values.cronHealth?.ok===true},
      sourceRetentionDays:7,notes:'Saved likes only. No X reads. Personal notes/read state stay in the browser and are not included.'};
  }
  if(action==='post'){
    const row=await db.prepare("SELECT id,source_json,metadata_json FROM items WHERE id=? AND json_extract(metadata_json,'$.origin')='x'").bind('x:'+a.postId).first<Row>();
    return {asOf:new Date(now).toISOString(),post:row?summary(row,now,true,a.textOffset):null};
  }
  const timeSql="coalesce(json_extract(metadata_json,'$.likedAt'),json_extract(metadata_json,'$.fetchedAt'))";
  const args:unknown[]=[new Date(now-a.days*86400000).toISOString(),new Date(now).toISOString(),new Date(now-SOURCE_TTL).toISOString()];
  let where=`json_extract(metadata_json,'$.origin')='x' AND ${timeSql}>=? AND ${timeSql}<=?
    AND source_json IS NOT NULL AND json_extract(metadata_json,'$.fetchedAt')>?`;
  if(a.query)for(const term of a.query.toLowerCase().split(/\s+/u)){
    // Literal substring search, not SQL syntax, regex or wildcard expansion.
    where+=` AND instr(lower(coalesce(json_extract(source_json,'$.text'),'')||' '||coalesce(json_extract(source_json,'$.author.name'),'')||' '||coalesce(json_extract(source_json,'$.author.handle'),'')||' '||coalesce(json_extract(source_json,'$.links'),'')),?)>0`;args.push(term);
  }
  if(a.cursor){const c=cursor(a.cursor);where+=` AND (${timeSql}<? OR (${timeSql}=? AND id<?))`;args.push(c.at,c.at,c.id);}
  args.push(a.limit+1);
  const {results}=await db.prepare(`SELECT id,source_json,metadata_json FROM items WHERE ${where} ORDER BY ${timeSql} DESC,id DESC LIMIT ?`).bind(...args).all<Row>();
  const page=results.slice(0,a.limit);
  return {asOf:new Date(now).toISOString(),windowDays:a.days,...(a.query?{query:a.query}:{}),items:page.map(row=>summary(row,now)),
    nextCursor:results.length>a.limit?nextCursor(page.at(-1)!):null,sourceRetentionDays:7,untrustedContent:true};
}
export async function mcpRead(request:Request,env:Bindings){
  if(!await mcpAuthorized(request,env))return new Response(null,{status:401});
  const action=new URL(request.url).pathname.slice('/mcp-read/'.length);
  if(request.method!=='POST'||!['recent','search','post','status'].includes(action))return new Response(null,{status:404});
  if(!request.headers.get('Content-Type')?.startsWith('application/json')||!env.DB)return new Response(null,{status:400});
  const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400});
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>4096){await reader.cancel();return new Response(null,{status:413});}chunks.push(c.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return Response.json(await savedData(env,action,JSON.parse(new TextDecoder().decode(bytes))));}
  catch(e){if(e instanceof SyntaxError||(e instanceof Error&&e.message==='invalid_arguments'))return new Response(null,{status:400});throw e;}
}
