// Fictional credentials only. All requests terminate in the fixture service;
// this exercises workerd's native fetch without contacting X or Cloudflare.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const fixture = `
  import {XClient,sealTokens} from './apps/api/src/x-runtime.ts';
  export default { async fetch() {
    const store = new Map();
    const DB = { prepare(sql) {
      let args = [];
      const query = {
        bind(...values) { args = values; return query; },
        async first() { return store.has(args[0]) ? {value:store.get(args[0])} : null; },
        async run() { store.set(args[0],args[1]); return {success:true}; }
      };
      return query;
    }};
    const key = btoa('k'.repeat(32));
    store.set('tokens',JSON.stringify(await sealTokens({
      access_token:'fictional',refresh_token:'fictional',scope:'like.read',expiresAt:0
    },key)));
    await new XClient({DB,X_VAULT_KEY:key,
      X_OAUTH2_CLIENT_ID:'fictional',X_OAUTH2_CLIENT_SECRET:'fictional'
    }).request('/2/usage/credits');
    return Response.json({ok:true});
  }};
`;
const bundle = await build({
  stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'synthetic.ts'},
  bundle:true,format:'esm',platform:'browser',write:false
});
const paths:string[]=[];
const mf = new Miniflare(convertV4MiniflareOptions({
  compatibilityDate:'2026-10-12',modules:true,script:bundle.outputFiles[0].text,
  host:'127.0.0.1',port:0,
  outboundService:async(request)=>{
    const url=new URL(request.url);assert.equal(url.origin,'https://api.x.com');
    paths.push(url.pathname);
    if(url.pathname==='/2/oauth2/token')return Response.json({
      access_token:'fresh',refresh_token:'fresh',expires_in:7200,scope:'like.read'
    });
    if(url.pathname==='/2/usage/credits')return Response.json({data:{free_balance:20,prepaid_balance:0}});
    throw new Error('external_network_disabled');
  }
}));
try {
  assert.deepEqual(await (await mf.dispatchFetch('http://localhost/')).json(),{ok:true});
  assert.deepEqual(paths,['/2/oauth2/token','/2/usage/credits']);
  console.log('PASS: actual Workers native transport, fictional OAuth refresh and credit lookup; external network disabled');
} finally {await mf.dispose();}
