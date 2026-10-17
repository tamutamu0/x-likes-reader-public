import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { Bindings } from './types';
import { COOKIE, hashToken, authenticated } from './session';
import { sameOriginWrite } from './security';

const SETUP='__Host-margin-setup', CHALLENGE='__Host-margin-challenge';
const opaque=/^[A-Za-z0-9_-]{43}$/;
const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const encode=(v:Uint8Array)=>btoa(String.fromCharCode(...v));
const decode=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
const cookie=(name:string,value:string,seconds:number)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${seconds}`;
function token(request:Request,name:string) {
  const entries=request.headers.get('Cookie')?.split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
  const v=entries?.length===1 ? entries[0].slice(name.length+1):'';
  return opaque.test(v) ? v:null;
}
async function json(request:Request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return null;
  const reader=request.body?.getReader();if(!reader)return null;
  let n=0;const chunks:Uint8Array[]=[];
  while(true){const p=await reader.read();if(p.done)break;n+=p.value.length;if(n>16384){await reader.cancel();return null;}chunks.push(p.value);}
  const b=new Uint8Array(n);let i=0;for(const c of chunks){b.set(c,i);i+=c.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(b));}catch{return null;}
}
function reply(status:number,value:unknown={ok:false},cookies:string[]=[]) {
  const headers=new Headers({'Content-Type':'application/json','Cache-Control':'no-store'});
  for(const c of cookies)headers.append('Set-Cookie',c);
  return new Response(JSON.stringify(value),{status,headers});
}
type Credential={credential_id:string;public_key:string;counter:number;user_handle:string};
async function setupHash(request:Request,db:D1Database,now:string) {
  const t=token(request,SETUP);if(!t)return null;
  const h=await hashToken(t);
  return await db.prepare("SELECT token_hash FROM device_sessions WHERE token_hash=? AND kind='setup' AND revoked=0 AND expires_at>?").bind(h,now).first() ? h:null;
}
export function authPage(setup=false,security=false,link=false) {
  const action=security?'logout':link?'link':setup?'register':'login';
  const description=security?'この端末、またはすべての端末をログアウトできます。保存済みの投稿やメモは消えません。':link?'本人用リンクからこのブラウザーを接続します。接続は30日間有効です。':setup?'あなた専用のパスキーを登録します。MacのTouch ID、端末のロック解除、またはiPhoneで本人確認してください。':'本人専用のページです。登録したパスキーで開いてください。';
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>margin 本人認証</title><link rel="stylesheet" href="/auth/style.css"><script defer src="/auth/client.js"></script></head><body><main><h1>margin</h1><p id="message">${description}</p><button id="primary" data-action="${action}">${security?'この端末をログアウト':link?'本人のWebを開く':setup?'本人用パスキーを登録':'パスキーで開く'}</button>${security?'<button id="all" data-action="logout-all">すべての端末をログアウト</button><a href="/">戻る</a>':''}</main></body></html>`,{headers:{'Content-Type':'text/html;charset=UTF-8'}});
}
export const AUTH_STYLE='body{margin:0;background:#fff;color:#0f1419;font:16px -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:420px;margin:12vh auto;padding:24px}h1{font-size:30px;letter-spacing:-1px}p{line-height:1.8;color:#536471;min-height:90px}button{display:block;width:100%;border:0;border-radius:24px;background:#0f1419;color:white;padding:14px 18px;font:inherit;font-weight:600;margin:16px 0;cursor:pointer}button:disabled{opacity:.5;cursor:wait}a{color:#1d9bf0}';

