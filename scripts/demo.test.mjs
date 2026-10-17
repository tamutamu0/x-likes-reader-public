import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemoServer} from './demo.mjs';
test('documentation demo exposes only static UI and empty connection responses',async t=>{
  const server=createDemoServer();await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port;
  assert.equal((await fetch(root)).status,200);
  assert.equal((await fetch(root+'/js/sample.js')).status,200);
  assert.deepEqual(await (await fetch(root+'/api/x/status')).json(),{status:'ok',configured:false,connected:false});
  assert.deepEqual(await (await fetch(root+'/api/x/items')).json(),{status:'ok',revision:0,entries:[]});
  for(const route of ['/api/article','/api/image','/api/shelf/labels','/.env','/data/x/x.sqlite','/server.mjs','/js/../../../.env'])
    assert.equal((await fetch(root+route)).status,404,route);
  assert.equal((await fetch(root+'/api/x/connect',{method:'POST'})).status,405);
  assert.equal((await fetch(root+'/api/x/sync',{method:'POST'})).status,405);
});
