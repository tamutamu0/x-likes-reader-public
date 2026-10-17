import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReader,loadCredentials} from '../src/reader.mjs';
const ORIGIN='https://reader.example.org';
const token='mr_'+'f'.repeat(43),now=Date.parse('2026-10-17T00:00:00Z');
test('credential files require private owner permissions, owner-configured HTTPS origin and unexpired scoped token',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'margin-mcp-'));const file=path.join(dir,'fictional.json');
 try{
  const credentials={origin:ORIGIN,token,expiresAt:new Date(now+1000).toISOString()};await writeFile(file,JSON.stringify(credentials),{mode:0o600});assert.equal((await loadCredentials(file,now)).token,token);
  await assert.rejects(()=>loadCredentials(file,now+2000),/expired/);await chmod(file,0o644);await assert.rejects(()=>loadCredentials(file,now),/permissions/);await chmod(file,0o600);
  for(const origin of ['http://reader.example.org','https://localhost','https://127.0.0.1','https://[::1]','https://reader.example.org:444','https://u:p@reader.example.org','https://reader.example.org/path','https://reader.example.org#fragment']){
   await writeFile(file,JSON.stringify({...credentials,origin}));await assert.rejects(()=>loadCredentials(file,now),/invalid/);
  }
  await symlink(file,path.join(dir,'link'));await assert.rejects(()=>loadCredentials(path.join(dir,'link'),now),/permissions/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('reader posts only to the fixed saved-data endpoint; bounds before network, redirects rejected, duplicate inflight collapsed',async()=>{
 let calls=0;const read=createReader(async()=>({token,origin:ORIGIN}),{fetcher:async(url,options)=>{
  calls++;assert.equal(url,ORIGIN+'/mcp-read/recent');assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,'Bearer '+token);
  await new Promise(r=>setImmediate(r));return Response.json({items:[]});
 }});
 await Promise.all([read('recent',{}),read('recent',{})]);assert.equal(calls,1);
 await assert.rejects(()=>read('recent',{url:'https://evil.example'}),/invalid_arguments/);assert.equal(calls,1);
 const moved=createReader(async()=>({token,origin:ORIGIN}),{fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://evil.example'}})});
 await assert.rejects(()=>moved('recent',{}),/reader_unavailable/);
 const rejected=createReader(async()=>({token,origin:ORIGIN}),{fetcher:async()=>new Response('DO_NOT_LEAK',{status:401})});await assert.rejects(()=>rejected('recent',{}),/credentials_rejected/);
});
