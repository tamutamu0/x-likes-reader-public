import type { Bindings } from './types';
import { previewUrl, trustedHost, IMAGE_LIMIT, imageType } from './preview-network';
const DAY=86400000;
export async function previewKey(url:string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function linkPreview(env:Bindings, postId:string, raw:string, now=Date.now()) {
  if(!env.DB || !env.PREVIEW || !/^[0-9]{1,19}$/.test(postId))return {status:'unavailable'};
  let url:string;try{url=previewUrl(raw).href;}catch{return {status:'unavailable'};}
  // Only links already saved for this owner's post may be fetched. This is
  // not an arbitrary URL proxy. No post text, cookies or tokens sent onward.
  const item=await env.DB.prepare('SELECT source_json,metadata_json FROM items WHERE id=?').bind('x:'+postId).first<{source_json:string|null;metadata_json:string}>();
  if(!item?.source_json || Date.parse(JSON.parse(item.metadata_json).fetchedAt)<=now-7*DAY)return {status:'unavailable'};
  const link=JSON.parse(item.source_json).links?.find((l:any)=>{try{return previewUrl(l.url).href===url;}catch{return false;}});
  if(!link)return {status:'unavailable'};
  if(!trustedHost(new URL(url).hostname))return {status:'unavailable',title:link.title || new URL(url).hostname,description:link.description || '',expiresAt:now+DAY};
  const key=await previewKey(url);
  const row=await env.DB.prepare('SELECT expires_at,status,data_json,image_type FROM link_previews WHERE url_key=?').bind(key)
    .first<{expires_at:number;status:string;data_json:string|null;image_type:string|null}>();
  const result=(r:typeof row)=>({status:r!.status,...(r!.data_json?JSON.parse(r!.data_json):{}),expiresAt:r!.expires_at,
    ...(r!.image_type?{imagePath:'/api/link-preview/'+key+'/image'}:{})});
  if(row && row.expires_at>now)return result(row);
  const claimed=await env.DB.prepare(`INSERT INTO link_previews(url_key,expires_at,status) VALUES (?,?,'pending')
    ON CONFLICT(url_key) DO UPDATE SET expires_at=excluded.expires_at,status='pending',data_json=NULL,image=NULL,image_type=NULL
    WHERE link_previews.expires_at<=? RETURNING url_key`).bind(key,now+30000,now).first();
  if(!claimed)return {status:'pending',expiresAt:now+30000};
  const day=new Date(now).toISOString().slice(0,10);
  const allowance=await env.DB.prepare(`INSERT INTO preview_daily_budget(day,attempts) VALUES (?,1)
    ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<60 RETURNING attempts`).bind(day).first();
  const fallback={title:typeof link.title==='string'?link.title.slice(0,200):new URL(url).hostname,
    description:typeof link.description==='string'?link.description.slice(0,300):''};
  let status='unavailable',data=fallback,expiresAt=now+DAY,image:Uint8Array|null=null,type:string|null=null;
  if(!allowance){status='limited';expiresAt=Date.parse(day+'T00:00:00Z')+DAY;}
  else try {
    const response=await env.PREVIEW.fetch(new Request('https://internal.invalid/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,
      ...(link.title && link.imageUrl?{delivered:{title:link.title,description:link.description,imageUrl:link.imageUrl}}:{})})}));
    const rawReply=await response.text();if(rawReply.length>360000)throw Error('size');
    const reply=JSON.parse(rawReply);
    if(reply.status==='ok') {
      status='ok';expiresAt=now+7*DAY;
      const clean=(v:unknown,n:number)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n):'';
      data={title:clean(reply.title,200)||fallback.title,description:clean(reply.description,300)||fallback.description};
      if(typeof reply.image==='string' && reply.image.length<=Math.ceil(IMAGE_LIMIT/3)*4 && /^[A-Za-z0-9+/]+={0,2}$/.test(reply.image)) {
        const candidate=Uint8Array.from(atob(reply.image),ch=>ch.charCodeAt(0));if(candidate.length<=IMAGE_LIMIT && imageType(candidate) && imageType(candidate)===reply.imageType){image=candidate;type=reply.imageType;}
      }
    }
  }catch{/* Cache failure too; never fall back to X lookup. */}
  expiresAt=Math.min(expiresAt,Date.parse(JSON.parse(item.metadata_json).fetchedAt)+7*DAY);
  await env.DB.prepare('UPDATE link_previews SET expires_at=?,status=?,data_json=?,image=?,image_type=? WHERE url_key=?')
    .bind(expiresAt,status,JSON.stringify(data),image?.buffer ?? null,type,key).run();
  return {status,...data,expiresAt,...(image?{imagePath:'/api/link-preview/'+key+'/image'}:{})};
}
export async function previewImage(env:Bindings,key:string,now=Date.now()) {
  if(!/^[a-f0-9]{64}$/.test(key) || !env.DB)return new Response(null,{status:404});
  const row=await env.DB.prepare("SELECT image,image_type FROM link_previews WHERE url_key=? AND expires_at>? AND status='ok'")
    .bind(key,now).first<{image:number[];image_type:string}>();
  if(!row?.image || !['image/png','image/jpeg','image/webp'].includes(row.image_type))return new Response(null,{status:404});
  // D1 reads BLOBs as numeric arrays, not ArrayBuffer. Response(array) would
  // stringify it and corrupt the image despite the correct Content-Type.
  const bytes=Uint8Array.from(row.image);
  if(!bytes.length || bytes.length>IMAGE_LIMIT || imageType(bytes)!==row.image_type)return new Response(null,{status:404});
  return new Response(bytes,{headers:{'Content-Type':row.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=86400','Content-Security-Policy':"default-src 'none'; sandbox"}});
}
export async function expirePreviews(db:D1Database,now=Date.now()) {
  await db.batch([db.prepare('DELETE FROM link_previews WHERE expires_at<?').bind(now),
    db.prepare('DELETE FROM preview_daily_budget WHERE day<?').bind(new Date(now-30*DAY).toISOString().slice(0,10))]);
}
