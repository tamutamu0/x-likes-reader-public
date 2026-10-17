import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './runtime-db';
import {authAction} from '../src/auth';
import {authenticated,hashToken,COOKIE} from '../src/session';
import {authenticator,origin} from './passkey-fixture';
import type {Bindings} from '../src/types';
const cookie=(r:Response,name:string)=>r.headers.getSetCookie().find(s=>s.startsWith(name+'='))!.split(';')[0];
function setup() {
  const {db,sqlite}=database(true),env:Bindings={AUTH_DB:db,AUTH_ORIGIN:origin,AUTH_RATE_LIMITER:{async limit(){return {success:true};}}};
  const call=(path:string,body:unknown={},cookies='',headers:Record<string,string>={})=>authAction(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Margin-Request':'1',Cookie:cookies,...headers},body:JSON.stringify(body)}),env);
  return {db,sqlite,env,call};
}
async function enrolled() {
  const state=setup(),t='a'.repeat(43),device=authenticator();
  state.sqlite.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').run(await hashToken(t),new Date(Date.now()+60000).toISOString());
  const exchange=await state.call('/auth/setup/exchange',{token:t});assert.equal(exchange.status,200);
  const permit=cookie(exchange,'__Host-margin-setup');
  assert.equal(await authenticated(new Request(origin,{headers:{Cookie:permit}}),state.env),false,'enrollment permit never reads posts');
  const options=await state.call('/auth/register/options',{},permit);assert.equal(options.status,200);
  const values:any=await options.json(),challenge=cookie(options,'__Host-margin-challenge');
  const registration=await state.call('/auth/register/verify',device.register(values.challenge),permit+'; '+challenge);
  assert.equal(registration.status,200);
  return {...state,device,userHandle:values.user.id,session:cookie(registration,COOKIE)};
}
test('owner enrollment needs local one-use permit; singleton closes registration and retires setup capability',async()=>{
  const state=await enrolled();
  assert.equal(await authenticated(new Request(origin,{headers:{Cookie:state.session}}),state.env),true);
  assert.equal((await state.call('/auth/register/options')).status,403);
  assert.equal((await state.call('/auth/setup/exchange',{token:'a'.repeat(43)})).status,403);
  assert.equal(state.sqlite.prepare('SELECT count(*) n FROM owner_passkey').get()!.n,1);
  assert.equal((await state.call('/auth/register/verify',{})).status,403);
});
test('real signature, exact RP/origin, user verification and registered credential required; replay atomic',async()=>{
  const state=await enrolled();
  for(const variant of ['signature','uv','origin','rp','other-key','user-handle','challenge','valid']) {
    const r=await state.call('/auth/login/options'),o:any=await r.json(),c=cookie(r,'__Host-margin-challenge');
    const device=variant==='other-key'?authenticator():state.device;
    const response=device.login(variant==='challenge'?'wrong':o.challenge,variant==='user-handle'?'wrong':state.userHandle,{tamper:variant==='signature',verified:variant!=='uv',origin:variant==='origin'?'https://evil.example.test':undefined,rp:variant==='rp'?'evil.example.test':undefined});
    const replies=await Promise.all([state.call('/auth/login/verify',response,c),state.call('/auth/login/verify',response,c)]);
    assert.deepEqual(replies.map(r=>r.status).sort(),variant==='valid'?[200,401]:[401,401],variant);
    if(variant==='valid')assert.match(replies.find(r=>r.status===200)!.headers.get('Set-Cookie')!,/Max-Age=86400/);
  }
});
test('foreign origin, missing CSRF header, spoofed Host, oversized body, rate limit and expired challenge fail closed',async()=>{
  const state=await enrolled();
  assert.equal((await state.call('/auth/login/options',{},'',{Origin:'https://evil.example.test'})).status,403);
  assert.equal((await state.call('/auth/login/options',{},'',{'X-Margin-Request':''})).status,403);
  assert.equal((await authAction(new Request('https://evil.example.test/auth/login/options',{method:'POST',headers:{Origin:'https://evil.example.test','X-Margin-Request':'1'}}),state.env)).status,403);
  const r=await state.call('/auth/login/options'),o:any=await r.json(),c=cookie(r,'__Host-margin-challenge');
  state.sqlite.prepare("UPDATE auth_challenges SET expires_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal((await state.call('/auth/login/verify',state.device.login(o.challenge,state.userHandle),c)).status,401);
  state.env.AUTH_RATE_LIMITER={async limit(){return {success:false};}};
  assert.equal((await state.call('/auth/login/options')).status,429);
});
test('oversized verification, foreign registration ceremony and setup replay never enroll an owner',async()=>{
  const state=setup(),t='a'.repeat(43);
  state.sqlite.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').run(await hashToken(t),new Date(Date.now()+60000).toISOString());
  const exchange=await state.call('/auth/setup/exchange',{token:t}),permit=cookie(exchange,'__Host-margin-setup');
  assert.equal((await state.call('/auth/setup/exchange',{token:t})).status,401);
  let options=await state.call('/auth/register/options',{},permit),o:any=await options.json(),c=cookie(options,'__Host-margin-challenge');
  assert.equal((await state.call('/auth/register/verify',{padding:'x'.repeat(17000)},permit+'; '+c)).status,400);
  options=await state.call('/auth/register/options',{},permit);o=await options.json();c=cookie(options,'__Host-margin-challenge');
  const response=authenticator().register(o.challenge);
  const data=JSON.parse(Buffer.from(response.response.clientDataJSON,'base64url').toString());data.crossOrigin=true;
  response.response.clientDataJSON=Buffer.from(JSON.stringify(data)).toString('base64url');
  assert.equal((await state.call('/auth/register/verify',response,permit+'; '+c)).status,401);
  assert.equal(state.sqlite.prepare('SELECT count(*) n FROM owner_passkey').get()!.n,0);
});
test('session expiry, single/all logout, duplicate cookies and legacy Bearer/Access spoof cannot bypass passkey mode',async()=>{
  const state=await enrolled(),request=(cookie:string,headers:Record<string,string>={})=>new Request(origin,{headers:{Cookie:cookie,...headers}});
  assert.equal(await authenticated(request(state.session,{'Cf-Access-Jwt-Assertion':'fake',Authorization:'Bearer '+'b'.repeat(43)}),state.env),false);
  assert.equal(await authenticated(request(state.session+'; '+state.session),state.env),false);
  const session=state.session;
  assert.equal((await state.call('/auth/logout',{},session)).status,200);
  assert.equal(await authenticated(request(session),state.env),false);
  const options=await state.call('/auth/login/options'),o:any=await options.json();
  const r=await state.call('/auth/login/verify',state.device.login(o.challenge,state.userHandle),cookie(options,'__Host-margin-challenge'));
  const fresh=cookie(r,COOKIE);
  assert.equal((await state.call('/auth/logout-all',{},fresh)).status,200);
  assert.equal(await authenticated(request(fresh),state.env),false);
  state.sqlite.prepare("UPDATE device_sessions SET revoked=0, expires_at='2000-01-01T00:00:00Z'").run();
  assert.equal(await authenticated(request(fresh),state.env),false);
});
