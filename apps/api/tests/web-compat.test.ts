import assert from 'node:assert/strict';
import {test} from 'node:test';
import {database} from './runtime-db';
import {hashToken,COOKIE} from '../src/session';
import {webApp} from '../src/web-compat';
import {getRuntime,setRuntime} from '../src/x-runtime';

test('a pause cannot race an active controller; oversized streamed input cannot trigger a lookup',async()=>{
  const {db,sqlite}=database();
  const origin='https://reader.example.test',token='a'.repeat(43);
  sqlite.prepare('INSERT INTO device_sessions VALUES (?,?,0)').run(await hashToken(token),new Date(Date.now()+60000).toISOString());
  await setRuntime(db,'control',{enabled:true});
  const headers={Origin:origin,Cookie:COOKIE+'='+token,'X-Margin-Request':'1','Content-Type':'application/json'};
  const request=(endpoint:string,body:string)=>webApp.request(origin+'/api/x/'+endpoint,{method:'POST',headers,body},{DB:db,X_SYNC_ENABLED:'false'});
  sqlite.prepare('INSERT INTO x_control_lock VALUES (1,?,?)').run('active-controller',Date.now()+60000);
  assert.equal((await request('pause',JSON.stringify({paused:true}))).status,503);
  assert.equal((await getRuntime<any>(db,'control',null)).enabled,true);
  sqlite.prepare('DELETE FROM x_control_lock').run();
  assert.equal((await request('pause',JSON.stringify({paused:true}))).status,200);
  assert.equal((await getRuntime<any>(db,'control',null)).enabled,false);
  assert.equal((await request('post',JSON.stringify({postId:'8000000000000000001',padding:'x'.repeat(300)}))).status,400);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM x_lookup_attempts').get()!.n,0);
});
