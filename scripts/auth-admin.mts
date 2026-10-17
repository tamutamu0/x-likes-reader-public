// Local administration only. No secret output and no X API calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadDeployment} from './deployment-config.mjs';
const deployment=loadDeployment(),account=deployment.accountId,cache='.cache/cloudflare';
const cfToken=fs.readFileSync(path.join(os.homedir(),'Library/Preferences/.wrangler/config/default.toml'),'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if(!cfToken)throw new Error('missing_cloud_auth');
async function cloud(suffix:string,method='GET',body?:unknown) {
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${suffix}`,{method,headers:{Authorization:'Bearer '+cfToken,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
  const b:any=await r.json();if(!r.ok||!b.success)throw new Error('cloud_'+r.status+'_'+(b.errors?.[0]?.code ?? 'failed'));return b.result;
}
const saved=path.join(cache,'auth-database.json');
try {
  const command=process.argv[2];
  if(command==='create') {
    const list=await cloud('d1/database?name=margin-auth');
    const db=list.find((d:any)=>d.name==='margin-auth') ?? await cloud('d1/database','POST',{name:'margin-auth',primary_location_hint:'apac'});
    fs.writeFileSync(saved,JSON.stringify({id:db.uuid}),{mode:0o600});
    // Preserve tracked templates; deployment identifiers stay local.
    fs.writeFileSync(path.join(cache,'deployment.json'),JSON.stringify({...deployment,authDatabaseId:db.uuid},null,2),{mode:0o600});
    console.log(JSON.stringify({created:true,id:db.uuid}));
  }else{
    const id=deployment.authDatabaseId;
    const query=async(sql:string,params:unknown[]=[])=>{const r=await cloud(`d1/database/${id}/query`,'POST',{sql,params});if(!r[0]?.success)throw new Error('query_failed');return r[0].results;};
    if(command==='link') {
      const token=crypto.randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
      await query('DELETE FROM owner_link_permits');
      await query('INSERT INTO owner_link_permits VALUES (?,?,0)',[crypto.createHash('sha256').update(token).digest('hex'),expiresAt]);
      const url=deployment.origin+'/auth/login#'+token;
      fs.writeFileSync(path.join(cache,'owner-link.json'),JSON.stringify({url,expiresAt}),{mode:0o600});
      fs.writeFileSync(path.join(cache,'login.html'),`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>margin 本人ログイン</title><h1>margin</h1><p>このリンクは24時間・1回限定です。開いたブラウザーで30日使えます。</p><button id="login">本人のWebを開く</button><script>document.getElementById('login').onclick=()=>location.assign(${JSON.stringify(url)})</script></html>`,{mode:0o600});
      console.log(JSON.stringify({ready:true,expiresAt,file:path.resolve(cache,'login.html')}));
    }else if(command==='setup') {
      if((await query('SELECT slot FROM owner_passkey')).length)throw new Error('owner_already_enrolled');
      const token=crypto.randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+600000).toISOString();
      await query('INSERT INTO browser_bootstrap VALUES (?,?,0)',[crypto.createHash('sha256').update(token).digest('hex'),expiresAt]);
      const url=deployment.origin+'/auth/setup#'+token;
      fs.writeFileSync(path.join(cache,'login.html'),`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>margin パスキー登録</title><h1>margin</h1><p>本人専用のパスキーを登録します。登録リンクは10分・1回限定です。</p><button id="login">パスキー登録を開く</button><script>document.getElementById('login').onclick=()=>location.assign(${JSON.stringify(url)})</script></html>`,{mode:0o600});
      console.log(JSON.stringify({ready:true,expiresAt,file:path.resolve(cache,'login.html')}));
    }else if(command==='cancel-setup') {
      await query("DELETE FROM auth_challenges WHERE kind='register'");
      await query("DELETE FROM device_sessions WHERE kind='setup'");
      await query('DELETE FROM browser_bootstrap');
      fs.writeFileSync(path.join(cache,'login.html'),'<!doctype html><html lang="ja"><meta charset="utf-8"><title>margin</title><h1>margin</h1><p>パスキー登録は保留中です。</p></html>',{mode:0o600});
      console.log('{"setupCancelled":true}');
    }else if(command==='verify-link') {
      const root=deployment.origin,token=crypto.randomBytes(32).toString('base64url');
      await query('INSERT INTO owner_link_permits VALUES (?,?,0)',[crypto.createHash('sha256').update(token).digest('hex'),new Date(Date.now()+60000).toISOString()]);
      const exchange=()=>fetch(root+'/auth/link/exchange',{method:'POST',headers:{Origin:root,'Content-Type':'application/json','X-Margin-Request':'1'},body:JSON.stringify({token}),redirect:'error',signal:AbortSignal.timeout(15000)});
      const r=await exchange(),cookie=r.headers.getSetCookie().find(s=>s.startsWith('__Host-margin-session='))?.split(';')[0];
      if(r.status!==200 || !cookie)throw new Error('link_exchange_failed');
      const get=(session='')=>fetch(root+'/api/health',{headers:{Cookie:session,'X-Margin-Request':'1'},redirect:'manual',signal:AbortSignal.timeout(15000)});
      const health=await get(cookie),healthBody:any=await health.json();
      const imagePath='/api/link-preview/'+'a'.repeat(64)+'/image';
      const report={sessionWorks:health.status===200,previewEnabled:healthBody.linkPreview===true,
        previewScriptAvailable:(await fetch(root+'/js/ui/previews.js',{headers:{Cookie:cookie},redirect:'manual',signal:AbortSignal.timeout(15000)})).status===200,
        previewAnonymousRejected:(await fetch(root+imagePath,{redirect:'manual',signal:AbortSignal.timeout(15000)})).status===401,
        previewUnknownImageAbsent:(await fetch(root+imagePath,{headers:{Cookie:cookie},redirect:'manual',signal:AbortSignal.timeout(15000)})).status===404,
        anonymousRejected:(await get()).status===401,replayRejected:(await exchange()).status===401,
        staticUnlocked:(await fetch(root+'/',{headers:{Cookie:cookie},redirect:'manual',signal:AbortSignal.timeout(15000)})).status===200,xReads:0};
      await fetch(root+'/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:root,'X-Margin-Request':'1'},redirect:'error',signal:AbortSignal.timeout(15000)});
      const verified={...report,logoutRejected:(await get(cookie)).status===401};
      console.log(JSON.stringify(verified));if(Object.values(verified).some(v=>v===false))throw new Error('link_verification_failed');
    }else if(command==='status') {
      const owner=(await query('SELECT count(*) n FROM owner_passkey'))[0].n;
      const sessions=(await query("SELECT count(*) n FROM device_sessions WHERE kind='web' AND revoked=0 AND expires_at>?",[new Date().toISOString()]))[0].n;
      console.log(JSON.stringify({ownerEnrolled:owner===1,activeSessions:sessions}));
    }else if(command==='verify-boundaries') {
      const reports=[];
      for(const name of ['margin-api','margin-core','margin-x-events','margin-preview']) {
        const settings=await cloud(`workers/scripts/${name}/settings`),subdomain=await cloud(`workers/scripts/${name}/subdomain`),schedules=await cloud(`workers/scripts/${name}/schedules`);
        reports.push({name,public:subdomain.enabled,preview:subdomain.previews_enabled,crons:schedules.schedules.map((s:any)=>s.cron),bindings:settings.bindings.map((b:any)=>({name:b.name,type:b.type,...(b.type==='service'?{service:b.service,entrypoint:b.entrypoint}:{}),...(b.type==='d1'?{id:b.id}:{} )}))});
      }
      const gateway=reports[0],core=reports[1],receiver=reports[2],preview=reports[3];
      if(preview.public || preview.preview || preview.crons.length || preview.bindings.length)throw new Error('preview_boundary_verification_failed');
      if(!core.bindings.some((b:any)=>b.name==='PREVIEW' && b.type==='service' && b.service==='margin-preview'))throw new Error('preview_service_missing');
      if(!gateway.bindings.some((b:any)=>b.name==='MCP_RATE_LIMITER' && b.type==='ratelimit'))throw new Error('mcp_rate_limit_missing');
      if(core.public || core.preview || gateway.bindings.some((b:any)=>b.name==='DB'||b.name.startsWith('X_')) || receiver.bindings.some((b:any)=>b.type==='d1') || !gateway.bindings.some((b:any)=>b.name==='AUTH_DB') || !receiver.bindings.some((b:any)=>b.service==='margin-core'))throw new Error('boundary_verification_failed');
      if(gateway.crons.length || receiver.crons.length || core.crons.length!==1 || core.crons[0]!=='*/15 * * * *')throw new Error('cron_boundary_verification_failed');
      console.log(JSON.stringify({verified:true,workers:reports}));
    }else if(command==='revoke-all'){await query('UPDATE device_sessions SET revoked=1');await query('DELETE FROM owner_link_permits');console.log('{"revoked":true}');}
    else throw new Error('unknown_command');
  }
}catch(e:any){console.log(JSON.stringify({failed:true,reason:/^[a-z0-9_]+$/.test(e.message)?e.message:'operation_failed'}));process.exitCode=1;}
