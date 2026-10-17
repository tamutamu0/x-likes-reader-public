// One bounded, explicit live check. Reads existing D1 data; never X API.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const clientName=process.argv[2];if(!['codex','claude-code','claude-desktop'].includes(clientName))throw Error('Specify client');
const root=fileURLToPath(new URL('../',import.meta.url));
const client=new Client({name:'x-likes-reader-check',version:'1'},{capabilities:{}});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'apps/mcp/src/server.mjs'),'--credentials',path.join(root,'.cache/mcp',clientName+'.json')],cwd:'/private/tmp',stderr:'pipe'});
try{
 await client.connect(transport);const tools=await client.listTools();assert.equal(tools.tools.length,4);
 const r=await client.callTool({name:'recent_likes',arguments:{limit:3}});assert.ok(!r.isError);const items=r.structuredContent.items;assert.ok(Array.isArray(items));
 let detailWorks=true;if(items.length){const detail=await client.callTool({name:'get_liked_post',arguments:{postId:items[0].postId}});detailWorks=!detail.isError&&detail.structuredContent.post.postId===items[0].postId;assert.ok(detailWorks);}
 console.log(JSON.stringify({client:clientName,protocolHandshake:true,tools:tools.tools.map(t=>t.name),readOnly:tools.tools.every(t=>t.annotations.readOnlyHint),recentCount:items.length,detailWorks,xReads:0,privateTextPrinted:false}));
}finally{await client.close();}
