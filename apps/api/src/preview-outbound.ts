import { externalResource, previewUrl, type PreviewTransport } from './preview-network';

const publicHttps: PreviewTransport = async (u, _ip, deadline, limit) => {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
  try {
    const res=await fetch(u.href,{method:'GET',redirect:'manual',signal:controller.signal,headers:{
      Accept:'text/html,image/png,image/jpeg,image/webp','User-Agent':'margin-preview/1.0','Accept-Encoding':'identity',Range:'bytes=0-'+(limit-1),
    }});
    const headers:Record<string,string>={};for(const key of ['location','content-type','content-range']){const v=res.headers.get(key);if(v)headers[key]=v;}
    if(res.status!==200 && res.status!==206){await res.body?.cancel();return {status:res.status,headers,body:new Uint8Array()};}
    const reader=res.body?.getReader();if(!reader)throw Error('body');
    const chunks:Uint8Array[]=[];let size=0;
    const html=['text/html','application/xhtml+xml'].includes((headers['content-type'] ?? '').split(';')[0].trim().toLowerCase());
    // OGP normally lives in the head: cancel after a bounded HTML prefix.
    // Images must remain complete; never cache a truncated image.
    try {while(true){const part=await reader.read();if(part.done)break;
      if(size+part.value.length>limit){if(!html)throw Error('size');chunks.push(part.value.subarray(0,limit-size));size=limit;break;}
      size+=part.value.length;chunks.push(part.value);
    }}
    finally {await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
    return {status:res.status,headers,body};
  }finally{clearTimeout(timer);}
};

export async function ogp(html:Uint8Array, finalUrl:string) {
  const values:Record<string,string>={};let title='';
  const decode=(s:string)=>s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi,(_all,key:string)=>{
    if(key[0]!=='#')return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[key.toLowerCase()];
    const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
    return n>0 && n<=0x10ffff && !(n>=0xd800 && n<=0xdfff)?String.fromCodePoint(n):'';
  });
  // Native streaming HTML parser; HTML/JS is never executed or returned.
  const output=new HTMLRewriter().on('meta',{element(e){
    const key=(e.getAttribute('property') ?? e.getAttribute('name') ?? '').toLowerCase();
    if(['og:title','og:description','og:image','twitter:title','twitter:description','twitter:image','description'].includes(key) && !values[key])
      values[key]=decode((e.getAttribute('content') ?? '').slice(0,2048));
  }}).on('title',{text(t){title=(title+t.text).slice(0,200);}})
    .transform(new Response(html,{headers:{'Content-Type':'text/html;charset=UTF-8'}}));
  await output.arrayBuffer();
  const clean=(v:string,n:number)=>decode(v).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,n);
  let imageUrl:string|undefined;
  try{const raw=values['og:image'] || values['twitter:image'];if(raw)imageUrl=previewUrl(new URL(raw,finalUrl).href).href;}catch{/* no unsafe image */}
  return {title:clean(values['og:title'] || values['twitter:title'] || title,200),
    description:clean(values['og:description'] || values['twitter:description'] || values.description || '',300),imageUrl};
}

export default {
  async fetch(request:Request) {
    // Service binding only. No DB, secrets, other bindings, or public URL.
    if(request.method!=='POST' || new URL(request.url).pathname!=='/preview')return new Response(null,{status:404});
    try {
      const raw=await request.text();if(raw.length>4096)return new Response(null,{status:413});
      const body=JSON.parse(raw);const url=previewUrl(body.url).href,deadline=Date.now()+10000;
      let metadata:{title:string;description:string;imageUrl?:string};
      if(body.delivered && typeof body.delivered.title==='string' && typeof body.delivered.imageUrl==='string')
        metadata={title:body.delivered.title.slice(0,200),description:String(body.delivered.description ?? '').slice(0,300),imageUrl:previewUrl(body.delivered.imageUrl).href};
      else {const page=await externalResource(url,'html',publicHttps,undefined,undefined,deadline);metadata=await ogp(page.body,page.finalUrl);}
      let image:string|undefined,imageType:string|undefined;
      if(metadata.imageUrl)try{const resource=await externalResource(metadata.imageUrl,'image',publicHttps,undefined,undefined,deadline);let binary='';
        for(let i=0;i<resource.body.length;i+=8192)binary+=String.fromCharCode(...resource.body.subarray(i,i+8192));
        image=btoa(binary);imageType=resource.type;}catch{/* Keep the useful text card if image unavailable. */}
      return Response.json({status:'ok',title:metadata.title,description:metadata.description,...(image?{image,imageType}:{})});
    } catch {return Response.json({status:'unavailable'});}
  },
};
