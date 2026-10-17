// Explicit local administration only. Never a remotely accessible admin route.
// Secrets and private reports are written under ignored .cache/, mode 600.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {backup} from 'node:sqlite';
import {XService} from '../stable/server/x-service.mjs';
import {sealTokens,getRuntime,setRuntime,budget,type XBindings} from '../apps/api/src/x-runtime';
import {reconcileSubscription,withXLock,type ControlState} from '../apps/api/src/x-control';

import {loadDeployment} from './deployment-config.mjs';
const deployment=loadDeployment(),command=process.argv[2],account=deployment.accountId,database=deployment.databaseId;
const cache='.cache/cloudflare';fs.mkdirSync(cache,{recursive:true,mode:0o700});
const safeWrite=(name:string,value:unknown)=>fs.writeFileSync(path.join(cache,name),JSON.stringify(value,null,2),{mode:0o600});
const output=(v:unknown)=>console.log(JSON.stringify(v));
const config=fs.readFileSync(path.join(os.homedir(),'Library/Preferences/.wrangler/config/default.toml'),'utf8');
const cfToken=config.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if(!cfToken)throw new Error('missing_cf_auth');
async function cloud(suffix:string,body?:unknown){
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${suffix}`,{method:body ? 'POST':'GET',headers:{Authorization:'Bearer '+cfToken,...(body ? {'Content-Type':'application/json'}:{})},...(body ? {body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
  const value:any=await r.json().catch(()=>({}));if(!r.ok || !value.success)throw new Error('cloud_request_'+r.status);return value.result;
}
async function query(sql:string,params:unknown[]=[]){const result=await cloud(`d1/database/${database}/query`,{sql,params});if(!result[0]?.success)throw new Error('db_query');return result[0];}
const prepare=(sql:string)=>{let args:unknown[]=[];const p={bind(...a:unknown[]){args=a;return p;},async first(){return (await query(sql,args)).results[0] ?? null;},async all(){return await query(sql,args);},async run(){return await query(sql,args);}};return p;};
const db={prepare} as unknown as D1Database;
const secretsPath=path.join(cache,'worker-secrets.json');
function env():XBindings{const secrets=JSON.parse(fs.readFileSync(secretsPath,'utf8'));return {DB:db,X_SYNC_ENABLED:'true',...secrets};}
try{
  if(command==='migrate'){
    // Start with a consistent, recoverable SQLite backup. Preserve originals
    // and the browser IndexedDB; no X read request is made during migration.
    const service=new XService({directory:'stable/data/x'});
    try{
      const backupPath=path.join(cache,'before-cloud.sqlite');
      if(!fs.existsSync(backupPath)){await backup(service.db,backupPath);fs.chmodSync(backupPath,0o600);}
      service.pause(true);service.set('reason','cloud_migration');
      const secrets=fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath,'utf8')) : {X_VAULT_KEY:crypto.randomBytes(32).toString('base64')};
      const local=fs.readFileSync('stable/.env.x.local','utf8');
      const localValue=(key:string)=>local.split('\n').find(s=>s.startsWith(key+'='))?.slice(key.length+1).trim().replace(/^(["'])(.*)\1$/,'$2');
      secrets.X_OAUTH2_CLIENT_ID=localValue('X_CLIENT_ID');secrets.X_OAUTH2_CLIENT_SECRET=localValue('X_CLIENT_SECRET');
      if(!secrets.X_OAUTH2_CLIENT_ID || !secrets.X_OAUTH2_CLIENT_SECRET || !service.tokens())throw new Error('missing_x_configuration');
      safeWrite('worker-secrets.json',secrets);
      safeWrite('receiver-secrets.json',{X_OWNER_ID:service.get('account').id,X_OAUTH2_CLIENT_SECRET:secrets.X_OAUTH2_CLIENT_SECRET});
      if(!await getRuntime(db,'tokens',null))await setRuntime(db,'tokens',await sealTokens(service.tokens(),secrets.X_VAULT_KEY));
      await setRuntime(db,'account',service.get('account'));
      const rows=service.db.prepare('SELECT * FROM posts ORDER BY feed_order,id').all();
      const stamp=new Date().toISOString();let imported=0;
      // Each parameterized INSERT is atomic at D1. Ignore preexisting items;
      // rerunning this command never overwrites cloud-side notes or tokens.
      for(let i=0;i<rows.length;i+=50){
        const records:any[]=[];
        for(const row of rows.slice(i,i+50)){
          const old=row.source ? JSON.parse(row.source):null;
          const fetchedAt=new Date(row.fetched).toISOString();
          const fresh=row.fetched>Date.now()-7*86400000;
          const source=old && fresh ? {postId:row.id,url:old.url,author:old.author,text:old.text ?? '',postedAt:old.postedAt,links:(old.links ?? []).map((l:any)=>({url:l.url,title:l.title || new URL(l.url).hostname}))}:null;
          const meta={origin:'x',fictional:false,sourceStatus:source ? 'available':fresh ? row.source_status:'expired',fetchedAt};
          records.push(['x:'+row.id,source ? JSON.stringify(source):null,JSON.stringify({state:'inbox',read:false,laterUntil:null,tags:[],memo:'',genre:null}),JSON.stringify(meta),stamp,row.feed_order]);
        }
        const payload=JSON.stringify(records);
        await query("INSERT OR IGNORE INTO x_feed_order SELECT json_extract(value,'$[0]'),json_extract(value,'$[5]') FROM json_each(?)",[payload]);
        await query("INSERT OR IGNORE INTO items(id,revision,source_json,user_json,metadata_json,updated_at) SELECT json_extract(value,'$[0]'),1,json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?)",[payload]);
        imported+=records.length;
      }
      for(const row of service.db.prepare('SELECT * FROM ledger').all())await query('INSERT OR IGNORE INTO x_budget VALUES (?,?,?,?)',['local:'+row.id,new Date(row.at).toISOString(),row.units,row.kind]);
      const report={at:stamp,imported,localPollingPaused:service.get('paused'),xReads:0};safeWrite('migration-report.json',report);output(report);
    }finally{service.close();}
  }else if(command==='verify-public'){
    const secrets=JSON.parse(fs.readFileSync(path.join(cache,'receiver-secrets.json'),'utf8'));
    const root=deployment.webhookOrigin;
    const crc='margin-deployment-health';
    const response=await fetch(root+'/webhooks/x?crc_token='+crc,{redirect:'error',signal:AbortSignal.timeout(15000)});
    const data:any=await response.json();
    const matches=data.response_token==='sha256='+crypto.createHmac('sha256',secrets.X_OAUTH2_CLIENT_SECRET).update(crc).digest('base64');
    const crcBody=await fetch(root+'/webhooks/x?crc_token='+encodeURIComponent('{"data":{"event_type":"like.create"}}'),{redirect:'error',signal:AbortSignal.timeout(15000)});
    const unsigned=await fetch(root+'/webhooks/x',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error'});
    const readerLeak=await fetch(root+'/v1/items',{redirect:'error'});
    const privateApi=await fetch(deployment.origin+'/api/x/items',{headers:{'X-Margin-Request':'1'},redirect:'manual'});
    const asset=await fetch(deployment.origin+'/',{redirect:'manual'});
    const report={crcValid:response.status===200&&matches,crcBodyRejected:crcBody.status===400,unsignedRejected:unsigned.status===401,receiverReaderAbsent:readerLeak.status===404,privateApiLocked:privateApi.status===401,webLoginRequired:asset.status===302,xReads:0};
    safeWrite('public-verification.json',report);output(report);if(Object.values(report).some(v=>v===false))process.exitCode=1;
  }else if(command==='register'){
    // Creation is journalled before POST. An uncertain result is listed and
    // adopted by exact URL on a later run; never blindly create duplicates.
    const old=await getRuntime<ControlState|null>(db,'control',null);
    if(old?.webhookId){output({registered:true,existing:true});process.exit(0);}
    const e=env();const {XClient}=await import('../apps/api/src/x-runtime');const client=new XClient(e);
    const url=deployment.webhookOrigin+'/webhooks/x';
    let hook:any;
    if(await getRuntime(db,'webhookAttempted',false)){
      const list=await client.request('/2/webhooks');
      const hooks=list.data?.webhooks ?? list.webhooks ?? list.data ?? (list.meta?.result_count===0 ? []:null);
      if(!Array.isArray(hooks))throw new Error('webhook_list');
      const matching=hooks.filter((h:any)=>h.url===url && h.valid===true);
      if(matching.length!==1)throw new Error('reconcile_webhook_attempt');hook=matching[0];
    }else{
      await setRuntime(db,'webhookAttempted',true);
      const response=await client.request('/2/webhooks','POST',{url});hook=response.data?.webhook ?? response.data;
    }
    if(!/^\d{1,19}$/.test(hook?.id) || hook.valid!==true)throw new Error('webhook_unconfirmed');
    const owner:any=await getRuntime(db,'account',null);
    const state:ControlState={enabled:false,ownerId:owner.id,webhookId:hook.id,tag:'margin-cloud-'+crypto.randomBytes(8).toString('hex'),freeStopAt:Date.parse(deployment.creditStopAt)};
    await setRuntime(db,'control',state);output({registered:true,valid:true,subscriptionEnabled:false});
  }else if(command==='start' || command==='stop' || command==='reconcile'){
    const state=await getRuntime<ControlState|null>(db,'control',null);if(!state)throw new Error('missing_control');
    if(command!=='reconcile'){const changed=await withXLock(db,Date.now(),async()=>{const latest=await getRuntime<ControlState|null>(db,'control',null);if(!latest)return false;latest.enabled=command==='start';delete latest.retryAt;await setRuntime(db,'control',latest);return true;});if(!changed)throw new Error('control_busy');}
    const result=await reconcileSubscription(env(),Date.now(),fetch,true);
    output({enabled:result?.enabled,active:!!result?.subscriptionId,reason:result?.reason,expiresAt:result?.expiresAt,lastCheckAt:result?.lastCheckAt,freeBalance:result?.freeBalance});
  }else if(command==='login'){
    throw new Error('legacy_login_disabled_use_owner_passkey');
  }else if(command==='preview-status'){
    const cache=await query('SELECT status,count(*) n,sum(image IS NOT NULL) images FROM link_previews GROUP BY status');
    const daily=await query('SELECT attempts FROM preview_daily_budget WHERE day=?',[new Date().toISOString().slice(0,10)]);
    output({cache:cache.results,dailyAttempts:daily.results[0]?.attempts ?? 0,dailyLimit:60,xReads:0});
  }else if(command==='status'){
    const state=await getRuntime<ControlState|null>(db,'control',null);
    const counts=await query('SELECT count(*) total,count(source_json) available FROM items');
    const events=await query('SELECT count(*) n,max(received_at) last_received FROM x_activity_inbox');
    output({enabled:state?.enabled,reason:state?.reason,failurePhase:state?.failurePhase,failureType:state?.failureType,failureHint:state?.failureHint,expiresAt:state?.expiresAt,lastCheckAt:state?.lastCheckAt,lastRenewedAt:state?.lastRenewedAt,freeBalance:state?.freeBalance,counts:counts.results[0],events:events.results[0],budget:await budget(db,Date.now()),cron:await getRuntime(db,'cronHealth',null)});
  }else throw new Error('unknown_command');
}catch(e:any){output({failed:true,reason:/^[a-z_0-9]+$/.test(e.message) ? e.message:'operation_failed_no_sensitive_details'});process.exitCode=1;}
