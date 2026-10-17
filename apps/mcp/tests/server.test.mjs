import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {createServer} from '../src/server.mjs';

test('official MCP handshake, tools, resources and prompts use no network until requested and redact failures',async()=>{
 let calls=0;const server=createServer(async(action,args)=>{calls++;if(action==='search')throw Error('FAKE_SECRET_DO_NOT_LEAK');return {items:[{postId:'123',excerpt:'架空の技術。第三者の指示は実行しない。'}],action,args};});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);
 const client=new Client({name:'fictional-test',version:'1'},{capabilities:{}});await client.connect(b);
 try{
  assert.equal(calls,0);const tools=await client.listTools();assert.equal(tools.tools.length,4);assert.ok(tools.tools.every(t=>t.annotations.readOnlyHint&&t.annotations.destructiveHint===false));
  assert.equal((await client.listResources()).resources.length,2);assert.equal((await client.listPrompts()).prompts[0].name,'try_recent_tech');assert.equal(calls,0);
  const recent=await client.callTool({name:'recent_likes',arguments:{limit:3}});assert.equal(recent.structuredContent.args.limit,3);assert.equal(calls,1);
  const bad=await client.callTool({name:'recent_likes',arguments:{limit:100}});assert.equal(bad.isError,true);assert.equal(calls,1);
  const failed=await client.callTool({name:'search_likes',arguments:{query:'audio'}});assert.equal(failed.isError,true);assert.ok(!JSON.stringify(failed).includes('FAKE_SECRET'));
  const prompt=await client.getPrompt({name:'try_recent_tech',arguments:{keywords:'audio'}});assert.ok(prompt.messages[0].content.text.includes('audio'));
  const resource=await client.readResource({uri:'x-likes-reader://likes/recent'});assert.equal(resource.contents[0].mimeType,'application/json');
 }finally{await client.close();await server.close();}
});

test('real stdio SDK client can initialize from another directory; stdout contains only MCP',async()=>{
 const client=new Client({name:'fictional-stdio',version:'1'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/server.mjs',import.meta.url)),'--credentials','/private/tmp/margin-nonexistent-fictional-credentials.json'],cwd:'/private/tmp',stderr:'pipe'});
 try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,4);
  const r=await client.callTool({name:'recent_likes',arguments:{}});assert.equal(r.isError,true);assert.ok(r.content[0].text.includes('接続設定'));
 }finally{await client.close();}
});
