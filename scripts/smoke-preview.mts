import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const bundle=fileURLToPath(new URL('../apps/api/dist/preview/preview-outbound.js',import.meta.url));
let outbound=0;
const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,workers:[{
  name:'preview-parser-check',compatibilityDate:'2026-10-12',
  modules:[{type:'ESModule',path:fileURLToPath(new URL('../apps/api/dist/preview/check.mjs',import.meta.url)),contents:`
    import {ogp} from './preview-outbound.js';
    export default {async fetch(r){return Response.json(await ogp(new TextEncoder().encode(await r.text()),'https://example.org/fixture'));}};
  `},{type:'ESModule',path:bundle,contents:readFileSync(bundle,'utf8')}],
  outboundService:async()=>{outbound++;throw Error('outbound disabled');},
}]}));
try {
  const parsed=await mf.dispatchFetch('https://fixture.invalid/',{method:'POST',body:`<!doctype html><html><head>
    <script>var misleading='<meta property="og:title" content="WRONG">';</script>
    <meta property="og:title" content="架空 &amp; 安全な見出し">
    <meta property="og:description" content="&lt;script&gt;alert(1)&lt;/script&gt;">
    <meta property="og:image" content="/fictional.png"><title>fallback</title></head><body>ignored</body></html>`});
  assert.equal(parsed.status,200);
  assert.deepEqual(await parsed.json(),{title:'架空 & 安全な見出し',description:'<script>alert(1)</script>',imageUrl:'https://example.org/fictional.png'});
  const unsafe=await mf.dispatchFetch('https://fixture.invalid/',{method:'POST',body:'<meta property="og:image" content="https://169.254.169.254/private"><title>fixture</title>'});
  assert.deepEqual(await unsafe.json(),{title:'fixture',description:''});assert.equal(outbound,0);
  console.log('PASS: native Workers HTML parser; decoded text, inert script, unsafe image rejection; zero outbound requests');
} finally {await mf.dispose();}

// Full worker transport, fake public DNS and fake page/image. No real network.
let simulated=0;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0zsAAAAASUVORK5CYII=';
const network=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,workers:[{
  name:'preview-network-check',compatibilityDate:'2026-10-12',modules:true,scriptPath:bundle,
  outboundService:async(request:Request)=>{
    simulated++;assert.equal(request.headers.get('cookie'),null);assert.equal(request.headers.get('authorization'),null);assert.equal(request.headers.get('referer'),null);
    const u=new URL(request.url);
    if(u.hostname==='cloudflare-dns.com')return Response.json({Status:0,Answer:[{type:1,data:'93.184.216.34'}]});
    if(u.href==='https://www.python.org/fictional')return new Response('<meta property="og:title" content="架空の大きなページ"><meta property="og:image" content="/fictional.png">'+ 'x'.repeat(300000)+'<meta property="og:description" content="OUTSIDE_LIMIT">',{headers:{'Content-Type':'text/html'}});
    if(u.href==='https://www.python.org/fictional.png')return new Response(Uint8Array.from(atob(png),s=>s.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});
    throw Error('unplanned simulated request');
  },
}]}));
try {
  const r=await network.dispatchFetch('https://internal.invalid/preview',{method:'POST',body:JSON.stringify({url:'https://www.python.org/fictional'})});
  const result:any=await r.json();assert.equal(result.status,'ok');assert.equal(result.title,'架空の大きなページ');assert.equal(result.description,'');assert.equal(result.image,png);
  assert.equal(simulated,6); // Two DNS queries for each of the two resources.
  console.log('PASS: full isolated Worker; bounded HTML prefix, complete PNG, native HTTPS transport; six simulated requests, zero real outbound');
}finally{await network.dispose();}
