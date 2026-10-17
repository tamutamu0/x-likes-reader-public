// Mac administration only. Never expose this CLI as an MCP tool or HTTP route.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadDeployment} from './deployment-config.mjs';
import {createReader,loadCredentials} from '../apps/mcp/src/reader.mjs';
const deployment=loadDeployment(),account=deployment.accountId,database=deployment.authDatabaseId,origin=deployment.origin;
const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'.cache/mcp');
const clients=['codex','claude-code','claude-desktop'];
async function query(sql,params=[]){
 const token=fs.readFileSync(path.join(os.homedir(),'Library/Preferences/.wrangler/config/default.toml'),'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
 if(!token)throw Error('cloud_auth_missing');
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({sql,params}),redirect:'error',signal:AbortSignal.timeout(20000)});
 const v=await r.json();if(!r.ok||!v.success||!v.result?.[0]?.success)throw Error('cloud_query_failed');return v.result[0].results;
}
try{
 const [action,client]=process.argv.slice(2);
 if(action==='status'){console.log(JSON.stringify({clients:await query('SELECT id,client,expires_at,revoked FROM mcp_read_tokens ORDER BY client,expires_at DESC')}));}
 else{
  if(!clients.includes(client))throw Error('unknown_client');
  const file=path.join(directory,client+'.json');
  if(action==='issue'){
   fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
   const token='mr_'+crypto.randomBytes(32).toString('base64url'),id=crypto.randomUUID(),expiresAt=new Date(Date.now()+30*86400000).toISOString();
   await query('INSERT INTO mcp_read_tokens VALUES (?,?,?,?,0)',[id,crypto.createHash('sha256').update(token).digest('hex'),client,expiresAt]);
   try{const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify({origin,token,expiresAt,id,client}),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
   catch{await query('UPDATE mcp_read_tokens SET revoked=1 WHERE id=?',[id]);throw Error('credential_write_failed');}
   await query('UPDATE mcp_read_tokens SET revoked=1 WHERE client=? AND id<>?',[client,id]);
   console.log(JSON.stringify({issued:true,client,expiresAt,file,scope:'saved_likes_read_only'}));
  }else if(action==='revoke'){
   await query('UPDATE mcp_read_tokens SET revoked=1 WHERE client=?',[client]);console.log(JSON.stringify({revoked:true,client}));
  }else if(action==='verify'){
   const c=await loadCredentials(file),read=createReader(()=>Promise.resolve(c));
   const status=await read('status',{}),recent=await read('recent',{limit:3});
   const blocked=await fetch(origin+'/api/x/status',{headers:{Authorization:'Bearer '+c.token,'X-Margin-Request':'1'},redirect:'manual',signal:AbortSignal.timeout(15000)});
   const invalid=await fetch(origin+'/mcp-read/pause',{method:'POST',headers:{Authorization:'Bearer '+c.token,'Content-Type':'application/json'},body:'{}',redirect:'manual',signal:AbortSignal.timeout(15000)});
   const report={client,readOnlyStatusWorks:Number.isInteger(status.counts?.total),recentWorks:Array.isArray(recent.items),recentCount:recent.items?.length,
    webApiRejected:blocked.status===401,writeRouteAbsent:invalid.status===404,sourceRetentionDays:status.sourceRetentionDays,xReads:0};
   console.log(JSON.stringify(report));if(Object.values(report).some(v=>v===false))throw Error('verification_failed');
  }else throw Error('unknown_command');
 }
}catch(e){console.error(JSON.stringify({failed:true,reason:/^[a-z_]+$/.test(e.message)?e.message:'operation_failed'}));process.exitCode=1;}
