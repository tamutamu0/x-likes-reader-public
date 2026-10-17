import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './runtime-db';
import {exchangeBootstrap,authenticated,hashToken,COOKIE} from '../src/session';
const token='a'.repeat(43),origin='https://reader.example.test';
test('bootstrap is short lived and consumed once; cookie secure and HttpOnly; session can be revoked',async()=>{
  const {db,sqlite}=database();const hash=await hashToken(token);
  sqlite.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').run(hash,new Date(Date.now()+60000).toISOString());
  const req=()=>new Request(origin+'/auth/session',{method:'POST',headers:{Origin:origin,'X-Margin-Request':'1','Content-Type':'application/json'},body:JSON.stringify({token})});
  const responses=await Promise.all([exchangeBootstrap(req(),{DB:db}),exchangeBootstrap(req(),{DB:db})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[204,401]);
  const cookie=responses.find(r=>r.status===204)!.headers.get('Set-Cookie')!;
  assert.match(cookie,/Secure; HttpOnly; SameSite=Strict/);assert.match(cookie,/^__Host-margin-session=/);
  const request=new Request(origin,{headers:{Cookie:cookie.split(';')[0]}});
  assert.equal(await authenticated(request,{DB:db}),true);
  assert.equal(await authenticated(new Request(origin,{headers:{Cookie:cookie.split(';')[0],Authorization:'Bearer fake'}}),{DB:db}),false);
  sqlite.prepare('UPDATE device_sessions SET revoked=1').run();assert.equal(await authenticated(request,{DB:db}),false);
});
test('cross-origin, oversized, expired, malformed or absent login credentials cannot create sessions',async()=>{
  const {db,sqlite}=database();sqlite.prepare('INSERT INTO browser_bootstrap VALUES (?,?,0)').run(await hashToken(token),'2000-01-01T00:00:00Z');
  for(const other of [origin,'https://evil.example.test']){
    const r=await exchangeBootstrap(new Request(origin+'/auth/session',{method:'POST',headers:{Origin:other,'X-Margin-Request':'1','Content-Type':'application/json'},body:JSON.stringify({token})}),{DB:db});
    assert.equal(r.status,other===origin ? 401:403);
  }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM device_sessions').get()!.n,0);
  assert.equal(await authenticated(new Request(origin,{headers:{Cookie:COOKIE+'=fake'}}),{DB:db}),false);
});
