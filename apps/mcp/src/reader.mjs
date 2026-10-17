import {lstat,readFile} from 'node:fs/promises';
import {readerOrigin,PREFIX,normalizeArgs} from '../../../packages/contracts/mcp-reader.mjs';

export async function loadCredentials(file,now=Date.now()){
  const stat=await lstat(file).catch(()=>{throw Error('credentials_missing');});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||(process.getuid && (stat.uid!==process.getuid()||(stat.mode&0o077))))throw Error('credentials_permissions');
  let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch{throw Error('credentials_invalid');}
  if(!value||!/^mr_[A-Za-z0-9_-]{43}$/.test(value.token)||!Number.isFinite(Date.parse(value.expiresAt)))throw Error('credentials_invalid');
  readerOrigin(value.origin);
  if(Date.parse(value.expiresAt)<=now)throw Error('credentials_expired');
  return value;
}
export function createReader(credentials,{fetcher=fetch,now=Date.now}={}){
  const running=new Map();
  return async(action,input)=>{
    const args=normalizeArgs(action,input),key=JSON.stringify([action,args]);
    if(running.has(key))return running.get(key);
    const task=(async()=>{
      const c=await credentials(now());
      // The owner selects one origin in a private credential file. Tool arguments
      // cannot select an endpoint. No caller-supplied endpoint,
      // redirects, Cookie, X credentials, or Cloudflare administration token.
      const response=await fetcher(readerOrigin(c.origin)+PREFIX+action,{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:JSON.stringify(args),
        redirect:'manual',signal:AbortSignal.timeout(15000)});
      if(response.status===401)throw Error('credentials_rejected');
      if(response.status===429)throw Error('rate_limited');
      if(!response.ok)throw Error('reader_unavailable');
      if(!response.headers.get('Content-Type')?.startsWith('application/json'))throw Error('reader_unavailable');
      const reader=response.body?.getReader();if(!reader)throw Error('reader_unavailable');
      const chunks=[];let size=0;
      try{while(true){const c=await reader.read();if(c.done)break;size+=c.value.length;if(size>196608)throw Error('reader_unavailable');chunks.push(c.value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      try{const data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}catch{throw Error('reader_unavailable');}
    })();
    running.set(key,task);try{return await task;}finally{running.delete(key);}
  };
}