// No signup, email identity, passwords, public recovery or additional-key API.
// First enrollment needs a locally issued capability. Link mode instead
// accepts only a separate locally issued, one-use owner login permit.
export async function authAction(request:Request,env:Bindings) {
  if(!env.AUTH_DB || !env.AUTH_ORIGIN || new URL(request.url).origin!==env.AUTH_ORIGIN)return reply(403);
  if(request.method!=='POST' || !sameOriginWrite(request))return reply(403);
  const path=new URL(request.url).pathname,db=env.AUTH_DB,now=new Date().toISOString();
  if(!['/auth/link/exchange','/auth/setup/exchange','/auth/register/options','/auth/register/verify','/auth/login/options','/auth/login/verify','/auth/logout','/auth/logout-all'].includes(path))return reply(404);
  if(path==='/auth/logout' || path==='/auth/logout-all') {
    if(!await authenticated(request,env))return reply(401);
    if(path.endsWith('-all'))await db.prepare("UPDATE device_sessions SET revoked=1 WHERE kind='web'").run();
    else await db.prepare('UPDATE device_sessions SET revoked=1 WHERE token_hash=?').bind(await hashToken(token(request,COOKIE)!)).run();
    return reply(200,{ok:true},[cookie(COOKIE,'',0)]);
  }
  // Edge rate limit limits unauthenticated cryptographic/DB work, without
  // collecting IP addresses in the database or logging them.
  if(!env.AUTH_RATE_LIMITER || !(await env.AUTH_RATE_LIMITER.limit({key:request.headers.get('CF-Connecting-IP') ?? 'unknown'})).success)return reply(429);
  if(env.AUTH_MODE==='link') {
    if(path!=='/auth/link/exchange')return reply(403);
    const input=await json(request);if(typeof input?.token!=='string' || !opaque.test(input.token))return reply(401);
    const session=random(),h=await hashToken(input.token),expires=new Date(Date.now()+30*86400000).toISOString();
    const result=await db.batch([
      db.prepare("INSERT INTO device_sessions SELECT ?,?,0,'web' FROM owner_link_permits WHERE token_hash=? AND consumed=0 AND expires_at>? RETURNING token_hash").bind(await hashToken(session),expires,h,now),
      db.prepare('UPDATE owner_link_permits SET consumed=1 WHERE token_hash=? AND consumed=0 AND expires_at>?').bind(h,now),
      db.prepare('DELETE FROM owner_link_permits WHERE consumed=1 OR expires_at<=?').bind(now),
      db.prepare('DELETE FROM device_sessions WHERE revoked=1 OR expires_at<=?').bind(now),
    ]);
    return result[0].results.length ? reply(200,{ok:true},[cookie(COOKIE,session,30*86400)]):reply(401);
  }
  if(path==='/auth/link/exchange')return reply(403);
  const owner=await db.prepare('SELECT credential_id,public_key,counter,user_handle FROM owner_passkey WHERE slot=1').first<Credential>();
  if(path==='/auth/setup/exchange') {
    if(owner)return reply(403);
    const input=await json(request);if(typeof input?.token!=='string' || !opaque.test(input.token))return reply(401);
    const t=random(),h=await hashToken(input.token);
    const result=await db.batch([
      db.prepare("INSERT INTO device_sessions SELECT ?,?,0,'setup' FROM browser_bootstrap WHERE token_hash=? AND consumed=0 AND expires_at>? RETURNING token_hash").bind(await hashToken(t),new Date(Date.now()+600000).toISOString(),h,now),
      db.prepare('UPDATE browser_bootstrap SET consumed=1 WHERE token_hash=? AND consumed=0 AND expires_at>?').bind(h,now),
    ]);
    return result[0].results.length ? reply(200,{ok:true},[cookie(SETUP,t,600)]):reply(401);
  }
  const register=path.startsWith('/auth/register/');
  const setup=register ? await setupHash(request,db,now):null;
  if(register && (owner || !setup))return reply(403);
  if(!register && !owner)return reply(401);
  const rpID=new URL(env.AUTH_ORIGIN).hostname;
  if(path.endsWith('/options')) {
    await db.batch([
      db.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').bind(now),
      db.prepare('DELETE FROM device_sessions WHERE expires_at<=? OR revoked=1').bind(now),
      db.prepare('DELETE FROM browser_bootstrap WHERE expires_at<=? OR consumed=1').bind(now),
    ]);
    const active=await db.prepare('SELECT count(*) n FROM auth_challenges').first<{n:number}>();
    if(!active || active.n>=200)return reply(429);
    const id=random();
    const options=register ? await generateRegistrationOptions({rpName:'margin',rpID,userName:'本人',userID:crypto.getRandomValues(new Uint8Array(32)),attestationType:'none',supportedAlgorithmIDs:[-7],authenticatorSelection:{residentKey:'required',userVerification:'required'},preferredAuthenticatorType:'localDevice'}) :
      await generateAuthenticationOptions({rpID,userVerification:'required'});
    const userHandle=register ? (options as {user:{id:string}}).user.id:null;
    await db.prepare('INSERT INTO auth_challenges VALUES (?,?,?,?,?,?)').bind(await hashToken(id),options.challenge,register?'register':'login',setup,userHandle,new Date(Date.now()+300000).toISOString()).run();
    return reply(200,options,[cookie(CHALLENGE,id,300)]);
  }
  const id=token(request,CHALLENGE);if(!id)return reply(401);
  // Atomically consume BEFORE verifying: simultaneous replay can never mint
  // two sessions. A failed ceremony needs a fresh challenge.
  const challenge=await db.prepare('DELETE FROM auth_challenges WHERE id=? AND kind=? AND expires_at>? RETURNING *').bind(await hashToken(id),register?'register':'login',now).first<{challenge:string;session_hash:string|null;user_handle:string|null}>();
  if(!challenge || (register && challenge.session_hash!==setup))return reply(401);
  const response=await json(request);if(!response)return reply(400);
  try {
    const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(response.response.clientDataJSON.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));
    if(data.crossOrigin || data.topOrigin)return reply(401);
  } catch {return reply(401);}
  const session=random(),sessionHash=await hashToken(session),expires=new Date(Date.now()+86400000).toISOString();
  try {
    if(register) {
      const result=await verifyRegistrationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:env.AUTH_ORIGIN,expectedRPID:rpID,requireUserVerification:true,supportedAlgorithmIDs:[-7]});
      if(!result.verified || !result.registrationInfo)return reply(401);
      const credential=result.registrationInfo.credential;
      const inserted=await db.batch([
        db.prepare(`INSERT OR IGNORE INTO owner_passkey SELECT 1,?,?,?,?,? FROM device_sessions WHERE token_hash=? AND kind='setup' AND revoked=0 AND expires_at>? RETURNING slot`).bind(credential.id,encode(credential.publicKey),credential.counter,challenge.user_handle,now,setup,now),
        db.prepare("INSERT INTO device_sessions SELECT ?,?,0,'web' WHERE changes()=1").bind(sessionHash,expires),
        db.prepare('DELETE FROM browser_bootstrap WHERE EXISTS(SELECT 1 FROM owner_passkey WHERE credential_id=?)').bind(credential.id),
      ]);
      if(!inserted[0].results.length)return reply(403);
    } else {
      if(response.id!==owner!.credential_id || response.response?.userHandle!==owner!.user_handle)return reply(401);
      const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge.challenge,expectedOrigin:env.AUTH_ORIGIN,expectedRPID:rpID,requireUserVerification:true,credential:{id:owner!.credential_id,publicKey:decode(owner!.public_key),counter:owner!.counter}});
      if(!result.verified)return reply(401);
      const inserted=await db.batch([
        db.prepare('UPDATE owner_passkey SET counter=? WHERE slot=1 AND credential_id=? AND counter=?').bind(result.authenticationInfo.newCounter,owner!.credential_id,owner!.counter),
        db.prepare("INSERT INTO device_sessions SELECT ?,?,0,'web' WHERE changes()=1").bind(sessionHash,expires),
      ]);
      if(!inserted[1].success)return reply(401);
      if(!await db.prepare('SELECT token_hash FROM device_sessions WHERE token_hash=?').bind(sessionHash).first())return reply(401);
    }
  } catch { return reply(401); }
  return reply(200,{ok:true},[cookie(COOKIE,session,86400),cookie(SETUP,'',0),cookie(CHALLENGE,'',0)]);
}
