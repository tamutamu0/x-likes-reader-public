import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './runtime-db';
import {authAction} from '../src/auth';
import {authenticated,hashToken,COOKIE} from '../src/session';
import type {Bindings} from '../src/types';
const origin='https://reader.example.test';
const cookie=(r:Response)=>r.headers.getSetCookie().find(s=>s.startsWith(COOKIE+'='))!.split(';')[0];
function setup() {
  const {db,sqlite}=database(true),env:Bindings={AUTH_DB:db,AUTH_MODE:'link',AUTH_ORIGIN:origin,APP_ENV:'production',AUTH_RATE_LIMITER:{async limit(){return {success:true};}}};
  const call=(body:unknown={},headers:Record<string,string>={},path='/auth/link/exchange')=>authAction(new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Margin-Request':'1',...headers},body:JSON.stringify(body)}),env);
  const add=async(t:string,expires=new Date(Date.now()+60000).toISOString())=>sqlite.prepare('INSERT INTO owner_link_permits VALUES (?,?,0)').run(await hashToken(t),expires);
  return {db,sqlite,env,call,add};
}
test('locally issued owner link is atomic and one-use; separate 30-day session needs no passkey',async()=>{
  const s=setup(),t='a'.repeat(43);await s.add(t);
  assert.equal(await authenticated(new Request(origin,{headers:{Cookie:COOKIE+'='+t}}),s.env),false);
  const results=await Promise.all([s.call({token:t}),s.call({token:t})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);
  const r=results.find(r=>r.status===200)!;assert.match(r.headers.get('Set-Cookie')!,/Max-Age=2592000/);assert.match(r.headers.get('Set-Cookie')!,/Secure; HttpOnly; SameSite=Strict/);
  const session=cookie(r),request=new Request(origin,{headers:{Cookie:session}});
  assert.equal(await authenticated(request,s.env),true);
  assert.equal(await authenticated(request,{...s.env,AUTH_MODE:undefined}),false,'link mode must be explicitly configured');
  assert.equal(s.sqlite.prepare('SELECT count(*) n FROM owner_passkey').get()!.n,0);
  assert.equal((await s.call({}, {},'/auth/register/options')).status,403);
  assert.equal((await s.call({}, {},'/auth/login/options')).status,403);
  assert.equal((await s.call({}, {Cookie:session},'/auth/logout-all')).status,200);
  assert.equal(await authenticated(request,s.env),false);
  const fresh='e'.repeat(43);await s.add(fresh);const newSession=cookie(await s.call({token:fresh}));
  s.sqlite.prepare("UPDATE device_sessions SET expires_at='2000-01-01T00:00:00Z'").run();
  assert.equal(await authenticated(new Request(origin,{headers:{Cookie:newSession}}),s.env),false,'expired browser sessions cannot authenticate');
});
test('unknown, expired, enrollment, oversized, cross-site and rate-limited links cannot read or create sessions',async()=>{
  const s=setup(),t='a'.repeat(43);await s.add(t,'2000-01-01T00:00:00Z');
  assert.equal((await s.call({token:t})).status,401);
  assert.equal((await s.call({token:'b'.repeat(43)})).status,401);
  await s.add('c'.repeat(43));
  assert.equal((await s.call({token:'c'.repeat(43)},{Origin:'https://evil.example.test'})).status,403);
  assert.equal((await s.call({token:'c'.repeat(43)},{'X-Margin-Request':''})).status,403);
  assert.equal((await s.call({token:'c'.repeat(43),padding:'x'.repeat(17000)})).status,401);
  s.sqlite.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').run(await hashToken('d'.repeat(43)),new Date(Date.now()+60000).toISOString());
  assert.equal((await s.call({token:'d'.repeat(43)})).status,401);
  s.env.AUTH_RATE_LIMITER={async limit(){return {success:false};}};
  assert.equal((await s.call({token:'c'.repeat(43)})).status,429);
  assert.equal(s.sqlite.prepare('SELECT count(*) n FROM device_sessions').get()!.n,0);
});
